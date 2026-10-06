// Minimal public-API stand-ins for bundling the real plugin source in jsdom.
// This is a unit-test double only; it is never evidence of native Obsidian behaviour.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { join } from 'node:path';

/** Scope dispatch precedes element capture, as in native Obsidian's keymap. */
export class MockScope {
  constructor(parent) { this.parent = parent; this.handlers = []; }
  register(modifiers, key, func) { const handler = { modifiers, key, func }; this.handlers.push(handler); return handler; }
  unregister(handler) { this.handlers = this.handlers.filter(item => item !== handler); }
  handleKey(event) {
    for (const handler of this.handlers) {
      if (handler.key !== event.key || (handler.modifiers?.length === 0 && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey))) continue;
      return handler.func(event);
    }
    return this.parent?.handleKey(event);
  }
}

export class MockModal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.modalEl = document.createElement('section');
    this.contentEl = document.createElement('div');
    this.modalEl.append(this.contentEl);
    this.containerEl.append(this.modalEl);
    this.scope = new MockScope();
    this.scope.register([], 'Escape', () => { this.close(); return false; });
    this.scopeListener = (event) => {
      if (!this.containerEl.contains(event.target)) return;
      if (this.scope.handleKey(event) === false) { event.preventDefault(); event.stopPropagation(); }
    };
  }
  setTitle(text) {
    this.titleEl ??= this.modalEl.insertBefore(document.createElement('h2'), this.modalEl.firstChild);
    this.titleEl.textContent = text;
  }
  open() { if (!this.containerEl.isConnected) { document.body.append(this.containerEl); document.addEventListener('keydown', this.scopeListener, true); this.onOpen(); } }
  close() { if (this.containerEl.isConnected) { this.onClose(); document.removeEventListener('keydown', this.scopeListener, true); this.containerEl.remove(); } }
}

/** Public Component lifecycle; every instance is kept so tests can check that all were unloaded. */
export class MockComponent {
  static instances = [];
  constructor() { this.loaded = false; this.unloaded = false; MockComponent.instances.push(this); }
  load() { this.loaded = true; }
  unload() { this.unloaded = true; }
}
/** Records what would be rendered as Markdown; the text itself is shown as-is. */
export const renders = [];
export const MockMarkdownRenderer = {
  render(_app, markdown, el, sourcePath, component) {
    renders.push({ markdown, sourcePath, component });
    el.textContent = markdown;
    return Promise.resolve();
  },
};
export function parseFrontMatterTags(frontmatter) {
  const tags = frontmatter?.tags;
  if (tags === undefined || tags === null) return null;
  return (Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/)).filter(Boolean).map((tag) => `#${String(tag).replace(/^#/, '')}`);
}

/** DOM-backed Setting / components: inputs fire onChange on 'input' / 'change'. */
class MockSetting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(name) { this.nameEl.textContent = name; return this; }
  setDesc(desc) { this.descEl.textContent = desc; return this; }
  setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
  addText(build) {
    const inputEl = this.controlEl.createEl('input', { cls: 'mock-text' });
    const text = { inputEl,
      setValue(value) { inputEl.value = value; return text; }, setPlaceholder(value) { inputEl.placeholder = value; return text; },
      setDisabled(value) { inputEl.disabled = value; return text; },
      onChange(fn) { inputEl.addEventListener('input', () => fn(inputEl.value)); return text; } };
    build(text); return this;
  }
  addToggle(build) {
    const inputEl = this.controlEl.createEl('input', { cls: 'mock-toggle' }); inputEl.type = 'checkbox';
    const toggle = { setValue(value) { inputEl.checked = value; return toggle; }, setTooltip() { return toggle; },
      onChange(fn) { inputEl.addEventListener('change', () => fn(inputEl.checked)); return toggle; } };
    build(toggle); return this;
  }
  addDropdown(build) {
    const selectEl = this.controlEl.createEl('select', { cls: 'mock-dropdown' });
    const dropdown = { addOption(value, label) { const option = selectEl.createEl('option', { text: label }); option.value = value; return dropdown; },
      setValue(value) { selectEl.value = value; return dropdown; },
      onChange(fn) { selectEl.addEventListener('change', () => fn(selectEl.value)); return dropdown; } };
    build(dropdown); return this;
  }
  addButton(build) {
    const buttonEl = this.controlEl.createEl('button', { cls: 'mock-button' });
    const button = { setButtonText(value) { buttonEl.textContent = value; return button; },
      onClick(fn) { buttonEl.addEventListener('click', fn); return button; } };
    build(button); return this;
  }
}
class MockPluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); }
  hide() { this.containerEl.replaceChildren(); }
}
export class MockMarkdownView {
  constructor(file, editor, mode = 'source') { this.file = file; this.editor = editor; this.mode = mode; this.saves = 0; this.onSave = null; }
  getMode() { return this.mode; }
  /** Public TextFileView.save(): flushes the editor buffer to the file (wired by createApp). */
  async save() { this.saves += 1; this.onSave?.(this.editor.getValue()); }
}
export class MockTFile {
  constructor(path) { this.path = path; this.basename = path.replace(/^.*\//, '').replace(/\.md$/, ''); this.extension = 'md'; }
}

/** Line/ch editor over a string with an undo stack; one transaction = one undo step. */
export class FakeEditor {
  constructor(text) { this.text = text; this.undoStack = []; this.redoStack = []; this.transactions = []; this.selection = [0, 0]; }
  getValue() { return this.text; }
  posToOffset({ line, ch }) {
    const lines = this.text.split('\n'); let offset = 0;
    for (let index = 0; index < line; index += 1) offset += lines[index].length + 1;
    return offset + ch;
  }
  offsetToPos(offset) {
    const before = this.text.slice(0, offset).split('\n');
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
  getCursor(which = 'head') { return this.offsetToPos(which === 'to' ? this.selection[1] : this.selection[0]); }
  transaction(spec) {
    this.transactions.push(spec); this.undoStack.push(this.text); this.redoStack = [];
    for (const change of spec.changes) {
      const from = this.posToOffset(change.from); const to = this.posToOffset(change.to ?? change.from);
      this.text = this.text.slice(0, from) + change.text + this.text.slice(to);
    }
  }
  undo() { this.redoStack.push(this.text); this.text = this.undoStack.pop(); }
  redo() { this.undoStack.push(this.text); this.text = this.redoStack.pop(); }
}

export function installDom() {
  const dom = new JSDOM('<!doctype html><body></body>');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const proto = dom.window.HTMLElement.prototype;
  proto.empty = function empty() { this.replaceChildren(); };
  proto.addClass = function addClass(name) { this.classList.add(name); };
  proto.setText = function setText(text) { this.textContent = text; };
  proto.createEl = function createEl(tag, options = {}) {
    const node = document.createElement(tag); if (options.text) node.textContent = options.text;
    if (options.cls) node.className = options.cls; this.append(node); return node;
  };
  proto.createDiv = function createDiv(options = {}) { return this.createEl('div', options); };
  proto.createSpan = function createSpan(options = {}) { return this.createEl('span', options); };
  return dom;
}

/**
 * Every `requestUrl` call the plugin makes, in order. By default a call fails like an unreachable
 * server; tests that exercise AI set `network.respond` (request param → response or thrown error).
 */
export const network = { calls: [], respond: null };

export async function compilePlugin(source, notices) {
  network.calls.length = 0;
  network.respond = null;
  const requestUrl = async (param) => {
    network.calls.push(param);
    if (!network.respond) throw new Error('net::ERR_CONNECTION_REFUSED');
    const answer = await network.respond(param);
    return { status: answer.status, headers: answer.headers ?? {}, text: answer.text ?? '', json: undefined, arrayBuffer: new ArrayBuffer(0) };
  };
  const result = await build({ stdin: { contents: source, resolveDir: join(process.cwd(), 'src'), sourcefile: 'main.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'cjs',
    external: ['obsidian'], define: { __KIOKU_VERSION__: '"0.0.1"', __KIOKU_BUILD_ID__: '"unit-build"' } });
  class MockNotice { constructor(message) { notices.push(message); } }
  class MockPlugin {
    constructor(app) { this.app = app; this.ribbons = []; this.commands = []; this.events = []; this.settingTabs = []; this.data = null; this.saved = []; this.loadDataCalls = 0; }
    async loadData() { this.loadDataCalls += 1; return this.data; }
    async saveData(data) { this.saved.push(data); this.data = JSON.parse(JSON.stringify(data)); }
    addSettingTab(tab) { this.settingTabs.push(tab); }
    addRibbonIcon(_icon, title, callback) {
      const item = document.createElement('button'); item.setAttribute('aria-label', title); item.addEventListener('click', callback);
      document.body.append(item); this.ribbons.push(item); return item;
    }
    addCommand(command) { this.commands.push(command); return command; }
    registerEvent(ref) { this.events.push(ref); }
  }
  const obsidian = { Plugin: MockPlugin, Modal: MockModal, Scope: MockScope, MarkdownView: MockMarkdownView, Notice: MockNotice, TFile: MockTFile,
    Component: MockComponent, MarkdownRenderer: MockMarkdownRenderer, parseFrontMatterTags, PluginSettingTab: MockPluginSettingTab,
    Setting: MockSetting, requestUrl };
  const module = { exports: {} };
  // Timers resolve globalThis at call time so vitest fake timers control the plugin's window timers.
  const timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (id) => globalThis.clearInterval(id) };
  const context = { module, exports: module.exports, crypto: globalThis.crypto, window: timers, AbortController: globalThis.AbortController, URL: globalThis.URL,
    TextEncoder: globalThis.TextEncoder, require: (id) => { if (id === 'obsidian') return obsidian; throw new Error(id); }, console };
  // The plugin's Date is the test's Date at call time, so vitest fake time controls Kioku days.
  Object.defineProperty(context, 'Date', { get: () => globalThis.Date });
  vm.runInNewContext(result.outputFiles[0].text, context);
  return module.exports.default;
}

/** A minimal metadata cache like Obsidian's: frontmatter tags, body tags with lines, block IDs. */
export function cacheFor(text) {
  const lines = text.split(/\r?\n/);
  const cache = { tags: [], blocks: {} };
  let start = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      start = close + 1;
      const match = lines.slice(1, close).join('\n').match(/^tags:\s*\[?([^\]\n]*)\]?/m);
      cache.frontmatter = { tags: match ? match[1].split(/[,\s]+/).filter(Boolean) : undefined };
    }
  }
  lines.forEach((line, index) => {
    if (index < start) return;
    for (const match of line.matchAll(/(?:^|\s)(#[^\s#]+)/g)) cache.tags.push({ tag: match[1], position: { start: { line: index } } });
    const block = line.match(/\s\^([A-Za-z0-9-]+)\s*$/);
    if (block) cache.blocks[block[1].toLowerCase()] = { id: block[1] };
  });
  return cache;
}

/** An app whose note I/O is observable: views hold editors, closed files live in `files`. */
export function createApp({ files = {}, views = [], active = null, canvases = [], adapter = null } = {}) {
  const calls = [];
  const modifyListeners = new Set();
  /** Writes a file the way another view or Obsidian would, firing the public `modify` event. */
  const modify = (path, text) => { files[path] = text; for (const listener of [...modifyListeners]) listener({ path }); };
  for (const view of views) view.onSave = (text) => { calls.push(`save:${view.file.path}`); modify(view.file.path, text); };
  const app = {
    calls, files, modify, modifyListeners,
    workspace: {
      getActiveViewOfType(type) { calls.push('workspace.getActiveViewOfType'); return active instanceof type ? active : null; },
      getLeavesOfType(type) {
        calls.push(`workspace.getLeavesOfType:${type}`);
        if (type === 'markdown') return views.map((view) => ({ view }));
        return type === 'canvas' ? canvases.map((file) => ({ view: { file } })) : [];
      },
      on(name, callback) { return { name, callback }; },
      async openLinkText(link, source, newLeaf) { calls.push(`workspace.openLinkText:${link}|${source}|${newLeaf}`); },
    },
    metadataCache: {
      getFileCache(file) { calls.push(`metadataCache.getFileCache:${file.path}`); return typeof files[file.path] === 'string' ? cacheFor(files[file.path]) : null; },
    },
    vault: {
      adapter,
      getMarkdownFiles() { calls.push('vault.getMarkdownFiles'); return Object.keys(files).filter((path) => path.endsWith('.md')).map((path) => new MockTFile(path)); },
      async read(file) { calls.push(`vault.read:${file.path}`); return files[file.path]; },
      async cachedRead(file) { calls.push(`vault.cachedRead:${file.path}`); return files[file.path]; },
      async process(file, fn) {
        calls.push(`vault.process:${file.path}`);
        const before = files[file.path]; const after = fn(before);
        if (after !== before) modify(file.path, after);
        return files[file.path];
      },
      on(name, callback) { if (name === 'modify') modifyListeners.add(callback); return { name, callback }; },
      offref(ref) { modifyListeners.delete(ref.callback); },
    },
  };
  return app;
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
