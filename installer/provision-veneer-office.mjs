#!/usr/bin/env node
// Install the `veneer-docx` and `veneer-xlsx` helpers for every agent.
//
// The DOCX launcher runs the versioned source in the installed app, where its
// pinned Node dependencies already exist. The XLSX helper and its pinned,
// pure-Python XlsxWriter library are copied together so it never needs pip.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePathEntry } from './provision-veneer-pdf.mjs';

function log(message) {
  console.log(`[veneer-office] ${message}`);
}

function writeExecutable(dest, body) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, { mode: 0o755 });
  fs.renameSync(temp, dest);
  fs.chmodSync(dest, 0o755);
}

function replaceDirectory(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp-${process.pid}`;
  const backup = `${dest}.old-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  fs.cpSync(source, temp, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, backup);
  try {
    fs.renameSync(temp, dest);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(dest) && fs.existsSync(backup)) fs.renameSync(backup, dest);
    throw error;
  }
}

function docxLauncher(sourcePath) {
  const sourceUrl = pathToFileURL(sourcePath).href;
  return `#!/usr/bin/env node
import { main } from ${JSON.stringify(sourceUrl)};
main().catch((error) => {
  process.stderr.write(\`veneer-docx: \${error?.message ?? String(error)}\\n\`);
  process.exitCode = 1;
});
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function xlsxLauncher(sourcePath) {
  return `#!/bin/sh\nexec python3 ${shellQuote(sourcePath)} "$@"\n`;
}

function probe(command) {
  const result = spawnSync(command, ['--help'], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${path.basename(command)} probe failed: ${detail}`);
  }
}

export function provisionVeneerOffice({
  serviceHome = os.homedir(),
  installerDir = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const binDir = path.join(serviceHome, '.local', 'bin');
  const libDir = path.join(serviceHome, '.local', 'lib', 'veneer-office');
  const envFile = path.join(serviceHome, '.config', 'veneer-pro', 'env');
  const docxSource = path.join(installerDir, 'veneer-docx', 'veneer-docx.mjs');
  const xlsxSource = path.join(installerDir, 'veneer-xlsx');
  const installedXlsx = path.join(libDir, 'veneer-xlsx');

  if (!fs.existsSync(docxSource)) throw new Error(`missing DOCX source: ${docxSource}`);
  if (!fs.existsSync(path.join(xlsxSource, 'vendor', 'xlsxwriter-3.2.9-py3-none-any.whl'))) {
    throw new Error(`missing vendored XlsxWriter: ${xlsxSource}`);
  }

  replaceDirectory(xlsxSource, installedXlsx);
  writeExecutable(path.join(binDir, 'veneer-docx'), docxLauncher(docxSource));
  writeExecutable(path.join(binDir, 'veneer-xlsx'), xlsxLauncher(path.join(installedXlsx, 'veneer-xlsx.py')));
  if (ensurePathEntry(envFile, binDir)) log(`added ${binDir} to the runner PATH (${envFile})`);

  probe(path.join(binDir, 'veneer-docx'));
  probe(path.join(binDir, 'veneer-xlsx'));
  log(`installed veneer-docx and veneer-xlsx -> ${binDir}`);
  log('ready');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const serviceHome = process.argv[2] ? path.resolve(process.argv[2]) : os.homedir();
  try {
    provisionVeneerOffice({ serviceHome });
  } catch (error) {
    console.error(`[veneer-office] provisioning failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
