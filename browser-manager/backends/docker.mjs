// The Linux backend: one hardened container per profile working copy, with
// Chrome behind Xvfb inside it (runtime/Dockerfile). This is the code the
// manager ran before the native backend existed; it is moved, not rewritten.
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanClose, ID, sleep, waitForCdp } from './common.mjs';

const exec = promisify(execFile);

export function createDockerBackend({ image, seccomp, chromeUid, chromeGid }) {
  async function docker(args, timeout = 30_000) {
    try {
      const result = await exec('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      const detail = String(error.stderr || '').trim().split('\n').at(-1);
      throw new Error(detail || 'Browser runtime command failed.');
    }
  }

  async function status(s) {
    try {
      const raw = await docker(['inspect', '--format', '{{json .State}}', s.container]);
      const state = JSON.parse(raw);
      return {
        exists: true,
        running: state.Running === true,
        paused: state.Paused === true,
        status: String(state.Status || 'unknown'),
      };
    } catch {
      return { exists: false, running: false, paused: false, status: 'stopped' };
    }
  }

  async function cdpPort(s) {
    const output = await docker(['port', s.container, '9222/tcp']);
    const match = /127\.0\.0\.1:(\d+)/.exec(output);
    if (!match) throw new Error('Browser control port is unavailable.');
    return Number(match[1]);
  }

  function containerCreateArgs(s, labels = []) {
    return ['create',
      '--name', s.container,
      '--label', 'veneer.browser=1',
      '--label', `veneer.profile=${s.key}`,
      ...labels.flatMap((label) => ['--label', label]),
      '--memory', '2g',
      '--cpus', '2',
      '--pids-limit', '512',
      '--security-opt', `seccomp=${seccomp}`,
      '--shm-size', '256m',
      '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '--tmpfs', '/run:rw,nosuid,nodev,size=16m,mode=0755',
      '-v', `${s.chromeDir}:/profile:rw`,
      '-v', `${s.downloadsDir}:/downloads:rw`,
      '-p', '127.0.0.1::9222',
      image,
    ];
  }

  return {
    kind: 'docker',

    // Docker recycles the same 127.0.0.1 port for the next container, so a ticket
    // must never outlive the container it was minted for.
    recyclesPorts: true,

    verifyBoot() {
      if (!fs.statSync(seccomp).isFile()) throw new Error('Chrome seccomp profile is missing.');
    },

    async restore() { /* Container state lives in the daemon; nothing to reap. */ },

    runtimeId(s) {
      return s.container;
    },

    // The container mounts this copy's downloads directory here, so this is the
    // only path Chrome may be told to download into.
    downloadsPath() {
      return '/downloads';
    },

    status,
    cdpPort,

    // execFile spawns docker before the caller's synchronous profile copy blocks
    // the thread, so the container is created while the bytes are still moving.
    prepare(s, labels = []) {
      return docker(containerCreateArgs(s, labels), 60_000);
    },

    // Everything after docker create must leave no container behind.
    async start(s) {
      try {
        await docker(['start', s.container], 60_000);
        const port = await cdpPort(s);
        await waitForCdp(port);
        return port;
      } catch (error) {
        await docker(['rm', '-f', s.container]).catch(() => {});
        throw error;
      }
    },

    async stop(s) {
      const state = await status(s);
      if (!state.exists) return;
      if (state.running) {
        if (state.paused) await docker(['unpause', s.container]);
        await cleanClose(await cdpPort(s));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && (await status(s)).running) await sleep(200);
        if ((await status(s)).running) await docker(['stop', '--time', '10', s.container]);
      }
      await docker(['rm', s.container]).catch(() => {});
    },

    async remove(runtimeId) {
      await docker(['rm', '-f', runtimeId]).catch(() => {});
    },

    async pause(s) {
      await docker(['pause', s.container]);
    },

    async unpause(s) {
      await docker(['unpause', s.container]);
    },

    // The service runs as root, so cpSync recreates copied profile files root-owned
    // with Chrome's 0700/0600 modes; the container's chrome user must own the whole
    // tree or Chrome treats the profile as empty. Non-root (dev/tests) can only
    // chown to its own ids, so skip unless chromeUid is overridden to match.
    prepareDir(directory) {
      if (typeof process.getuid === 'function' && process.getuid() !== 0 && process.getuid() !== chromeUid) return;
      // One native pass; a per-file Node walk costs seconds on a profile of this size.
      execFileSync('chown', ['-hR', `${chromeUid}:${chromeGid}`, directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    },

    // Warm containers are not sessions until they are adopted, so they never
    // consume a slot; adoption pops the registry entry, which makes the copy count.
    async sessionCount(warmNames) {
      const output = await docker(['ps', '--filter', 'label=veneer.browser=1', '--format', '{{.Names}}']);
      return output ? output.split('\n').filter((name) => name && !warmNames.has(name)).length : 0;
    },

    // Warm containers carry their whole identity in labels so a restart can rebuild
    // the registry, and a crash leaves enough to find the orphan's directories.
    async listWarm() {
      const format = '{{.Names}}\t{{.State}}\t{{.Label "veneer.client"}}\t{{.Label "veneer.project"}}\t{{.Label "veneer.clone"}}\t{{.Label "veneer.src"}}\t{{.Label "veneer.gen"}}';
      const output = await docker(['ps', '-a', '--filter', 'label=veneer.warm=1', '--format', format]);
      if (!output) return [];
      return output.split('\n').filter(Boolean).map((line) => {
        const [name, state, clientId, projectId, cloneProfileId, sourceProfileId, generation] = line.split('\t');
        const ids = [clientId, projectId, cloneProfileId, sourceProfileId];
        return {
          name,
          running: state === 'running',
          clientId,
          projectId,
          cloneProfileId,
          sourceProfileId,
          generation: Number(generation),
          valid: Boolean(name) && ids.every((id) => ID.test(id || '')) && Number.isInteger(Number(generation)) && Number(generation) >= 1,
        };
      });
    },

    // A warm copy built on an older runtime image is thrown away rather than
    // adopted, so both sides of that comparison come from docker.
    async imageId() {
      try { return await docker(['image', 'inspect', '--format', '{{.Id}}', image]); }
      catch { return ''; }
    },

    async instanceImageId(s) {
      try { return await docker(['inspect', '--format', '{{.Image}}', s.container]); }
      catch { return ''; }
    },
  };
}
