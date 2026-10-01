import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

class MockModal {
  constructor(app) {
    this.app = app;
    this.modalEl = document.createElement('section');
    this.contentEl = document.createElement('div');
    this.modalEl.append(this.contentEl);
  }
  setTitle(text) { const heading = document.createElement('h2'); heading.textContent = text; this.contentEl.append(heading); }
  open() { if (!this.modalEl.isConnected) { document.body.append(this.modalEl); this.onOpen(); } }
  close() { if (this.modalEl.isConnected) { this.onClose(); this.modalEl.remove(); } }
}
function denyNoteIO(calls, path) {
  return new Proxy({}, { get: (_target, property) => {
    if (['adapter', 'activeEditor', 'editor'].includes(property)) return denyNoteIO(calls, `${path}.${property}`);
    return (...args) => { calls.push({ method: `${path}.${String(property)}`, args }); throw new Error('M0 forbids note I/O.'); };
  } });
}
class MockPlugin {
  constructor() {
    this.ioCalls = [];
    this.app = { vault: denyNoteIO(this.ioCalls, 'vault'), workspace: denyNoteIO(this.ioCalls, 'workspace'),
      metadataCache: denyNoteIO(this.ioCalls, 'metadataCache') };
    this.ribbons = []; this.commands = [];
  }
  addRibbonIcon(_icon, title, callback) {
    const item = document.createElement('button'); item.setAttribute('aria-label', title); item.addEventListener('click', callback);
    document.body.append(item); this.ribbons.push(item); return item;
  }
  addCommand(command) { this.commands.push(command); return command; }
}
function installHelpers(window) {
  window.HTMLElement.prototype.empty = function empty() { this.replaceChildren(); };
  window.HTMLElement.prototype.addClass = function addClass(name) { this.classList.add(name); };
  window.HTMLElement.prototype.createEl = function createEl(tag, options = {}) {
    const node = document.createElement(tag); if (options.text) node.textContent = options.text;
    if (options.cls) node.className = options.cls; this.append(node); return node;
  };
  window.HTMLElement.prototype.createSpan = function createSpan(options = {}) { return this.createEl('span', options); };
}
let dom;
let Plugin;
async function compilePlugin(source) {
  const result = await build({ stdin: { contents: source, resolveDir: join(process.cwd(), 'src'), sourcefile: 'main.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'cjs',
    external: ['obsidian'], define: { __KIOKU_VERSION__: '"0.0.1"', __KIOKU_BUILD_ID__: '"unit-build"' } });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports,
    require: (id) => { if (id === 'obsidian') return { Plugin: MockPlugin, Modal: MockModal }; throw new Error(id); }, console });
  return module.exports.default;
}
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><body></body>');
  globalThis.document = dom.window.document; globalThis.window = dom.window; installHelpers(dom.window);
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'));
});
afterEach(() => { dom.window.close(); delete globalThis.document; delete globalThis.window; });

describe('actual M0 plugin source', () => {
  it('registers one honest ribbon and command which open one current build modal', () => {
    const plugin = new Plugin(); plugin.onload();
    expect(plugin.ribbons).toHaveLength(1); expect(plugin.ribbons[0].getAttribute('aria-label')).toBe('フラッシュカード');
    expect(plugin.commands.map((command) => command.id)).toEqual(['open-startup']);
    plugin.ribbons[0].click(); plugin.commands[0].callback();
    const modals = document.querySelectorAll('.kioku-startup-modal'); expect(modals).toHaveLength(1);
    expect(modals[0].textContent).toContain('カード作成・保存・デッキ・復習は未実装');
    expect(modals[0].textContent).toContain('ノートの読み取り・書き込みや外部送信は行いません');
    const identity = modals[0].querySelector('.kioku-build-identity');
    expect(identity.dataset).toMatchObject({ kiokuVersion: '0.0.1', kiokuBuildId: 'unit-build' });
    identity.closest('section').querySelector('button').click(); expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    plugin.onunload(); expect(plugin.ioCalls).toEqual([]);
  });
  it('closes an open modal on unload and can open after close', () => {
    const plugin = new Plugin(); plugin.onload(); plugin.commands[0].callback();
    document.querySelector('.kioku-startup-close').click(); plugin.commands[0].callback();
    expect(document.querySelectorAll('.kioku-startup-modal')).toHaveLength(1);
    plugin.onunload(); expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    expect(plugin.ioCalls).toEqual([]);
  });
  it('detects the reviewer startup-write mutant instead of silently allowing optional Vault I/O', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace('override onload(): void {',
      "override onload(): void { const file = this.app.vault?.getFileByPath('Welcome.md'); if (file) void this.app.vault.modify(file, 'MUTATED BY M0 STARTUP\\n');");
    const Mutant = await compilePlugin(source); const plugin = new Mutant();
    expect(() => plugin.onload()).toThrow(/M0 forbids note I\/O/);
    expect(plugin.ioCalls.map((call) => call.method)).toEqual(['vault.getFileByPath']);
  });
});
