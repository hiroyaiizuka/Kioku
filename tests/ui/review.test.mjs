// Real plugin source bundled against public-API doubles (jsdom). Proves the review/storage
// contract (no write on open, one history line per rating, keyboard safety), not native behaviour.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockComponent, compilePlugin, createApp, installDom, renders } from '../helpers/obsidian-mock.mjs';
import { FakeAdapter } from '../helpers/fake-adapter.mjs';

const NOTES = {
  '学習/生理.md': '#kioku/医学/生理\nQ: 心拍数は？\nA: 約60 ^kioku-aaaaaaaaaa\n\nQ: 図 ![[heart.png]] は？\nA: 心臓 ^kioku-bbbbbbbbbb\n',
  '学習/英語.md': '---\ntags: [Kioku/英語]\n---\nQ: apple\nA: りんご ^kioku-cccccccccc\n',
  '学習/両方.md': '#kioku/医学 #kioku/英語\nQ: both\nA: 両方 ^kioku-dddddddddd\n',
  '学習/コード.md': '```\n#kioku/code\n```\nQ: code tag only\nA: untagged ^kioku-eeeeeeeeee\n',
  '学習/衝突A.md': '#kioku\nQ: X\nA: 1 ^kioku-ffffffffff\n',
  '学習/衝突B.md': '#kioku\nQ: X\nA: 2 ^kioku-ffffffffff\n',
  'Welcome.md': '# Welcome\n',
};
const H = 'Kioku/history-2026.jsonl';
const S = 'Kioku/state.json';

let dom;
let Plugin;
let notices;
beforeEach(async () => {
  dom = installDom(); notices = []; renders.length = 0; MockComponent.instances.length = 0;
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'), notices);
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 2, 10, 0) });
});
afterEach(() => { vi.useRealTimers(); dom.window.close(); delete globalThis.document; delete globalThis.window; });

/** Lets real async work (crypto.subtle, awaited adapter calls) settle. */
async function settle(rounds = 30) { for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }

function setup({ notes = NOTES, kioku = {}, settings = null } = {}) {
  const adapter = new FakeAdapter({ ...notes, ...kioku });
  const app = createApp({ files: { ...notes }, adapter });
  const plugin = new Plugin(app); plugin.data = settings; plugin.onload();
  return { app, adapter, plugin };
}
const picker = () => document.querySelector('.kioku-deck-picker-modal');
const rows = () => [...document.querySelectorAll('.kioku-deck-row')].map((row) =>
  `${row.querySelector('.kioku-deck-name').textContent} | ${row.querySelector('.kioku-deck-counts').textContent}${row.querySelector('.kioku-deck-later') ? ' | later' : ''}`);
const row = (name) => [...document.querySelectorAll('.kioku-deck-row')].find((item) => item.querySelector('.kioku-deck-name').textContent === name);
const phase = () => document.querySelector('.kioku-review')?.dataset.kiokuPhase;
const question = () => document.querySelector('.kioku-review-question')?.textContent;
const historyLines = (adapter) => (adapter.files.get(H) ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const target = () => document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('.kioku-review');
function key(value, init = {}, element = target()) {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}
async function openPicker(plugin) { plugin.ribbons[0].click(); await settle(); }
async function startDeck(plugin, name = '全デッキ') { await openPicker(plugin); row(name).click(); await settle(); }

describe('deck picker (ribbon)', () => {
  it('opens centred with the build identity and writes nothing on open, close or Escape (no Kioku folder)', async () => {
    const { app, adapter, plugin } = setup();
    await openPicker(plugin);
    expect(picker().dataset).toMatchObject({ kiokuVersion: '0.0.1', kiokuBuildId: 'unit-build' });
    expect(picker().querySelector('h2').textContent).toBe('Kioku — デッキを選んで復習');
    document.querySelector('.kioku-deck-picker-close').click();
    expect(picker()).toBeNull();
    await openPicker(plugin);
    key('Escape', {}, document.querySelector('.kioku-deck-row'));
    expect(picker()).toBeNull();
    expect(adapter.writes()).toEqual([]);
    expect(adapter.folders.has('Kioku')).toBe(false);
    expect(Object.fromEntries([...adapter.files].filter(([path]) => path.endsWith('.md')))).toEqual(NOTES);
    expect(app.calls.some((call) => /vault\.(process|modify|create|append)/.test(call))).toBe(false);
    expect(plugin.saved).toEqual([]);
  });

  it('shows the deck tree with Due / New / Total, untagged cards and conflicting duplicate IDs', async () => {
    const { plugin } = setup();
    await openPicker(plugin);
    expect(rows()).toEqual([
      '全デッキ | Due 0 · New 4 · Total 4',
      '医学 | Due 0 · New 3 · Total 3',
      '医学 › 生理 | Due 0 · New 2 · Total 2',
      '英語 | Due 0 · New 2 · Total 2',
    ]);
    expect(document.querySelector('.kioku-deck-allowance').textContent).toBe('今日の新規 残り 20 枚');
    expect(document.querySelector('.kioku-deck-untagged').textContent).toContain('デッキに属していないカード 1 枚（トリガータグ #kioku');
    expect(document.querySelector('.kioku-deck-conflict').textContent)
      .toBe('内容の異なる同じ ID（kioku-ffffffffff）のため出題しません：学習/衝突A.md / 学習/衝突B.md');
    expect(document.querySelector('.kioku-deck-data-note').textContent).toContain('「Kioku」フォルダ');
  });

  it('shows the trigger root when several trigger tags are set', async () => {
    const { plugin } = setup({ settings: { triggerTags: ['kioku', '英単語'] } });
    await openPicker(plugin);
    expect(rows().map((item) => item.split(' | ')[0])).toEqual(['全デッキ', 'kioku', 'kioku › 医学', 'kioku › 医学 › 生理', 'kioku › 英語']);
  });

  it('opens the status popup and extraction from its buttons', async () => {
    const { plugin } = setup();
    await openPicker(plugin);
    document.querySelector('.kioku-deck-picker-status').click();
    expect(picker()).toBeNull();
    expect(document.querySelector('.kioku-startup-modal .kioku-build-identity').dataset.kiokuBuildId).toBe('unit-build');
    document.querySelector('.kioku-startup-close').click();
    await openPicker(plugin);
    document.querySelector('.kioku-deck-picker-extract').click();
    expect(picker()).toBeNull();
    expect(notices).toEqual(['Kioku：Markdown ノートを開いてから実行してください。']);
  });
});

describe('review session', () => {
  it('question → Space → 3 appends exactly one verified history line, then state.json; notes never change', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    expect(phase()).toBe('question');
    // New cards in path order (学習/両方 < 学習/生理 < 学習/英語), then occurrence order.
    expect(question()).toBe('both');
    expect(document.querySelector('.kioku-review-remaining').textContent).toBe('残り 4 枚');
    expect(document.querySelector('.kioku-review-answer')).toBeNull();
    key(' ');
    expect(phase()).toBe('answer');
    expect(document.querySelector('.kioku-review-answer').textContent).toBe('両方');
    expect([...document.querySelectorAll('.kioku-review-grade')].map((button) => button.textContent))
      .toEqual(['もう一度（1）· 1日', '難しい（2）· 2日', '普通（3）· 3日', '簡単（4）· 8日']);
    expect(document.activeElement.dataset.kiokuGrade).toBe('3');
    key('3');
    await settle();
    expect(historyLines(adapter)).toEqual([expect.objectContaining({ cardId: 'kioku-dddddddddd', grade: 3, day: '2026-10-02',
      dueDay: '2026-10-05', phaseBefore: 'new', scheduler: 'ts-fsrs@5.4.2' })]);
    expect(historyLines(adapter)[0].eventId).toMatch(/^kioku-dddddddddd:[0-9a-z]{10}$/);
    expect(JSON.parse(adapter.files.get(S)).cards['kioku-dddddddddd'].dueDay).toBe('2026-10-05');
    expect(adapter.writes()).toEqual(['mkdir:Kioku', `write:${H}`, `write:${S}`]);
    expect(phase()).toBe('question');
    expect(question()).toBe('心拍数は？');
    expect(document.querySelector('.kioku-review-remaining').textContent).toBe('残り 3 枚');
    expect(Object.fromEntries([...adapter.files].filter(([path]) => path.endsWith('.md')))).toEqual(NOTES);
  });

  it('presents a card of two decks once per session and not again after rating it elsewhere', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin, '医学');
    const seen = [];
    while (phase() === 'question') { seen.push(question()); key(' '); key('3'); await settle(); }
    expect(seen).toEqual(['both', '心拍数は？', '図 [[heart.png]] は？']);
    expect(document.querySelector('.kioku-review-summary').textContent).toBe('評価 3 枚・スキップ 0 枚');
    document.querySelector('.kioku-review-back').click(); await settle();
    expect(rows()).toContain('英語 | Due 0 · New 1 · Total 2');
    row('全デッキ').click(); await settle();
    expect(question()).toBe('apple');
    expect(historyLines(adapter)).toHaveLength(3);
  });

  it('hides embeds until the answer is shown and unloads every render component on close', async () => {
    const { plugin } = setup();
    await startDeck(plugin, '医学 › 生理');
    key('s'); // skip to the card with the embed
    expect(renders.at(-1)).toMatchObject({ markdown: '図 [[heart.png]] は？', sourcePath: '学習/生理.md' });
    key('Enter');
    expect(renders.slice(-2).map((item) => item.markdown)).toEqual(['図 ![[heart.png]] は？', '心臓']);
    expect(MockComponent.instances.length).toBeGreaterThan(0);
    key('Escape');
    expect(picker()).toBeNull();
    expect(MockComponent.instances.every((component) => component.unloaded)).toBe(true);
  });

  it('Skip (S) records nothing, leaves the session, and the card is back next time', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin, '医学 › 生理');
    key('s');
    expect(question()).toBe('図 [[heart.png]] は？');
    key(' '); key('S');
    expect(document.querySelector('.kioku-review-summary').textContent).toBe('評価 0 枚・スキップ 2 枚');
    expect(adapter.writes()).toEqual([]);
    document.querySelector('.kioku-review-back').click(); await settle();
    expect(rows()[2]).toBe('医学 › 生理 | Due 0 · New 2 · Total 2');
  });

  it('closing mid-session keeps only the rated cards; reopening shows them as not due', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    key(' '); key('4'); await settle();
    key(' ');
    document.querySelector('.kioku-deck-picker-modal').closest('div').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(picker()).toBeNull();
    expect(historyLines(adapter).map((line) => line.cardId)).toEqual(['kioku-dddddddddd']);
    await openPicker(plugin);
    expect(rows()[0]).toBe('全デッキ | Due 0 · New 3 · Total 4');
    expect(document.querySelector('.kioku-deck-allowance').textContent).toBe('今日の新規 残り 19 枚');
  });

  it('keeps the schedule after reload and shows the card as due on its day', async () => {
    const first = setup();
    await startDeck(first.plugin, '英語');
    key(' '); key('1'); await settle();
    const files = Object.fromEntries([...first.adapter.files].filter(([path]) => path.startsWith('Kioku/')));
    // A new plugin instance over the same files = Obsidian restart.
    vi.setSystemTime(new Date(2026, 9, 3, 9, 0));
    const second = setup({ kioku: files });
    await openPicker(second.plugin);
    expect(rows()).toContain('英語 | Due 1 · New 1 · Total 2');
  });
});

describe('keyboard safety', () => {
  it('ignores key repeat, IME composition and modifier chords', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    expect(key(' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(phase()).toBe('question');
    key(' ', { isComposing: true }); key('Process'); key(' ', { ctrlKey: true });
    expect(phase()).toBe('question');
    key(' ');
    key('3', { repeat: true });
    key('Enter', { isComposing: true });
    await settle();
    expect(phase()).toBe('answer');
    expect(adapter.writes()).toEqual([]);
  });

  it('a focused rating button activated by Space rates once (key path only; the native click is ignored)', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    key(' ');
    const good = document.activeElement;
    expect(good.dataset.kiokuGrade).toBe('3');
    const down = key(' ', {}, good);
    expect(down.defaultPrevented).toBe(true);
    // While saving, focus stays inside the modal (not on a removed button); keyup there is suppressed.
    expect(document.activeElement.classList.contains('kioku-review')).toBe(true);
    const up = new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    target().dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    good.click(); // a native activation that slipped through anyway
    await settle();
    expect(historyLines(adapter)).toHaveLength(1);
    expect(historyLines(adapter)[0].grade).toBe(3);
    expect(phase()).toBe('question');
  });

  it('ignores clicks on buttons of an earlier card', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    key(' ');
    const oldGood = document.activeElement;
    const oldSkip = document.querySelector('.kioku-review-skip');
    key('3'); await settle();
    key(' ');
    expect(phase()).toBe('answer');
    expect(question()).toBe('心拍数は？');
    oldGood.click(); oldSkip.click(); await settle();
    expect(historyLines(adapter)).toHaveLength(1);
    expect(phase()).toBe('answer');
    expect(question()).toBe('心拍数は？');
  });

  it('ignores ratings, skips and reveals while saving; disables the buttons', async () => {
    const { adapter, plugin } = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const write = adapter.write.bind(adapter);
    adapter.write = async (path, data) => { if (path === H) await gate; return write(path, data); };
    await startDeck(plugin);
    key(' '); key('2');
    await settle();
    expect(phase()).toBe('saving');
    expect([...document.querySelectorAll('.kioku-review-grade, .kioku-review-skip')].every((button) => button.disabled)).toBe(true);
    key('3'); key('1'); key('s'); key(' '); key('Enter');
    document.querySelector('.kioku-review-grade').click();
    release(); await settle();
    expect(historyLines(adapter).map((line) => line.grade)).toEqual([2]);
    expect(phase()).toBe('question');
    expect(question()).toBe('心拍数は？');
  });

  it('retries a failed save with the same event (same eventId), never as a new rating', async () => {
    const { adapter, plugin } = setup();
    let fail = true;
    let attempted = null;
    adapter.hooks.write = (path, data) => { if (path === H && fail) { attempted = JSON.parse(data); throw new Error('EIO'); } };
    await startDeck(plugin);
    key(' '); key('3'); await settle();
    expect(phase()).toBe('failed');
    expect(document.querySelector('.kioku-review-message').textContent).toBe('評価を保存できませんでした：記録ファイルに書き込めませんでした（EIO）。');
    key('1'); key('s');
    expect(phase()).toBe('failed');
    fail = false;
    expect(document.querySelector('.kioku-review-back').disabled).toBe(true);
    expect(document.activeElement.classList.contains('kioku-review-retry')).toBe(true);
    key('Enter'); await settle();
    const lines = historyLines(adapter);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(attempted);
    expect(phase()).toBe('question');
  });

  it('notifies once when closed while a save fails', async () => {
    const { adapter, plugin } = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    adapter.hooks.write = () => {};
    const write = adapter.write.bind(adapter);
    adapter.write = async (path, data) => { if (path === H) { await gate; throw new Error('EIO'); } return write(path, data); };
    await startDeck(plugin);
    key(' '); key('3'); await settle();
    key('Escape');
    release(); await settle();
    expect(notices).toEqual(['Kioku：保存中に閉じた評価を保存できませんでした。次に開いたとき、その評価が反映されているか確認してください。（記録ファイルに書き込めませんでした（EIO）。）']);
  });
});

describe('new-card limit', () => {
  it('stops at the daily limit, shows 残りは明日以降, and 今日だけ あと10枚 continues the same deck', async () => {
    const { adapter, plugin } = setup({ settings: { newPerDay: 2 } });
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-allowance').textContent).toBe('今日の新規 残り 2 枚');
    expect(rows()[0]).toBe('全デッキ | Due 0 · New 4 · Total 4 | later');
    row('全デッキ').click(); await settle();
    for (let index = 0; index < 2; index += 1) { key(' '); key('3'); await settle(); }
    expect(phase()).toBe('done');
    expect(document.querySelector('.kioku-review-held').textContent).toBe('今日の新規の上限に達しました。新規 2 枚は明日以降に出題されます。');
    expect([...document.querySelectorAll('.kioku-review-extra')].map((button) => button.textContent)).toEqual(['今日だけ あと10枚', '今日だけ あと20枚']);
    const extra = document.querySelector('.kioku-review-extra');
    extra.click(); extra.click();
    await settle();
    expect(JSON.parse(adapter.files.get(S)).today).toEqual({ day: '2026-10-02', newIntroduced: 2, extraNew: 10 });
    expect(phase()).toBe('question');
    expect(question()).toBe('図 [[heart.png]] は？');
  });

  it('resets 今日だけ追加 on the next Kioku day (04:00 local)', async () => {
    const kioku = { [S]: JSON.stringify({ schemaVersion: 1, cards: {}, today: { day: '2026-10-02', newIntroduced: 2, extraNew: 10 }, applied: {} }) };
    vi.setSystemTime(new Date(2026, 9, 3, 3, 59));
    let vault = setup({ kioku, settings: { newPerDay: 2 } });
    await openPicker(vault.plugin);
    expect(document.querySelector('.kioku-deck-allowance').textContent).toBe('今日の新規 残り 10 枚');
    document.querySelector('.kioku-deck-picker-close').click();
    vi.setSystemTime(new Date(2026, 9, 3, 4, 0));
    vault = setup({ kioku, settings: { newPerDay: 2 } });
    await openPicker(vault.plugin);
    expect(document.querySelector('.kioku-deck-allowance').textContent).toBe('今日の新規 残り 2 枚');
  });
});

describe('review edge cases', () => {
  it('does not rate across the day boundary: the session is reloaded for the new day', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    key(' ');
    vi.setSystemTime(new Date(2026, 9, 3, 4, 1));
    key('3'); await settle();
    expect(notices).toEqual(['Kioku：日付が変わったため、評価せずにデッキ選択を読み直しました。']);
    expect(adapter.writes()).toEqual([]);
    expect(document.querySelector('.kioku-deck-list')).not.toBeNull();
  });

  it('hides Markdown image embeds too before the answer is shown', async () => {
    const notes = { 'a.md': '#kioku\nQ: 図 ![図](answer.png) と ![[x.png]]\nA: y ^kioku-gggggggggg\n' };
    const { plugin } = setup({ notes });
    await startDeck(plugin);
    expect(question()).toBe('図 [図](answer.png) と [[x.png]]');
    key(' ');
    expect(question()).toBe('図 ![図](answer.png) と ![[x.png]]');
  });

  it('skips adopted blocks whose ID is not a usable card ID and says so', async () => {
    const notes = { 'a.md': '#kioku\nQ: bad\nA: x ^kioku-\n\nQ: good\nA: y ^kioku-gggggggggg\n' };
    const { plugin } = setup({ notes });
    await openPicker(plugin);
    expect(rows()[0]).toBe('全デッキ | Due 0 · New 1 · Total 1');
    expect(document.querySelector('.kioku-deck-invalid-id').textContent).toBe('カード ID として使えない ID（^kioku-）のため出題しません：a.md');
  });

  it('refuses to open with an unusable data folder in data.json instead of starting an empty one', async () => {
    const { adapter, plugin } = setup({ settings: { dataFolder: '../outside' } });
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-problem').textContent).toMatch(/読み込めませんでした（設定の学習データのフォルダ/);
    expect(document.querySelector('.kioku-deck-row')).toBeNull();
    const settingTab = plugin.settingTabs[0]; document.body.append(settingTab.containerEl); settingTab.display(); await settle();
    expect(settingTab.containerEl.textContent).toContain('上書きしないよう変更できません');
    expect(plugin.saved).toEqual([]);
    expect(adapter.writes()).toEqual([]);
  });
});

describe('storage safety in the UI', () => {
  it('is read-only with an unreadable state.json: shows why, disables rating, writes nothing', async () => {
    const { adapter, plugin } = setup({ kioku: { [S]: '{broken' } });
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-problem').textContent).toMatch(/Kioku\/state\.json を読めません/);
    row('全デッキ').click(); await settle();
    expect(document.querySelector('.kioku-review-readonly')).not.toBeNull();
    key(' ');
    expect([...document.querySelectorAll('.kioku-review-grade')].every((button) => button.disabled)).toBe(true);
    key('3'); await settle();
    expect(phase()).toBe('answer');
    expect(adapter.writes()).toEqual([]);
    expect(adapter.files.get(S)).toBe('{broken');
  });

  it('offers the truncated-line repair only on confirmation, then continues', async () => {
    const cut = '{"v":1,"eventId":"kioku-aaaaaaaaaa:0000';
    const { adapter, plugin } = setup({ kioku: { [H]: cut } });
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-problem').textContent).toContain('最終行（1 行目）が途中で切れています');
    expect(adapter.writes()).toEqual([]);
    document.querySelector('.kioku-deck-repair').click(); await settle();
    expect(adapter.files.get('Kioku/history-2026.jsonl.broken')).toBe(`${cut}\n`);
    expect(adapter.files.get(H)).toBe('');
    expect(document.querySelector('.kioku-deck-problem')).toBeNull();
    expect(notices).toEqual(['Kioku：不完全な最終行を退避しました。']);
  });
});

describe('settings tab', () => {
  const tab = (plugin) => { const settingTab = plugin.settingTabs[0]; document.body.append(settingTab.containerEl); settingTab.display(); return settingTab; };
  const field = (name) => [...document.querySelectorAll('.setting-item')].find((item) => item.querySelector('.setting-item-name').textContent === name);
  const input = (element, value) => { element.value = value; element.dispatchEvent(new window.Event('input')); };

  it('saves trigger tags, limit, day start, and guards the data folder change', async () => {
    const { adapter, plugin } = setup({ kioku: { [H]: '' , 'Moved/state.json': '{}' } });
    tab(plugin); await settle();
    input(field('トリガータグ').querySelector('input'), '#Kioku, 英単語, 123');
    await settle();
    expect(plugin.data.triggerTags).toEqual(['Kioku', '英単語']);
    input(field('トリガータグ').querySelector('input'), '123');
    await settle();
    expect(field('トリガータグ').querySelector('.kioku-settings-status').textContent).toContain('タグを1つ以上');
    expect(plugin.data.triggerTags).toEqual(['Kioku', '英単語']);
    input(field('1日の新規カード数').querySelector('input.mock-text'), '35'); await settle();
    expect(plugin.data.newPerDay).toBe(35);
    const toggle = field('1日の新規カード数').querySelector('input.mock-toggle');
    toggle.checked = true; toggle.dispatchEvent(new window.Event('change')); await settle();
    expect(plugin.data.newPerDay).toBeNull();
    const hour = field('日付の切り替え時刻').querySelector('select');
    hour.value = '5'; hour.dispatchEvent(new window.Event('change')); await settle();
    expect(plugin.data.dayStartHour).toBe(5);

    const folder = field('学習データのフォルダ');
    input(folder.querySelector('input'), 'Empty');
    folder.querySelector('button').click(); await settle();
    expect(folder.querySelector('.kioku-settings-status').textContent).toBe('古いフォルダ（Kioku）にデータがあります。移動してから変更してください。');
    expect(plugin.data.dataFolder).toBe('Kioku');
    input(folder.querySelector('input'), '../x');
    folder.querySelector('button').click(); await settle();
    expect(plugin.data.dataFolder).toBe('Kioku');
    input(folder.querySelector('input'), 'Moved/');
    folder.querySelector('button').click(); await settle();
    expect(plugin.data.dataFolder).toBe('Moved');
    expect(adapter.writes()).toEqual([]);
  });
});
