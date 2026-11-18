/** Runs only with immutable checker snapshots whose fingerprints were verified by the parent. */
export const referencePreload = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalRead = fs.readFileSync;
const originalWrite = fs.writeFileSync;
const originalOpen = fs.openSync;
const originalReaddir = fs.readdirSync;
const originalWriteSync = fs.writeSync;
const originalExec = cp.execFileSync;
const config = JSON.parse(originalRead(process.env.RATCHET_STRAP_REFERENCE_CONFIG, 'utf8'));
const report = originalRead(config.report, 'utf8');
const allowedSources = new Set(config.sources);
const baselinePaths = new Set([config.legacyBaseline, config.scratchBaseline]);
const denied = (kind) => { throw new Error('Unexpected legacy reference ' + kind); };
const lexical = (value) => {
  if (value instanceof URL) return require('node:url').fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return denied('path');
  return path.resolve(value);
};
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
};
const readable = (value) => {
  const file = lexical(value);
  if (baselinePaths.has(file)) return config.scratchBaseline;
  if (contained(config.scratch, file)) return file;
  const canonical = fs.realpathSync(file);
  if (!contained(config.root, canonical) || !allowedSources.has(canonical)) return denied('source read: ' + file);
  return canonical;
};
fs.readFileSync = (file, ...args) => originalRead(readable(file), ...args);
fs.readdirSync = (directory, ...args) => {
  const canonical = fs.realpathSync(lexical(directory));
  if (!contained(config.root, canonical)) return denied('directory read: ' + String(directory));
  return originalReaddir(directory, ...args);
};
fs.writeFileSync = (file, ...args) => {
  if (!config.measurement || !baselinePaths.has(lexical(file))) return denied('write: ' + String(file));
  return originalWrite(config.scratchBaseline, ...args);
};
fs.openSync = (file, flags, ...args) => {
  const writes = typeof flags === 'number'
    ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)
    : !['r', 'rs', 'sr'].includes(flags);
  if (writes) return denied('open for write: ' + String(file));
  return originalOpen(readable(file), flags, ...args);
};
fs.writeSync = (fd, ...args) => fd === 1 || fd === 2 ? originalWriteSync(fd, ...args) : denied('descriptor write');
for (const name of ['appendFileSync', 'truncateSync', 'ftruncateSync', 'rmSync', 'unlinkSync', 'mkdirSync',
  'rmdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'chmodSync', 'fchmodSync',
  'chownSync', 'fchownSync', 'utimesSync', 'futimesSync', 'mkdtempSync', 'createWriteStream', 'writeFile',
  'appendFile', 'truncate', 'ftruncate', 'rm', 'unlink', 'mkdir', 'rmdir', 'rename', 'copyFile', 'cp',
  'link', 'symlink', 'chmod', 'chown', 'utimes', 'mkdtemp']) {
  if (typeof fs[name] === 'function') fs[name] = () => denied('filesystem operation: ' + name);
}
for (const name of ['writeFile', 'appendFile', 'truncate', 'rm', 'unlink', 'mkdir', 'rmdir', 'rename',
  'copyFile', 'cp', 'link', 'symlink', 'chmod', 'chown', 'utimes', 'mkdtemp', 'open']) {
  if (typeof fs.promises[name] === 'function') fs.promises[name] = () => denied('promise filesystem operation: ' + name);
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const legacyCountsArgs = ['eslint', '.', '--format', 'json', '--cache', '--cache-location', './node_modules/.cache/eslint'];
const quickArgs = [path.resolve(config.root, 'node_modules/eslint/bin/eslint.js'), '.', '--config',
  'eslint.config.mjs', '--format', 'json', '--cache', '--cache-location', '.cache/eslint-ratchet'];
cp.spawnSync = (command, args) => {
  if (config.profile !== 'legacy-counts@1' || command !== 'npx' || !same(args, legacyCountsArgs)) return denied('child spawn');
  return { status: config.measurement ? 0 : config.lintExitCode, stdout: report, stderr: '', signal: null, pid: 0 };
};
cp.execFileSync = (command, args, options) => {
  if (config.profile === 'legacy-messages@1') {
    if (command !== 'npx' || !same(args, ['eslint', '-f', 'json', '.'])) return denied('child execution');
    if (!config.measurement && config.lintExitCode !== 0) {
      const error = new Error('Supplied ESLint report contains hard errors');
      error.status = config.lintExitCode;
      error.stdout = report;
      throw error;
    }
    return report;
  }
  if (config.profile !== 'legacy-identities@1') return denied('child execution');
  if (command === process.execPath && same(args, quickArgs)) {
    if (!config.measurement && config.lintExitCode !== 0) {
      const error = new Error('Supplied ESLint report contains hard errors');
      error.status = config.lintExitCode;
      throw error;
    }
    return report;
  }
  const previousPath = path.relative(config.root, config.legacyBaseline);
  if (command === 'git' && same(args, ['show', 'HEAD^:' + previousPath])) {
    if (config.measurement) throw new Error('Measurement reads no predecessor baseline');
    return originalExec(command, args, options);
  }
  return denied('child execution');
};
for (const name of ['exec', 'execSync', 'execFile', 'spawn', 'fork']) cp[name] = () => denied('child execution: ' + name);
syncBuiltinESMExports();
`;
