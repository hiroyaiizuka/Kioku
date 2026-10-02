// In-memory stand-in for Obsidian's public DataAdapter (vault-relative paths). Every call is
// logged; failures can be injected per method. Unit-test double only, never native evidence.
export class FakeAdapter {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.folders = new Set();
    for (const path of this.files.keys()) this.addParents(path);
    this.calls = [];
    /** `{ method: (path, data) => void | throws }` hooks run before the operation. */
    this.hooks = {};
  }
  addParents(path) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) this.folders.add(parts.slice(0, index).join('/'));
  }
  hook(method, path, data) { this.calls.push(`${method}:${path}`); this.hooks[method]?.(path, data); }
  writes() { return this.calls.filter((call) => /^(write|append|mkdir|remove|rename)/.test(call)); }
  async exists(path) { this.hook('exists', path); return this.files.has(path) || this.folders.has(path); }
  async read(path) {
    this.hook('read', path);
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    return this.files.get(path);
  }
  requireParent(path) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !this.folders.has(parent)) throw new Error(`ENOENT (no folder): ${parent}`);
  }
  async write(path, data) { this.hook('write', path, data); this.requireParent(path); this.files.set(path, data); }
  async append(path, data) {
    this.hook('append', path, data); this.requireParent(path);
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  /** Like a cautious adapter, refuses to rename over an existing file unless `renameOverwrites`. */
  async rename(from, to) {
    this.hook('rename', `${from}->${to}`); this.requireParent(to);
    if (!this.files.has(from)) throw new Error(`ENOENT: ${from}`);
    if (this.files.has(to) && !this.renameOverwrites) throw new Error('Destination file already exists!');
    this.files.set(to, this.files.get(from)); this.files.delete(from);
  }
  async remove(path) {
    this.hook('remove', path);
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    this.files.delete(path);
  }
  async mkdir(path) { this.hook('mkdir', path); this.folders.add(path); this.addParents(`${path}/x`); }
  async list(path) {
    this.hook('list', path);
    if (!this.folders.has(path)) throw new Error(`ENOENT: ${path}`);
    const direct = (item) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/');
    return { files: [...this.files.keys()].filter(direct).sort(), folders: [...this.folders].filter(direct).sort() };
  }
}
