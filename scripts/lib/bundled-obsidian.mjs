// Read the official macOS bundle in place. Never rename it into an updater archive.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { safePath } from './paths.mjs';
import { sha256 } from './build.mjs';

export function bundledPackageVersion(bytes) {
  if (bytes.length < 16) throw new Error('Invalid bundled asar header.');
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  if (headerSize < 8 || jsonSize > headerSize - 8 || 8 + headerSize > bytes.length) throw new Error('Invalid bundled asar bounds.');
  const entry = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8')).files?.['package.json'];
  if (!entry || entry.link || entry.unpacked || !/^\d+$/u.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error('Invalid bundled package.json entry.');
  }
  const start = 8 + headerSize + Number(entry.offset);
  if (!Number.isSafeInteger(start) || start + entry.size > bytes.length) throw new Error('Invalid bundled package.json bounds.');
  const version = JSON.parse(bytes.subarray(start, start + entry.size).toString('utf8')).version;
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) throw new Error('Invalid bundled Obsidian version.');
  return version;
}

export function readBundledObsidian(executable, run = spawnSync) {
  const contents = dirname(dirname(executable));
  const bundle = dirname(contents);
  if (basename(executable) !== 'Obsidian' || basename(dirname(executable)) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) {
    throw new Error('Expected an Obsidian.app bundle executable.');
  }
  safePath('/', executable, 'file');
  const source = join(contents, 'Resources', 'obsidian.asar');
  const plist = join(contents, 'Info.plist');
  safePath('/', source, 'file'); safePath('/', plist, 'file');
  const requirement = '=anchor apple generic and identifier "md.obsidian" and certificate leaf[subject.OU] = "6JSW4SJWN9"';
  const signed = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, bundle], { encoding: 'utf8' });
  if (signed.error || signed.status !== 0) throw new Error('Official Obsidian bundle signature verification failed.');
  const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Cannot read the signed Obsidian Info.plist.');
  const info = JSON.parse(result.stdout);
  const bytes = readFileSync(source);
  const version = bundledPackageVersion(bytes);
  if (info.CFBundleIdentifier !== 'md.obsidian' || info.CFBundleExecutable !== 'Obsidian' || info.CFBundleShortVersionString !== version) {
    throw new Error('Bundled Obsidian identity/version mismatch.');
  }
  return { bundled: true, name: null, source, bytes, version, sha256: sha256(bytes) };
}
