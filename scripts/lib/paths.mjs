import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function projectRoot() {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  if (realpathSync(process.cwd()) !== root) throw new Error('Run from the Kioku project root.');
  return root;
}

/** Reject links at every existing component; optional means only missing components are allowed. */
export function safePath(root, target, kind, optional = false) {
  const rel = relative(root, resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path must be contained in the project: ${target}`);
  }
  let current = root;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    const expected = index === parts.length - 1 ? kind : 'directory';
    if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Expected regular ${expected}: ${current}`);
    }
    if (expected === 'file' && stat.nlink !== 1) throw new Error(`Refusing hard link: ${current}`);
  }
  return true;
}

export function safeRead(root, target) {
  safePath(root, target, 'file');
  return readFileSync(target);
}

export function ensureDirectory(root, target) {
  safePath(root, target, 'directory', true);
  mkdirSync(target, { recursive: true });
  safePath(root, target, 'directory');
}

export function atomicWrite(root, target, contents) {
  safePath(root, dirname(target), 'directory');
  safePath(root, target, 'file', true);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let pending = false;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    pending = true;
    safePath(root, target, 'file', true);
    renameSync(temporary, target);
    pending = false;
  } finally {
    if (pending) unlinkSync(temporary);
  }
}

export function isCLI(url) {
  return Boolean(process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href);
}

export function runCLI(action) {
  try { action(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
