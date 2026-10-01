// Real plugin source bundled against public-API doubles. Proves the write-path contract
// (read only on explicit action, write only on adopt, verify before write), not native behaviour.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEditor, MockMarkdownView, MockTFile, compilePlugin, createApp, flush, installDom } from '../helpers/obsidian-mock.mjs';

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
});
afterEach(() => { dom.window.close(); delete globalThis.document; delete globalThis.window; });

function openNote(text = NOTE, { mode = 'source', extraViews = [], editor = new FakeEditor(text) } = {}) {
  const file = new MockTFile('学習/生物.md');
  const view = new MockMarkdownView(file, editor, mode);
  const app = createApp({ files: { [file.path]: text }, views: [...extraViews.map((extra) => extra(file)), view], active: view });
  const plugin = new Plugin(app); plugin.onload();
  return { app, plugin, file, editor, view };
}
const extractCommand = (plugin) => plugin.commands.find((command) => command.id === 'extract-explicit-qa');
const items = () => [...document.querySelectorAll('.kioku-candidate-modal .kioku-candidate')];
const card = (index) => items()[index];
async function click(element) { element.click(); await flush(); await flush(); }
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
    expect(app.calls.filter((call) => call.startsWith('vault.'))).toEqual([]);
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
      if (!editingFirst) app.workspace.getLeavesOfType = () => [{ view: app.workspace.getActiveViewOfType(MockMarkdownView) }, { view: extra(app.workspace.getActiveViewOfType(MockMarkdownView).file) }];
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
    button.click(); button.click(); await flush(); await flush();
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
    expect(app.calls).toEqual(['workspace.getLeavesOfType', 'vault.read:閉じた.md']);
    await click(card(0).querySelector('.kioku-candidate-adopt'));
    expect(app.calls.slice(2)).toEqual(['workspace.getLeavesOfType', 'vault.process:閉じた.md']);
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
