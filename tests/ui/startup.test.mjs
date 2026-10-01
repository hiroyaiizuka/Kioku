import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compilePlugin, installDom } from '../helpers/obsidian-mock.mjs';

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
let dom;
let Plugin;
let notices;
beforeEach(async () => {
  dom = installDom(); notices = [];
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'), notices);
});
afterEach(() => { dom.window.close(); delete globalThis.document; delete globalThis.window; });

describe('actual plugin source: startup and status popup', () => {
  it('registers one ribbon, the status and extract commands and a file-menu entry without note I/O', () => {
    const app = deniedApp(); const plugin = new Plugin(app); plugin.onload();
    expect(plugin.ribbons).toHaveLength(1); expect(plugin.ribbons[0].getAttribute('aria-label')).toBe('フラッシュカード');
    expect(plugin.commands.map((command) => command.id)).toEqual(['open-startup', 'extract-explicit-qa']);
    expect(plugin.events.map((event) => event.name)).toEqual(['file-menu']);
    plugin.ribbons[0].click(); plugin.commands[0].callback();
    const modals = document.querySelectorAll('.kioku-startup-modal'); expect(modals).toHaveLength(1);
    expect(modals[0].textContent).toContain('採用したものだけ元ノートへ保存');
    expect(modals[0].textContent).toContain('デッキ・復習（間隔反復）・AI による候補作成は未実装');
    expect(modals[0].textContent).toContain('この画面を開くだけではノートを読み書きしません');
    const identity = modals[0].querySelector('.kioku-build-identity');
    expect(identity.dataset).toMatchObject({ kiokuVersion: '0.0.1', kiokuBuildId: 'unit-build' });
    document.querySelector('.kioku-startup-close').click(); expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    plugin.onunload(); expect(app.ioCalls).toEqual([]);
  });
  it('closes an open status popup on unload and can open after close', () => {
    const app = deniedApp(); const plugin = new Plugin(app); plugin.onload(); plugin.commands[0].callback();
    document.querySelector('.kioku-startup-close').click(); plugin.commands[0].callback();
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
  it('detects a startup-read mutant that extracts from the active note during onload', async () => {
    const source = readFileSync('src/main.ts', 'utf8').replace('ribbon.addClass(\'kioku-ribbon\');',
      "ribbon.addClass('kioku-ribbon'); extract();");
    const Mutant = await compilePlugin(source, notices); const app = deniedApp(); const plugin = new Mutant(app);
    expect(() => plugin.onload()).toThrow(/forbids note I\/O/);
    expect(app.ioCalls.map((call) => call.method)).toEqual(['workspace.getActiveViewOfType']);
  });
});
