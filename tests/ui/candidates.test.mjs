// Real plugin source bundled against public-API doubles. Proves the write-path contract
// (read only on explicit action, write only on adopt, verify before write), not native behaviour.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEditor, MockMarkdownView, MockTFile, compilePlugin, createApp, installDom } from '../helpers/obsidian-mock.mjs';

const NOTE = [
  '# 生物',
  '## 復習',
  'Q: 光合成とは？',
  'A: 光で糖を作る反応',
  '',
  '```md',
  'Q: コード内の問い',
  'A: 対象外',
  '```',
  '',
  '## 復習',
  '問：細胞の基本単位は？',
  '答：細胞',
  '',
].join('\n');

let dom;
let Plugin;
let notices;
beforeEach(async () => {
  dom = installDom(); notices = [];
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'), notices);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); dom.window.close(); delete globalThis.document; delete globalThis.window; });

function openNote(text = NOTE, { mode = 'source', extraViews = [], editor = new FakeEditor(text), canvases = {} } = {}) {
  const file = new MockTFile('学習/生物.md');
  const view = new MockMarkdownView(file, editor, mode);
  const canvasFiles = Object.keys(canvases).map((path) => new MockTFile(path));
  const app = createApp({ files: { [file.path]: text, ...canvases }, views: [...extraViews.map((extra) => extra(file)), view],
    active: view, canvases: canvasFiles });
  const plugin = new Plugin(app); plugin.onload();
  return { app, plugin, file, editor, view };
}
const extractCommand = (plugin) => plugin.commands.find((command) => command.id === 'extract-explicit-qa');
const items = () => [...document.querySelectorAll('.kioku-candidate-modal .kioku-candidate')];
const card = (index) => items()[index];
// Fake timers: the post-write disk confirmation (settle 3 s, deadline 6 s) runs instantly but in order.
const flush = () => vi.advanceTimersByTimeAsync(0);
const settle = () => vi.advanceTimersByTimeAsync(7000);
async function click(element) { element.click(); await settle(); }
function edit(element, value) { element.value = value; element.dispatchEvent(new window.Event('input')); }

describe('extraction popup', () => {
  it('reads nothing until the explicit command and lists only real Q/A with the original text', () => {
    const { app, plugin, editor } = openNote();
    expect(app.calls).toEqual([]);
    expect(extractCommand(plugin).checkCallback(true)).toBe(true);
    expect(editor.transactions).toEqual([]);
    extractCommand(plugin).checkCallback(false);
    expect(document.querySelectorAll('.kioku-candidate-modal')).toHaveLength(1);
    expect(document.querySelector('.kioku-candidate-modal h2').textContent).toBe('問い・答えの候補 — 生物');
    expect(items().map((item) => item.querySelector('.kioku-candidate-source').textContent))
      .toEqual(['Q: 光合成とは？\nA: 光で糖を作る反応', '問：細胞の基本単位は？\n答：細胞']);
    expect(items().map((item) => item.querySelector('.kioku-candidate-meta').textContent))
      .toEqual(['3 行目 · 未採用', '12 行目 · 未採用']);
    expect(card(0).querySelector('.kioku-candidate-question').value).toBe('光合成とは？');
    expect(app.calls.some((call) => call.startsWith('vault.'))).toBe(false);
  });

  it('is unavailable without an active Markdown note', () => {
    const app = createApp(); const plugin = new Plugin(app); plugin.onload();
    expect(extractCommand(plugin).checkCallback(true)).toBe(false);
    plugin.commands[0].callback(); document.querySelector('.kioku-startup-extract').click();
    expect(notices).toEqual(['Kioku：Markdown ノートを開いてから実行してください。']);
  });

  it('opens from the status popup button as well', () => {
    const { plugin } = openNote();
    plugin.ribbons[0].click(); document.querySelector('.kioku-startup-extract').click();
    expect(document.querySelector('.kioku-startup-modal')).toBeNull();
    expect(items()).toHaveLength(2);
  });

  it('writes nothing on discard or close', async () => {
    const { app, plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    await click(card(0).querySelector('.kioku-candidate-discard'));
    expect(items()).toHaveLength(1);
    document.querySelector('.kioku-candidate-close').click();
    expect(document.querySelector('.kioku-candidate-modal')).toBeNull();
    expect(editor.transactions).toEqual([]); expect(editor.getValue()).toBe(NOTE);
    expect(app.calls.filter((call) => call.startsWith('vault.'))).toEqual([]);
  });

  it('limits candidates to the selection', () => {
    const { plugin, editor } = openNote();
    const from = NOTE.indexOf('答：'); editor.selection = [from, from + 2];
    extractCommand(plugin).checkCallback(false);
    expect(items()).toHaveLength(1);
    expect(document.querySelector('.kioku-candidate-summary').textContent).toContain('選択範囲');
  });

  it('shows a syntax hint when nothing is found', () => {
    const { plugin } = openNote('# 空\n本文だけ');
    extractCommand(plugin).checkCallback(false);
    expect(document.querySelector('.kioku-candidate-empty').textContent).toContain('行頭にQ:（または「問:」）とA:（または「答:」）');
  });
});

describe('adoption through the open editor', () => {
  it('adopts with one editor transaction (one Undo step) at the verified position, never via Vault', async () => {
    const { app, plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    await click(card(1).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toHaveLength(1);
    const after = editor.getValue();
    expect(after).toMatch(/\n答：細胞 \^kioku-[0-9a-z]{10}\n$/);
    expect(after.replace(/ \^kioku-[0-9a-z]{10}/, '')).toBe(NOTE);
    expect(card(1).querySelector('.kioku-candidate-meta').textContent).toMatch(/採用済み · kioku-/);
    expect(notices[0]).toMatch(/^Kioku：採用しました（kioku-[0-9a-z]{10}）。$/);
    // Editor path: no Vault write; the view is flushed with the public save() and the disk is re-read to confirm.
    expect(app.calls.filter((call) => call.startsWith('vault.process'))).toEqual([]);
    const afterAdopt = app.calls.slice(app.calls.indexOf('save:学習/生物.md'));
    expect(afterAdopt[0]).toBe('save:学習/生物.md'); expect(afterAdopt).toContain('vault.read:学習/生物.md');
    editor.undo(); expect(editor.getValue()).toBe(NOTE);
    editor.redo(); expect(editor.getValue()).toBe(after);
  });

  it('keeps later offsets exact after adopting earlier cards under same-name headings', async () => {
    const twin = '## 復習\nQ: 同じ\nA: 同じ\n\n## 復習\nQ: 同じ\nA: 同じ\n';
    const { plugin, editor } = openNote(twin);
    extractCommand(plugin).checkCallback(false);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    await click(card(1).querySelector('.kioku-candidate-adopt'));
    expect(editor.getValue()).toMatch(/^## 復習\nQ: 同じ\nA: 同じ \^kioku-\w{10}\n\n## 復習\nQ: 同じ\nA: 同じ \^kioku-\w{10}\n$/);
    const ids = editor.getValue().match(/kioku-\w{10}/g); expect(new Set(ids).size).toBe(2);
  });

  it('stores popup edits as an edit record and keeps the original text', async () => {
    const { plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    edit(card(0).querySelector('.kioku-candidate-answer'), '光エネルギーで糖を作る反応');
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    const value = editor.getValue();
    expect(value).toContain('Q: 光合成とは？\nA: 光で糖を作る反応 ^kioku-');
    expect(value).toMatch(/\n\n%%kioku-edit:kioku-\w{10}\nQ: 光合成とは？\nA: 光エネルギーで糖を作る反応\n%%\n\n```md/);
    expect(card(0).querySelector('.kioku-candidate-card').textContent).toBe('Q: 光合成とは？\nA: 光エネルギーで糖を作る反応');
  });

  it('refuses to write when the note changed externally, keeping the draft and explaining why', async () => {
    const { plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    edit(card(0).querySelector('.kioku-candidate-question'), '下書き');
    editor.text = NOTE.replace('A: 光で糖を作る反応', 'A: 外部で書き換え');
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toEqual([]);
    expect(notices[0]).toBe('Kioku：保存しませんでした。原文が抽出後に変更されています。もう一度抽出してください。');
    expect(card(0).querySelector('.kioku-candidate-message').textContent).toBe('保存しませんでした：原文が抽出後に変更されています。もう一度抽出してください。');
    expect(card(0).querySelector('.kioku-candidate-question').value).toBe('下書き');
  });

  it('does not adopt twice when another view already adopted the block', async () => {
    const { plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    editor.text = NOTE.replace('A: 光で糖を作る反応', 'A: 光で糖を作る反応 ^kioku-0000000000');
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toEqual([]);
    expect(notices[0]).toContain('既に採用済み');
  });

  it('writes through the Source/Live Preview view when the note is open in several views', async () => {
    const preview = { editor: null };
    const { plugin, editor } = openNote(NOTE, { extraViews: [(file) => {
      preview.editor = new FakeEditor(NOTE); return new MockMarkdownView(file, preview.editor, 'preview');
    }] });
    extractCommand(plugin).checkCallback(false);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toHaveLength(1); expect(preview.editor.transactions).toEqual([]);
  });

  it('writes through Vault.process, not the hidden editor, when the note is open only in Reading view', async () => {
    const { app, plugin, editor, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    expect(app.calls).toContain(`vault.read:${file.path}`);
    expect(items()).toHaveLength(2);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toEqual([]); expect(editor.getValue()).toBe(NOTE);
    expect(app.calls).toContain(`vault.process:${file.path}`);
    expect(app.files[file.path]).toMatch(/A: 光で糖を作る反応 \^kioku-\w{10}\n/);
    expect(notices[0]).toMatch(/^Kioku：採用しました/);
  });

  it('writes through the editing view when Reading and Live Preview views are split, in either order', async () => {
    for (const editingFirst of [true, false]) {
      dom.window.document.body.replaceChildren(); notices.length = 0;
      const source = { editor: null };
      const extra = (file) => { source.editor = new FakeEditor(NOTE); return new MockMarkdownView(file, source.editor, 'source'); };
      const { app, plugin, editor } = openNote(NOTE, { mode: 'preview', extraViews: editingFirst ? [extra] : [] });
      if (!editingFirst) {
        const reading = app.workspace.getActiveViewOfType(MockMarkdownView); const editing = extra(reading.file);
        editing.onSave = (text) => { app.files[reading.file.path] = text; };
        app.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [{ view: reading }, { view: editing }] : []);
      }
      extractCommand(plugin).checkCallback(false); await flush();
      await click(card(0).querySelector('.kioku-candidate-adopt'));
      expect(source.editor.transactions).toHaveLength(1); expect(editor.transactions).toEqual([]);
      expect(app.calls.some((call) => call.startsWith('vault.process'))).toBe(false);
    }
  });

  it('reports failure instead of success when the editor write cannot be confirmed', async () => {
    class SwallowingEditor extends FakeEditor { transaction(spec) { this.transactions.push(spec); } }
    const { plugin, editor } = openNote(NOTE, { editor: new SwallowingEditor(NOTE) });
    extractCommand(plugin).checkCallback(false);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.transactions).toHaveLength(1);
    expect(notices).toEqual(['Kioku：保存しませんでした。書き込みを確認できませんでした。ノートを開いて ID が付いたか確認してください。']);
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toBe('3 行目 · 未採用');
  });

  it('marks already adopted cards on re-extraction and offers no adopt button', () => {
    const adopted = NOTE.replace('A: 光で糖を作る反応', 'A: 光で糖を作る反応 ^kioku-abcdefghij');
    const { plugin } = openNote(adopted);
    extractCommand(plugin).checkCallback(false);
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toBe('3 行目 · 採用済み · kioku-abcdefghij');
    expect(card(0).querySelector('.kioku-candidate-adopt')).toBeNull();
    expect(card(1).querySelector('.kioku-candidate-adopt')).not.toBeNull();
  });

  it('ignores a second adopt click while the first is saving (no double write, no false error)', async () => {
    const { plugin, editor } = openNote();
    extractCommand(plugin).checkCallback(false);
    const button = card(0).querySelector('.kioku-candidate-adopt');
    button.click(); button.click(); await settle();
    expect(editor.transactions).toHaveLength(1);
    expect(notices).toHaveLength(1); expect(notices[0]).toMatch(/採用しました/);
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toMatch(/採用済み · kioku-/);
  });

  it('announces and inserts one blank line when text follows the block directly', async () => {
    const note = 'Q: 一つ目\nA: 答え1\nQ: 二つ目\nA: 答え2';
    const { plugin, editor } = openNote(note);
    extractCommand(plugin).checkCallback(false);
    expect(card(0).querySelector('.kioku-candidate-note').textContent).toBe('直後に空行がないため、採用時にこのブロックの後へ空行を1行追加します（ID を段落末に置くため。原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。');
    expect(card(1).querySelector('.kioku-candidate-note')).toBeNull();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.getValue()).toMatch(/^Q: 一つ目\nA: 答え1 \^kioku-\w{10}\n\nQ: 二つ目\nA: 答え2$/);
    await click(card(1).querySelector('.kioku-candidate-adopt'));
    expect(editor.getValue()).toMatch(/^Q: 一つ目\nA: 答え1 \^kioku-\w{10}\n\nQ: 二つ目\nA: 答え2 \^kioku-\w{10}$/);
  });

  it('does not insert a blank line inside a tight list unless an edit record is added', async () => {
    const note = '- Q: 一つ目\n- A: 答え1\n- Q: 二つ目\n- A: 答え2';
    const { plugin, editor } = openNote(note);
    extractCommand(plugin).checkCallback(false);
    expect(card(0).querySelector('.kioku-candidate-note').textContent).toBe('編集して採用した場合だけ、編集記録の後に空行を1行追加します（原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。');
    expect(card(1).querySelector('.kioku-candidate-note')).toBeNull();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(editor.getValue()).toMatch(/^- Q: 一つ目\n- A: 答え1 \^kioku-\w{10}\n- Q: 二つ目\n- A: 答え2$/);
  });

  it('shows duplicate-ID and foreign-block-ID blocks as non-adoptable, not as adopted cards', () => {
    const note = 'Q: a\nA: b ^kioku-abcdefghij\n\nQ: a\nA: b ^kioku-abcdefghij\n\nQ: c\nA: d ^mine';
    const { plugin } = openNote(note);
    extractCommand(plugin).checkCallback(false);
    expect(items().map((item) => item.querySelector('.kioku-candidate-meta').textContent)).toEqual([
      '1 行目 · ID 重複のため採用不可 · kioku-abcdefghij', '4 行目 · ID 重複のため採用不可 · kioku-abcdefghij',
      '7 行目 · 既存の block ID があるため採用不可']);
    for (const item of items()) {
      expect(item.querySelector('.kioku-candidate-card')).toBeNull();
      expect(item.querySelector('.kioku-candidate-adopt')).toBeNull();
      expect(item.querySelector('.kioku-candidate-blocked')).not.toBeNull();
    }
  });

  it('keeps the list scroll position after adopt and discard re-render the list', async () => {
    const { plugin } = openNote();
    extractCommand(plugin).checkCallback(false);
    const list = () => document.querySelector('.kioku-candidate-list');
    list().scrollTop = 120;
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(list().scrollTop).toBe(120);
    await click(card(1).querySelector('.kioku-candidate-discard'));
    expect(list().scrollTop).toBe(120);
  });

  it('closes candidate popups on unload', () => {
    const { plugin } = openNote();
    extractCommand(plugin).checkCallback(false);
    plugin.onunload();
    expect(document.querySelector('.kioku-candidate-modal')).toBeNull();
  });
});

describe('open Canvas embeds (pre-write guard)', () => {
  const canvas = (nodes) => JSON.stringify({ nodes, edges: [] });
  const EMBEDDED = 'このノートは開いている Canvas（board.canvas）に埋め込まれています。Canvas を閉じてから採用してください。';

  for (const mode of ['preview', 'source']) {
    it(`refuses without writing when an open Canvas embeds the note (${mode})`, async () => {
      const { app, plugin, editor, file } = openNote(NOTE, { mode,
        canvases: { 'board.canvas': canvas([{ id: 'n1', type: 'text', text: 'x' }, { id: 'n2', type: 'file', file: '学習/生物.md' }]) } });
      extractCommand(plugin).checkCallback(false); await flush();
      await click(card(0).querySelector('.kioku-candidate-adopt'));
      expect(notices).toEqual([`Kioku：保存しませんでした。${EMBEDDED}`]);
      expect(card(0).querySelector('.kioku-candidate-message').textContent).toBe(`保存しませんでした：${EMBEDDED}`);
      expect(editor.transactions).toEqual([]); expect(app.files[file.path]).toBe(NOTE);
      expect(app.calls.some((call) => call.startsWith('vault.process'))).toBe(false);
    });
  }

  it('adopts normally when open Canvases do not embed the note', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview',
      canvases: { 'board.canvas': canvas([{ id: 'n1', type: 'file', file: '別のノート.md' }]) } });
    extractCommand(plugin).checkCallback(false); await flush();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(app.calls).toContain('vault.cachedRead:board.canvas');
    expect(app.files[file.path]).toMatch(/\^kioku-\w{10}/); expect(notices[0]).toMatch(/^Kioku：採用しました/);
  });

  it('still refuses when a Canvas leaf without a loaded file comes before the embedding Canvas', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview',
      canvases: { 'board.canvas': canvas([{ id: 'n2', type: 'file', file: '学習/生物.md' }]) } });
    const leaves = app.workspace.getLeavesOfType;
    // A deferred (not yet loaded) canvas leaf has no TFile; it must be skipped, not end the scan.
    app.workspace.getLeavesOfType = (type) => (type === 'canvas' ? [{ view: { file: null } }, { view: { file: { path: 'x.canvas' } } }, ...leaves(type)] : leaves(type));
    extractCommand(plugin).checkCallback(false); await flush();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(notices).toEqual([`Kioku：保存しませんでした。${EMBEDDED}`]);
    expect(app.files[file.path]).toBe(NOTE);
  });

  it('refuses when an open Canvas cannot be read as JSON', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview', canvases: { 'board.canvas': '{broken' } });
    extractCommand(plugin).checkCallback(false); await flush();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(notices[0]).toMatch(/^Kioku：保存しませんでした。開いている Canvas（board\.canvas）を確認できません（.+）。Canvas を閉じてから採用してください。$/);
    expect(app.files[file.path]).toBe(NOTE);
  });
});

describe('post-write disk confirmation', () => {
  it('shows a pending state and reports success only after the ID stays on disk for the settle window', async () => {
    for (const mode of ['source', 'preview']) {
      dom.window.document.body.replaceChildren(); notices.length = 0;
      const { app, plugin, file } = openNote(NOTE, { mode });
      extractCommand(plugin).checkCallback(false); await flush();
      card(0).querySelector('.kioku-candidate-adopt').click();
      await vi.advanceTimersByTimeAsync(100);
      expect(app.files[file.path]).toMatch(/\^kioku-\w{10}/);
      expect(card(0).querySelector('.kioku-candidate-message').textContent).toBe('保存を確認しています…');
      expect(card(0).querySelector('.kioku-candidate-meta').textContent).toBe('3 行目 · 未採用');
      expect(card(1).querySelector('.kioku-candidate-adopt').disabled).toBe(true);
      expect(notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(2800);
      expect(notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(notices).toHaveLength(1); expect(notices[0]).toMatch(/^Kioku：採用しました（kioku-\w{10}）。$/);
      expect(card(0).querySelector('.kioku-candidate-meta').textContent).toMatch(/^3 行目 · 採用済み · kioku-/);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  const LOST = 'Kioku：採用を確認できませんでした。保存後に ID が見つかりません。別の画面の保存で上書きされた可能性があります。もう一度抽出してください。';
  const processCalls = (app) => app.calls.filter((call) => call.startsWith('vault.process')).length;

  it('recovers once when a closed hover popover saves its stale buffer over the write (re-verified, one ID)', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(app.files[file.path]).toMatch(/\^kioku-\w{10}/);
    // The popover's pending save writes its stale (pre-adoption) buffer plus the user's typing.
    app.modify(file.path, `${NOTE}hoverTyped`);
    await vi.advanceTimersByTimeAsync(400);
    expect(card(0).querySelector('.kioku-candidate-message').textContent).toContain('もう一度保存します');
    expect(notices).toEqual([]);
    await settle();
    expect(processCalls(app)).toBe(2);
    expect(notices).toHaveLength(1); expect(notices[0]).toMatch(/^Kioku：採用しました（kioku-\w{10}）。$/);
    const final = app.files[file.path];
    expect(final.match(/\^kioku-/g)).toHaveLength(1);
    expect(final).toContain(notices[0].match(/kioku-\w{10}/)[0]);
    expect(final.endsWith('hoverTyped')).toBe(true);
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toMatch(/^3 行目 · 採用済み · kioku-/);
  });

  it('gives up honestly after one retry when the other view keeps saving over the note', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    // Every Kioku write is overwritten again shortly afterwards.
    app.vault.on('modify', () => {
      if (/\^kioku-/.test(app.files[file.path])) globalThis.setTimeout(() => app.modify(file.path, `${NOTE}typing`), 100);
    });
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(20000);
    expect(processCalls(app)).toBe(2);
    expect(notices).toEqual([LOST]);
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toBe('3 行目 · 未採用');
    expect(app.files[file.path]).not.toMatch(/\^kioku-/);
  });

  it('does not retry when the stale save changed the original text (re-verification)', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(300);
    const changed = NOTE.replace('A: 光で糖を作る反応', 'A: ポップオーバーで書き換え');
    app.modify(file.path, changed);
    await settle();
    expect(processCalls(app)).toBe(2); // the retry ran through Vault.process but wrote nothing
    expect(app.files[file.path]).toBe(changed);
    expect(notices).toEqual(['Kioku：保存しませんでした。原文が抽出後に変更されています。もう一度抽出してください。']);
  });

  it('gives up when the note never becomes quiet before the retry', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(300);
    app.modify(file.path, `${NOTE}t`);
    for (let i = 0; i < 60; i += 1) { await vi.advanceTimersByTimeAsync(200); app.modify(file.path, `${NOTE}t${i}`); }
    await settle();
    expect(processCalls(app)).toBe(1);
    expect(notices).toEqual([LOST]);
    expect(app.modifyListeners.size).toBe(0);
  });

  it('reports a lost write when the editor flush never reaches the disk (no second insert into the buffer)', async () => {
    const { app, plugin, view, editor } = openNote(NOTE);
    view.save = async () => {}; // the editor never persists
    extractCommand(plugin).checkCallback(false);
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(20000);
    expect(notices).toEqual([LOST]);
    expect(editor.transactions).toHaveLength(1);
    expect(app.calls.some((call) => call.startsWith('vault.process'))).toBe(false);
  });

  const PENDING_CLOSE = 'Kioku：保存の確認前に閉じました。もう一度抽出して採用済みか確認してください。';
  for (const how of ['close', 'unload']) {
    it(`cancels the pending confirmation on ${how} without leftover timers (one Notice on close, none on unload)`, async () => {
      const { plugin } = openNote(NOTE, { mode: 'preview' });
      extractCommand(plugin).checkCallback(false); await flush();
      card(0).querySelector('.kioku-candidate-adopt').click();
      await vi.advanceTimersByTimeAsync(300);
      if (how === 'close') document.querySelector('.kioku-candidate-close').click(); else plugin.onunload();
      expect(vi.getTimerCount()).toBe(0);
      await settle();
      expect(notices).toEqual(how === 'close' ? [PENDING_CLOSE] : []);
      expect(document.querySelector('.kioku-candidate-modal')).toBeNull();
    });
  }

  it('shows no pending Notice when closing after the confirmation finished', async () => {
    const { plugin } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    document.querySelector('.kioku-candidate-close').click();
    expect(notices).toHaveLength(1); expect(notices[0]).toMatch(/^Kioku：採用しました/);
  });

  it('never reports success when confirmation (and recovery) throw', async () => {
    const { app, plugin } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    const leaves = app.workspace.getLeavesOfType;
    let calls = 0;
    // From the 3rd workspace query on (inside confirmAdoption, after the guard and the write) everything throws.
    app.workspace.getLeavesOfType = (type) => { calls += 1; if (calls >= 3) throw new Error('boom'); return leaves(type); };
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain('採用しました');
    expect(card(0).querySelector('.kioku-candidate-meta').textContent).toBe('3 行目 · 未採用');
  });

  it('does not count a duplicated ID (copied block) as a confirmed adoption', async () => {
    const { app, plugin, file } = openNote(NOTE, { mode: 'preview' });
    extractCommand(plugin).checkCallback(false); await flush();
    card(0).querySelector('.kioku-candidate-adopt').click();
    await vi.advanceTimersByTimeAsync(300);
    const id = app.files[file.path].match(/\^(kioku-\w{10})/)[1];
    app.modify(file.path, `${app.files[file.path]}\nQ: copy\nA: copy ^${id}\n`);
    await vi.advanceTimersByTimeAsync(20000);
    expect(notices).toEqual(['Kioku：保存しませんでした。この問い・答えは既に採用済みです。']);
  });
});

describe('closed note through the file menu', () => {
  function closedNote(text) {
    const file = new MockTFile('閉じた.md'); const app = createApp({ files: { '閉じた.md': text } });
    const plugin = new Plugin(app); plugin.onload();
    const menuItems = [];
    const menu = { addItem(build) { const item = { setTitle(title) { this.title = title; return this; },
      setIcon() { return this; }, onClick(handler) { this.handler = handler; return this; } }; build(item); menuItems.push(item); } };
    plugin.events[0].callback(menu, file);
    return { app, plugin, file, menuItems };
  }

  it('reads with Vault and adopts with Vault.process only on adopt', async () => {
    const { app, menuItems } = closedNote(NOTE);
    expect(app.calls).toEqual([]);
    expect(menuItems.map((item) => item.title)).toEqual(['Kioku：問い・答えの候補を抽出']);
    menuItems[0].handler(); await flush();
    expect(app.calls).toEqual(['workspace.getLeavesOfType:markdown', 'vault.read:閉じた.md']);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(app.calls.slice(2, 6)).toEqual(['workspace.getLeavesOfType:canvas', 'workspace.getLeavesOfType:markdown',
      'vault.process:閉じた.md', 'workspace.getLeavesOfType:markdown']);
    // Then only reads (disk confirmation), never another write.
    expect(new Set(app.calls.slice(6))).toEqual(new Set(['vault.read:閉じた.md']));
    expect(app.files['閉じた.md']).toMatch(/A: 光で糖を作る反応 \^kioku-\w{10}\n/);
    expect(app.files['閉じた.md'].replace(/ \^kioku-\w{10}/, '')).toBe(NOTE);
  });

  it('returns the file unchanged from Vault.process when the original no longer matches', async () => {
    const { app, menuItems } = closedNote(NOTE);
    menuItems[0].handler(); await flush();
    const changed = NOTE.replace('問：細胞の基本単位は？', '問：外部変更');
    app.files['閉じた.md'] = changed;
    await click(card(1).querySelector('.kioku-candidate-adopt'));
    expect(app.files['閉じた.md']).toBe(changed);
    expect(notices[0]).toContain('原文が抽出後に変更');
  });

  it('reports failure when Vault.process does not produce the planned content', async () => {
    const { app, menuItems } = closedNote(NOTE);
    menuItems[0].handler(); await flush();
    app.vault.process = async (file, fn) => { fn(app.files[file.path]); return app.files[file.path]; };
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(notices[0]).toContain('書き込みを確認できませんでした');
    expect(notices[0]).not.toContain('採用しました');
  });

  it('reports failure when Vault.process throws', async () => {
    const { app, menuItems } = closedNote(NOTE);
    menuItems[0].handler(); await flush();
    app.vault.process = async () => { throw new Error('disk full'); };
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(notices[0]).toBe('Kioku：保存しませんでした。ノートを書き換えられませんでした（disk full）。');
  });

  it('ignores non-Markdown files', () => {
    const app = createApp(); const plugin = new Plugin(app); plugin.onload();
    const file = new MockTFile('drawing.png'); file.extension = 'png';
    const added = []; plugin.events[0].callback({ addItem: (build) => added.push(build) }, file);
    expect(added).toEqual([]);
  });
});
