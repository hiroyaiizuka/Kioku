import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTFile, compilePlugin, installDom, network } from '../helpers/obsidian-mock.mjs';

/** Every note-related API throws and is recorded; only event registration (`workspace.on`) is allowed. */
function denyNoteIO(calls, path) {
  return new Proxy({}, { get: (_target, property) => {
    if (['adapter', 'activeEditor', 'editor'].includes(property)) return denyNoteIO(calls, `${path}.${property}`);
    if (path === 'workspace' && property === 'on') return (name, callback) => ({ name, callback });
    return (...args) => { calls.push({ method: `${path}.${String(property)}`, args }); throw new Error('Startup forbids note I/O.'); };
  } });
}
function deniedApp() {
  const ioCalls = [];
  return { ioCalls, vault: denyNoteIO(ioCalls, 'vault'), workspace: denyNoteIO(ioCalls, 'workspace'),
    metadataCache: denyNoteIO(ioCalls, 'metadataCache') };
}
/**
 * Fires every registered workspace event the way Obsidian could at any time. The file-menu
 * callback only builds menu items (never clicked here); none of them may touch notes.
 */
function fireRegisteredEvents(plugin) {
  const titles = [];
  for (const event of plugin.events) {
    if (event.name === 'file-menu') {
      const menu = { addItem(build) { const item = { setTitle(title) { titles.push(title); return item; },
        setIcon: () => item, onClick: () => item }; build(item); } };
      event.callback(menu, new MockTFile('Welcome.md'));
    } else event.callback();
  }
  return titles;
}
let dom;
let Plugin;
let notices;
beforeEach(async () => {
  dom = installDom(); notices = [];
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'), notices);
});
afterEach(() => { dom.window.close(); delete globalThis.document; delete globalThis.window; });

const status = (plugin) => plugin.commands.find((command) => command.id === 'open-startup');

describe('actual plugin source: startup and status popup', () => {
  it('registers one ribbon, the review / status / extract commands, a file-menu entry and settings without any I/O', () => {
    const app = deniedApp(); const plugin = new Plugin(app); plugin.onload();
    expect(plugin.ribbons).toHaveLength(1); expect(plugin.ribbons[0].getAttribute('aria-label')).toBe('フラッシュカード');
    expect(plugin.commands.map((command) => command.id)).toEqual(['open-review', 'open-startup', 'extract-explicit-qa']);
    expect(plugin.commands.map((command) => command.name)).toEqual(['デッキを選んで復習', 'フラッシュカード（状態）',
      '開いているノート・選択範囲から問い・答えの候補を抽出']);
    expect(plugin.events.map((event) => event.name)).toEqual(['file-menu']);
    expect(plugin.settingTabs).toHaveLength(1);
    expect(fireRegisteredEvents(plugin)).toEqual(['Kioku：問い・答えの候補を抽出']);
    // Settings (data.json) are read on first use, not at startup.
    expect(plugin.loadDataCalls).toBe(0);
    status(plugin).callback(); status(plugin).callback();
    const modals = document.querySelectorAll('.kioku-startup-modal'); expect(modals).toHaveLength(1);
    expect(modals[0].textContent).toContain('デッキで、採用したカードを間隔反復の日程で復習できます');
    expect(modals[0].textContent).toContain('テスト専用の保管場所での実機確認がまだです');
    expect(modals[0].textContent).toContain('AI による候補作成（一部実装）：設定したときだけ動き、候補は人が確認して採用します');
    expect(modals[0].textContent).toContain('ほかの判定・生成の方式は未実装です');
    expect(modals[0].textContent).toContain('この画面を開くだけではノートを読み書きしません');
    const identity = modals[0].querySelector('.kioku-build-identity');
    expect(identity.dataset).toMatchObject({ kiokuVersion: '0.0.1', kiokuBuildId: 'unit-build' });
    document.querySelector('.kioku-startup-close').click(); expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    plugin.onunload(); expect(app.ioCalls).toEqual([]);
    expect(network.calls).toEqual([]);
  });
  it('detects a startup mutant that sends a network request (AI must wait for the run button)', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace("ribbon.addClass('kioku-ribbon');",
      "ribbon.addClass('kioku-ribbon'); void ai.runtime.http.request({ url: 'http://localhost:11434/api/tags', method: 'GET' }).catch(() => undefined);");
    const Mutant = await compilePlugin(source, notices); const plugin = new Mutant(deniedApp()); plugin.onload();
    expect(network.calls.map((call) => call.url)).toEqual(['http://localhost:11434/api/tags']);
  });
  it('closes an open status popup on unload and can open after close', () => {
    const app = deniedApp(); const plugin = new Plugin(app); plugin.onload(); status(plugin).callback();
    document.querySelector('.kioku-startup-close').click(); status(plugin).callback();
    expect(document.querySelectorAll('.kioku-startup-modal')).toHaveLength(1);
    plugin.onunload(); expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    expect(app.ioCalls).toEqual([]);
  });
  it('detects the reviewer startup-write mutant instead of silently allowing optional Vault I/O', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace('override onload(): void {',
      "override onload(): void { const file = this.app.vault?.getFileByPath('Welcome.md'); if (file) void this.app.vault.modify(file, 'MUTATED BY STARTUP\\n');");
    const Mutant = await compilePlugin(source, notices); const app = deniedApp(); const plugin = new Mutant(app);
    expect(() => plugin.onload()).toThrow(/forbids note I\/O/);
    expect(app.ioCalls.map((call) => call.method)).toEqual(['vault.getFileByPath']);
  });
  it('detects a mutant that reads notes from a registered workspace event', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace('ribbon.addClass(\'kioku-ribbon\');',
      "ribbon.addClass('kioku-ribbon'); this.registerEvent(this.app.workspace.on('layout-change', () => extract()));");
    const Mutant = await compilePlugin(source, notices); const app = deniedApp(); const plugin = new Mutant(app);
    plugin.onload(); expect(app.ioCalls).toEqual([]);
    expect(() => fireRegisteredEvents(plugin)).toThrow(/forbids note I\/O/);
    expect(app.ioCalls.map((call) => call.method)).toEqual(['workspace.getActiveViewOfType']);
  });
  it('detects a startup-read mutant that extracts from the active note during onload', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace('ribbon.addClass(\'kioku-ribbon\');',
      "ribbon.addClass('kioku-ribbon'); extract();");
    const Mutant = await compilePlugin(source, notices); const app = deniedApp(); const plugin = new Mutant(app);
    expect(() => plugin.onload()).toThrow(/forbids note I\/O/);
    expect(app.ioCalls.map((call) => call.method)).toEqual(['workspace.getActiveViewOfType']);
  });
  it('detects a startup mutant that loads review data during onload', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace("ribbon.addClass('kioku-ribbon');",
      "ribbon.addClass('kioku-ribbon'); void this.app.vault.adapter.exists('Kioku');");
    const Mutant = await compilePlugin(source, notices); const app = deniedApp(); const plugin = new Mutant(app);
    expect(() => plugin.onload()).toThrow(/forbids note I\/O/);
    expect(app.ioCalls.map((call) => call.method)).toEqual(['vault.adapter.exists']);
  });
  it('detects a startup mutant that reads data.json during onload', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace("ribbon.addClass('kioku-ribbon');",
      "ribbon.addClass('kioku-ribbon'); void settings.get();");
    const Mutant = await compilePlugin(source, notices); const plugin = new Mutant(deniedApp()); plugin.onload();
    expect(plugin.loadDataCalls).toBe(1);
  });
});
