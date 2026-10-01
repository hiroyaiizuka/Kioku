// Minimal public-API stand-ins for bundling the real plugin source in jsdom.
// This is a unit-test double only; it is never evidence of native Obsidian behaviour.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { join } from 'node:path';

export class MockModal {
  constructor(app) {
    this.app = app;
    this.modalEl = document.createElement('section');
    this.contentEl = document.createElement('div');
    this.modalEl.append(this.contentEl);
  }
  setTitle(text) { const heading = document.createElement('h2'); heading.textContent = text; this.modalEl.prepend(heading); }
  open() { if (!this.modalEl.isConnected) { document.body.append(this.modalEl); this.onOpen(); } }
  close() { if (this.modalEl.isConnected) { this.onClose(); this.modalEl.remove(); } }
}
export class MockMarkdownView {
  constructor(file, editor, mode = 'source') { this.file = file; this.editor = editor; this.mode = mode; }
  getMode() { return this.mode; }
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

export async function compilePlugin(source, notices) {
  const result = await build({ stdin: { contents: source, resolveDir: join(process.cwd(), 'src'), sourcefile: 'main.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'cjs',
    external: ['obsidian'], define: { __KIOKU_VERSION__: '"0.0.1"', __KIOKU_BUILD_ID__: '"unit-build"' } });
  class MockNotice { constructor(message) { notices.push(message); } }
  class MockPlugin {
    constructor(app) { this.app = app; this.ribbons = []; this.commands = []; this.events = []; }
    addRibbonIcon(_icon, title, callback) {
      const item = document.createElement('button'); item.setAttribute('aria-label', title); item.addEventListener('click', callback);
      document.body.append(item); this.ribbons.push(item); return item;
    }
    addCommand(command) { this.commands.push(command); return command; }
    registerEvent(ref) { this.events.push(ref); }
  }
  const obsidian = { Plugin: MockPlugin, Modal: MockModal, MarkdownView: MockMarkdownView, Notice: MockNotice, TFile: MockTFile };
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, crypto: globalThis.crypto,
    require: (id) => { if (id === 'obsidian') return obsidian; throw new Error(id); }, console });
  return module.exports.default;
}

/** An app whose note I/O is observable: views hold editors, closed files live in `files`. */
export function createApp({ files = {}, views = [], active = null } = {}) {
  const calls = [];
  const app = {
    calls, files,
    workspace: {
      getActiveViewOfType(type) { calls.push('workspace.getActiveViewOfType'); return active instanceof type ? active : null; },
      getLeavesOfType(type) { calls.push('workspace.getLeavesOfType'); return type === 'markdown' ? views.map((view) => ({ view })) : []; },
      on(name, callback) { return { name, callback }; },
    },
    vault: {
      async read(file) { calls.push(`vault.read:${file.path}`); return files[file.path]; },
      async process(file, fn) { calls.push(`vault.process:${file.path}`); files[file.path] = fn(files[file.path]); return files[file.path]; },
    },
  };
  return app;
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
