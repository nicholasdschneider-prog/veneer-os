// The macOS backend: one native Chrome process per profile working copy, headless
// by default, DevTools bound to loopback. There is no container and no Xvfb, so
// the isolation that matters is the per-profile user-data-dir plus the store's
// 0700 directories.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { cleanClose, freeLoopbackPort, ID, sleep, waitForCdp } from './common.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];

export function resolveChromeBinary(configured) {
  const candidates = configured ? [configured] : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw new Error('No Chrome binary was found for the native browser backend. Set VENEER_BROWSER_CHROME_BIN.');
}

// Chrome's managed-policy file is the container's way of forcing downloads into
// the profile's own directory; on a shared Mac there is no policy to spend, so
// the profile's own preferences carry it. The merge keeps everything else Chrome
// has written, and a corrupt file is replaced rather than inherited.
export function seedDownloadPreferences(chromeDir, downloadsDir) {
  const file = path.join(chromeDir, 'Default', 'Preferences');
  let prefs = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed;
  } catch { /* Missing or unreadable: start from an empty preferences file. */ }
  const download = prefs.download && typeof prefs.download === 'object' && !Array.isArray(prefs.download)
    ? prefs.download
    : {};
  prefs.download = {
    ...download,
    default_directory: downloadsDir,
    prompt_for_download: false,
  };
  prefs.savefile = {
    ...(prefs.savefile && typeof prefs.savefile === 'object' && !Array.isArray(prefs.savefile) ? prefs.savefile : {}),
    default_directory: downloadsDir,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
  return prefs;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Pids are reused across a manager restart, so a recorded pid is only ours when
// the live process is still a Chrome pointed at that profile's directory.
function commandLine(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

export function createNativeBackend({ store, chromeBin, headless = true, windowSize = '1440,1000' }) {
  const stateFile = path.join(store, 'runtime', 'native-processes.json');
  const children = new Map();
  const pendingLabels = new Map();
  let chromePath = '';

  function currentImageId() {
    const binary = chromePath || resolveChromeBinary(chromeBin);
    try { return `${binary}:${Math.round(fs.statSync(binary).mtimeMs)}`; }
    catch { return binary; }
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.processes && typeof parsed.processes === 'object') return parsed.processes;
    } catch {}
    return {};
  }

  function writeState(processes) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, processes })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  }

  function entryFor(name) {
    const entry = readState()[name];
    return entry && alive(entry.pid) ? entry : null;
  }

  function record(name, entry) {
    const processes = readState();
    processes[name] = entry;
    writeState(processes);
  }

  function forget(name) {
    const processes = readState();
    if (!(name in processes)) return;
    delete processes[name];
    writeState(processes);
    children.delete(name);
  }

  async function killProcess(name, entry) {
    if (alive(entry.pid)) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && alive(entry.pid)) await sleep(100);
      if (alive(entry.pid)) {
        try { process.kill(entry.pid, 'SIGKILL'); } catch {}
        // SIGKILL is immediate for the process; the reap below only waits for the
        // kernel to drop it so a later status call cannot see a zombie as live.
        const hard = Date.now() + 2000;
        while (Date.now() < hard && alive(entry.pid)) await sleep(50);
      }
    }
    forget(name);
  }

  function chromeArgs(s, port) {
    return [
      `--user-data-dir=${s.chromeDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      // No --remote-allow-origins: Chrome rejects a DevTools upgrade that
      // carries any browser Origin header, which is what keeps a page in the
      // operator's own browser from reaching this loopback port. The relay and
      // the clean-close client dial it from Node with no Origin at all.
      ...(headless ? ['--headless=new'] : []),
      `--window-size=${windowSize}`,
      '--password-store=basic',
      '--use-mock-keychain',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-mode',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-features=Translate',
      // Defense in depth, not the boundary: the legacy sandboxed FileSystem API
      // is switched off (verified as a real switch in this Chrome's framework
      // binary). The boundary is the relay refusing file:/chrome: navigations.
      '--disable-file-system',
      '--restore-last-session',
      'about:blank',
    ];
  }

  return {
    kind: 'native',

    // Each launch claims a fresh loopback port and the ticket resolves the port
    // from the live process, so nothing here hands a stale ticket a stranger.
    recyclesPorts: false,

    verifyBoot() {
      chromePath = resolveChromeBinary(chromeBin);
    },

    // Chrome outlives the manager on purpose (a restart must not kill live
    // sessions), so boot only drops records that no longer describe one of ours,
    // and kills survivors whose profile directory has gone.
    async restore() {
      const processes = readState();
      let changed = false;
      for (const [name, entry] of Object.entries(processes)) {
        const ours = alive(entry?.pid) && commandLine(entry.pid).includes(`--user-data-dir=${entry.chromeDir}`);
        if (!ours) {
          if (alive(entry?.pid)) console.log(`[veneer-browser] ignoring pid ${entry.pid}: it is not this profile's Chrome`);
          delete processes[name];
          changed = true;
          continue;
        }
        if (!fs.existsSync(entry.chromeDir)) {
          console.log(`[veneer-browser] killing orphaned browser ${name}: its profile is gone`);
          try { process.kill(entry.pid, 'SIGKILL'); } catch {}
          delete processes[name];
          changed = true;
        }
      }
      if (changed) writeState(processes);
    },

    runtimeId(s) {
      return s.container;
    },

    async status(s) {
      const entry = entryFor(s.container);
      if (!entry) return { exists: false, running: false, paused: false, status: 'stopped' };
      return { exists: true, running: true, paused: false, status: 'running' };
    },

    // The downloads directory as the browser itself sees it. The relay refuses a
    // setDownloadBehavior that points anywhere else.
    downloadsPath(s) {
      return s.downloadsDir;
    },

    async cdpPort(s) {
      const entry = entryFor(s.container);
      if (!entry) throw new Error('Browser control port is unavailable.');
      return entry.port;
    },

    // Nothing to pre-create: the profile bytes have to be in place before Chrome
    // opens them, so the labels are simply held until the launch records them.
    async prepare(s, labels = []) {
      const parsed = {};
      for (const label of labels) {
        const split = label.indexOf('=');
        if (split > 0) parsed[label.slice(0, split)] = label.slice(split + 1);
      }
      pendingLabels.set(s.container, parsed);
    },

    async start(s) {
      const existing = entryFor(s.container);
      if (existing) return existing.port;
      forget(s.container);
      const labels = pendingLabels.get(s.container) ?? {};
      pendingLabels.delete(s.container);
      seedDownloadPreferences(s.chromeDir, s.downloadsDir);
      const port = await freeLoopbackPort();
      const binary = chromePath || resolveChromeBinary(chromeBin);
      const child = spawn(binary, chromeArgs(s, port), {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' },
      });
      child.unref();
      if (!child.pid) throw new Error('The browser process could not be started.');
      children.set(s.container, child);
      record(s.container, {
        pid: child.pid,
        port,
        key: s.key,
        clientId: s.clientId,
        projectId: s.projectId,
        profileId: s.profileId,
        chromeDir: s.chromeDir,
        startedAt: new Date().toISOString(),
        runtimeId: currentImageId(),
        labels,
      });
      try {
        await waitForCdp(port);
      } catch (error) {
        await killProcess(s.container, { pid: child.pid });
        throw error;
      }
      return port;
    },

    async stop(s) {
      const entry = readState()[s.container];
      if (!entry) return;
      // Chrome exits on its own after Browser.close; when that never landed there
      // is nothing to wait for and the signals below do the work.
      if (alive(entry.pid) && await cleanClose(entry.port)) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(entry.pid)) await sleep(100);
      }
      await killProcess(s.container, entry);
    },

    async remove(runtimeId) {
      const entry = readState()[runtimeId];
      if (!entry) return;
      await killProcess(runtimeId, entry);
    },

    // A native Chrome has no pause; a copy taken from a running profile is as
    // fresh as Chrome's last flush either way.
    async pause() {},
    async unpause() {},

    // The store belongs to the account the manager runs as, so the copied files
    // are already owned by the user Chrome runs as.
    prepareDir() {},

    async sessionCount(warmNames) {
      return Object.entries(readState())
        .filter(([name, entry]) => alive(entry.pid) && !warmNames.has(name))
        .length;
    },

    async listWarm() {
      return Object.entries(readState())
        .filter(([, entry]) => entry?.labels?.['veneer.warm'] === '1')
        .map(([name, entry]) => {
          const labels = entry.labels;
          const ids = [labels['veneer.client'], labels['veneer.project'], labels['veneer.clone'], labels['veneer.src']];
          const generation = Number(labels['veneer.gen']);
          return {
            name,
            running: alive(entry.pid),
            clientId: labels['veneer.client'],
            projectId: labels['veneer.project'],
            cloneProfileId: labels['veneer.clone'],
            sourceProfileId: labels['veneer.src'],
            generation,
            valid: ids.every((id) => ID.test(id || '')) && Number.isInteger(generation) && generation >= 1,
          };
        });
    },

    // The container image's stand-in: a warm copy booted by an older Chrome is
    // discarded the same way a stale image was.
    async imageId() {
      return currentImageId();
    },

    async instanceImageId(s) {
      return readState()[s.container]?.runtimeId ?? '';
    },
  };
}
