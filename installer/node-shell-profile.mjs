import fs from 'node:fs';
import path from 'node:path';

const START = '# >>> veneer-pro Node runtime >>>';
const END = '# <<< veneer-pro Node runtime <<<';

function shellQuote(value) {
  if (/[\r\n]/.test(value)) throw new Error('Node path cannot contain a newline.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nodeShellProfileBlock(nodeBin) {
  const nodeDir = path.dirname(nodeBin);
  return [
    START,
    '# Keep login shells on the same Node major as the supervised services.',
    '# macOS /etc/zprofile runs path_helper before this file and can move Homebrew Node first.',
    `export PATH=${shellQuote(nodeDir)}:"$PATH"`,
    END,
  ].join('\n');
}

export function mergeNodeShellProfile(contents, nodeBin) {
  const block = nodeShellProfileBlock(nodeBin);
  const start = contents.indexOf(START);
  const end = contents.indexOf(END);
  if (start >= 0 && end >= start) {
    return `${contents.slice(0, start)}${block}${contents.slice(end + END.length)}`;
  }
  const prefix = contents.length > 0 && !contents.endsWith('\n') ? `${contents}\n` : contents;
  return `${prefix}${block}\n`;
}

export function provisionNodeShellProfile({ serviceHome, nodeBin, fileSystem = fs }) {
  const target = path.join(serviceHome, '.zprofile');
  let current = '';
  try {
    current = fileSystem.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const next = mergeNodeShellProfile(current, nodeBin);
  if (next === current) return target;
  fileSystem.mkdirSync(serviceHome, { recursive: true });
  fileSystem.writeFileSync(target, next, { mode: 0o644 });
  return target;
}
