// Real plugin source bundled against public-API doubles (jsdom). Proves the review/storage
// contract (no write on open, one history line per rating, keyboard safety), not native behaviour.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockComponent, compilePlugin, createApp, installDom, renders } from '../helpers/obsidian-mock.mjs';
import { FakeAdapter } from '../helpers/fake-adapter.mjs';

const NOTES = {
  '学習/生理.md': '#kioku/医学/生理\nQ: 心拍数は？\nA: 約60 ^kioku-aaaaaaaaaa\n\nQ: 図 ![[heart.png]] は？\nA: 心臓 ^kioku-bbbbbbbbbb\n',
  '学習/英語.md': '---\ntags: [Kioku/英語]\n---\nQ: apple\nA: りんご ^kioku-cccccccccc\n',
  '学習/両方.md': '#kioku #kioku/医学 #kioku/英語\nQ: both\nA: 両方 ^kioku-dddddddddd\n',
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
/** Each row as "#tag | 新規 n · 学習中 n · 復習 n", plus " | later" when new cards are held back for today. */
const rows = () => [...document.querySelectorAll('.kioku-deck-row')].map((row) =>
  `${row.querySelector('.kioku-deck-name').textContent} | ${[...row.querySelectorAll('.kioku-deck-count')]
    .map((count, index) => `${['新規', '学習中', '復習'][index]} ${count.textContent}`).join(' · ')}${row.dataset.kiokuLater ? ' | later' : ''}`);
const row = (name) => [...document.querySelectorAll('.kioku-deck-row')].find((item) => item.querySelector('.kioku-deck-name').textContent === name);
const phase = () => document.querySelector('.kioku-review')?.dataset.kiokuPhase;
/** Grade buttons as "label key interval" (each part is its own element). */
const grades = () => [...document.querySelectorAll('.kioku-review-grade')].map((button) =>
  ['.kioku-review-grade-label', '.kioku-review-key', '.kioku-review-interval'].map((part) => button.querySelector(part).textContent).join(' '));
const primaries = () => [...document.querySelectorAll('.kioku-review .mod-cta')].map((button) => button.className);
const question = () => document.querySelector('.kioku-review-question')?.textContent;
const historyLines = (adapter) => (adapter.files.get(H) ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const target = () => document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('.kioku-review');
function key(value, init = {}, element = target()) {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}
const backToPicker = () => {
  // The header's ← works on every screen (the done screen also has its own button).
  document.querySelector('.kioku-review-back-button').click();
};
async function openPicker(plugin) { plugin.ribbons[0].click(); await settle(); }
async function startDeck(plugin, name = '#kioku') { await openPicker(plugin); row(name).click(); await settle(); }

/** A hand-made schedule (Kioku's FSRS settings never produce learning / relearning by rating). */
const schedule = (phase, dueDay, lastReviewDay) => ({ phase, dueDay, stability: 2, difficulty: 5, reps: 2, lapses: phase === 'relearning' ? 1 : 0, lastReviewDay });
const stateWith = (cards) => ({ [S]: JSON.stringify({ schemaVersion: 1, cards, today: null, applied: {} }) });
const progress = () => document.querySelector('.kioku-review-progress-count')?.textContent;
const moreMenu = () => [...document.querySelectorAll('.menu .menu-item')];

describe('deck picker (ribbon)', () => {
  it('opens centred with the build identity and writes nothing on open, close or Escape (no Kioku folder)', async () => {
    const { app, adapter, plugin } = setup();
    await openPicker(plugin);
    expect(picker().dataset).toMatchObject({ kiokuVersion: '0.0.1', kiokuBuildId: 'unit-build' });
    // Obsidian's × closes it; there is no extra close button.
    picker().querySelector('.modal-header-button').click();
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

  it('keeps only the title and ⋯ in the header; the allowance, the data-folder note and the old buttons are gone', async () => {
    const { plugin } = setup();
    await openPicker(plugin);
    const header = picker().querySelector('.kioku-modal-header');
    expect(header.textContent).toBe('デッキ');
    const title = header.querySelector('.kioku-deck-title');
    expect([title.getAttribute('role'), title.getAttribute('aria-level')]).toEqual(['heading', '2']);
    const more = header.querySelector('.kioku-deck-more');
    expect([more.dataset.icon, more.classList.contains('clickable-icon'), more.getAttribute('aria-label')])
      .toEqual(['more-horizontal', true, 'その他の操作']);
    // ⋯ sits just before the space kept for Obsidian's ×.
    expect([...header.querySelector('.kioku-modal-header-end').children].map((element) => element.className))
      .toEqual(['clickable-icon kioku-deck-more', 'kioku-modal-close-space']);
    expect(picker().textContent).not.toMatch(/今日の新規|フォルダに保存|全デッキ|すべて/);
    expect(picker().querySelectorAll('.kioku-deck-allowance, .kioku-deck-data-note, .kioku-deck-footer, .kioku-deck-picker-close')).toHaveLength(0);
    expect(document.activeElement).toBe(document.querySelector('.kioku-deck-row'));
  });

  it('lists the written tags flat with 新規 / 学習中 / 復習 columns, untagged cards and conflicting duplicate IDs', async () => {
    const { plugin } = setup();
    await openPicker(plugin);
    expect(rows()).toEqual([
      '#kioku | 新規 4 · 学習中 0 · 復習 0',
      '#医学 | 新規 3 · 学習中 0 · 復習 0',
      '#医学/生理 | 新規 2 · 学習中 0 · 復習 0',
      '#英語 | 新規 2 · 学習中 0 · 復習 0',
    ]);
    const columns = document.querySelector('.kioku-deck-columns');
    expect([...columns.children].map((column) => [column.className, column.textContent])).toEqual([
      ['', ''], ['kioku-deck-column mod-new', '新規'], ['kioku-deck-column mod-learning', '学習中'], ['kioku-deck-column mod-due', '復習']]);
    expect(columns.getAttribute('aria-hidden')).toBe('true');
    expect([...row('#医学').querySelectorAll('.kioku-deck-count')].map((count) => count.className))
      .toEqual(['kioku-deck-count mod-new', 'kioku-deck-count mod-learning is-zero', 'kioku-deck-count mod-due is-zero']);
    expect(row('#医学').getAttribute('aria-label')).toBe('#医学：新規 3 枚、学習中 0 枚、復習 0 枚');
    expect(document.querySelector('.kioku-deck-untagged').textContent).toContain('デッキに属していないカード 1 枚（トリガータグ #kioku');
    expect(document.querySelector('.kioku-deck-conflict').textContent)
      .toBe('内容の異なる同じ ID（kioku-ffffffffff）のため出題しません：学習/衝突A.md / 学習/衝突B.md');
  });

  it('lists only tags written on a note (no implied parent, no union row), and every card is reachable from a row', async () => {
    const notes = {
      'a.md': '#kioku/医学/生理\nQ: a\nA: a ^kioku-aaaaaaaaaa\n',
      'b.md': '#kioku/英語/動詞 #kioku/英語\nQ: b\nA: b ^kioku-bbbbbbbbbb\n',
      'c.md': '#Kioku/英語/名詞\nQ: c\nA: c ^kioku-cccccccccc\n',
    };
    const { plugin } = setup({ notes });
    await openPicker(plugin);
    expect(rows()).toEqual([
      '#医学/生理 | 新規 1 · 学習中 0 · 復習 0',
      // A written parent still includes its children's cards (Q1).
      '#英語 | 新規 2 · 学習中 0 · 復習 0',
      '#英語/動詞 | 新規 1 · 学習中 0 · 復習 0',
      '#英語/名詞 | 新規 1 · 学習中 0 · 復習 0',
    ]);
    const seen = new Set();
    for (const name of ['#医学/生理', '#英語', '#英語/動詞', '#英語/名詞']) {
      row(name).click(); await settle();
      while (phase() === 'question') { seen.add(question()); key('s'); }
      backToPicker(); await settle();
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('shows the trigger tag in the titles when several trigger tags are set', async () => {
    const { plugin } = setup({ settings: { triggerTags: ['kioku', '英単語'] } });
    await openPicker(plugin);
    expect(rows().map((item) => item.split(' | ')[0])).toEqual(['#kioku', '#kioku/医学', '#kioku/医学/生理', '#kioku/英語']);
  });

  it('counts learning / relearning cards due today as 学習中, apart from 復習; the columns add up to the session', async () => {
    const kioku = stateWith({
      'kioku-aaaaaaaaaa': schedule('learning', '2026-10-02', '2026-10-01'),
      'kioku-bbbbbbbbbb': schedule('relearning', '2026-09-30', '2026-09-29'),
      'kioku-cccccccccc': schedule('review', '2026-10-01', '2026-09-20'),
      // Not due yet: in no column.
      'kioku-dddddddddd': schedule('learning', '2026-10-05', '2026-10-01'),
    });
    const { adapter, plugin } = setup({ kioku });
    await openPicker(plugin);
    expect(rows()).toEqual([
      '#kioku | 新規 0 · 学習中 2 · 復習 1',
      '#医学 | 新規 0 · 学習中 2 · 復習 0',
      '#医学/生理 | 新規 0 · 学習中 2 · 復習 0',
      '#英語 | 新規 0 · 学習中 0 · 復習 1',
    ]);
    row('#kioku').click(); await settle();
    expect(progress()).toBe('1/3');
    const seen = [];
    while (phase() === 'question') { seen.push(question()); key('s'); }
    // Oldest due day first (relearning 09-30, review 10-01, learning 10-02).
    expect(seen).toEqual(['図 [[heart.png]] は？', 'apple', '心拍数は？']);
    expect(adapter.writes()).toEqual([]);
  });

  it('⋯ offers extraction, the status popup and where the records are kept', async () => {
    const { adapter, plugin } = setup();
    await openPicker(plugin);
    document.querySelector('.kioku-deck-more').click();
    expect(moreMenu().map((item) => item.textContent)).toEqual(['問い・答えの候補を抽出', '状態', '記録の保存先について']);
    moreMenu()[2].click();
    expect(notices).toEqual(['学習の記録と日程は Vault の「Kioku」フォルダに保存されます（最初の評価で作成）。このフォルダを削除・移動すると記録が失われます。']);
    expect(picker()).not.toBeNull();
    document.querySelector('.kioku-deck-more').click();
    moreMenu()[1].click();
    expect(picker()).toBeNull();
    expect(document.querySelector('.kioku-startup-modal .kioku-build-identity').dataset.kiokuBuildId).toBe('unit-build');
    document.querySelector('.kioku-startup-close').click();
    await openPicker(plugin);
    document.querySelector('.kioku-deck-more').click();
    moreMenu()[0].click();
    expect(picker()).toBeNull();
    expect(notices.at(-1)).toBe('Kioku：Markdown ノートを開いてから実行してください。');
    expect(adapter.writes()).toEqual([]);
  });
});

describe('review session', () => {
  it('question → Space → 3 appends exactly one verified history line, then state.json; notes never change', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin);
    expect(phase()).toBe('question');
    // New cards in path order (学習/両方 < 学習/生理 < 学習/英語), then occurrence order.
    expect(question()).toBe('both');
    expect(progress()).toBe('1/4');
    expect(document.querySelector('.kioku-review-answer')).toBeNull();
    key(' ');
    expect(phase()).toBe('answer');
    expect(document.querySelector('.kioku-review-answer').textContent).toBe('両方');
    expect(grades()).toEqual(['もう一度 1 1日', '難しい 2 2日', '普通 3 3日', '簡単 4 8日']);
    expect(document.activeElement.dataset.kiokuGrade).toBe('3');
    key('3');
    await settle();
    expect(historyLines(adapter)).toEqual([expect.objectContaining({ cardId: 'kioku-dddddddddd', grade: 3, day: '2026-10-02',
      dueDay: '2026-10-05', phaseBefore: 'new', scheduler: 'ts-fsrs@5.4.2' })]);
    expect(historyLines(adapter)[0].eventId).toMatch(/^kioku-dddddddddd:[0-9a-z]{10}$/);
    expect(JSON.parse(adapter.files.get(S)).cards['kioku-dddddddddd'].dueDay).toBe('2026-10-05');
    expect(adapter.writes()).toEqual(['mkdir:Kioku', `append:${H}`, 'write:Kioku/state.json.tmp', 'rename:Kioku/state.json.tmp->Kioku/state.json']);
    expect(phase()).toBe('question');
    expect(question()).toBe('心拍数は？');
    expect(progress()).toBe('2/4');
    expect(Object.fromEntries([...adapter.files].filter(([path]) => path.endsWith('.md')))).toEqual(NOTES);
  });

  it('presents a card of two decks once per session and not again after rating it elsewhere', async () => {
    const { adapter, plugin } = setup();
    await startDeck(plugin, '#医学');
    const seen = [];
    while (phase() === 'question') { seen.push(question()); key(' '); key('3'); await settle(); }
    expect(seen).toEqual(['both', '心拍数は？', '図 [[heart.png]] は？']);
    expect(document.querySelector('.kioku-review-summary').textContent).toBe('評価 3 枚・スキップ 0 枚');
    backToPicker(); await settle();
    expect(rows()).toContain('#英語 | 新規 1 · 学習中 0 · 復習 0');
    row('#kioku').click(); await settle();
    expect(question()).toBe('apple');
    expect(historyLines(adapter)).toHaveLength(3);
  });

  it('hides embeds until the answer is shown and unloads every render component on close', async () => {
    const { plugin } = setup();
    await startDeck(plugin, '#医学/生理');
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
    await startDeck(plugin, '#医学/生理');
    key('s');
    expect(question()).toBe('図 [[heart.png]] は？');
    key(' '); key('S');
    expect(document.querySelector('.kioku-review-summary').textContent).toBe('評価 0 枚・スキップ 2 枚');
    expect(adapter.writes()).toEqual([]);
    backToPicker(); await settle();
    expect(rows()[2]).toBe('#医学/生理 | 新規 2 · 学習中 0 · 復習 0');
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
    expect(rows()[0]).toBe('#kioku | 新規 3 · 学習中 0 · 復習 0');
  });

  it('keeps the schedule after reload and shows the card as due on its day', async () => {
    const first = setup();
    await startDeck(first.plugin, '#英語');
    key(' '); key('1'); await settle();
    const files = Object.fromEntries([...first.adapter.files].filter(([path]) => path.startsWith('Kioku/')));
    // A new plugin instance over the same files = Obsidian restart.
    vi.setSystemTime(new Date(2026, 9, 3, 9, 0));
    const second = setup({ kioku: files });
    await openPicker(second.plugin);
    expect(rows()).toContain('#英語 | 新規 1 · 学習中 0 · 復習 1');
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
    document.querySelector('.kioku-review-gear-button').click();
    const oldSkip = document.querySelector('.kioku-review-skip');
    const oldBack = document.querySelector('.kioku-review-back-button');
    key('Escape');
    key('3'); await settle();
    key(' ');
    expect(phase()).toBe('answer');
    expect(question()).toBe('心拍数は？');
    oldGood.click(); oldSkip.click(); oldBack.click(); await settle();
    expect(historyLines(adapter)).toHaveLength(1);
    expect(phase()).toBe('answer');
    expect(question()).toBe('心拍数は？');
  });

  it('ignores ratings, skips and reveals while saving; disables the buttons', async () => {
    const { adapter, plugin } = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const append = adapter.append.bind(adapter);
    adapter.append = async (path, data) => { if (path === H) await gate; return append(path, data); };
    await startDeck(plugin);
    key(' '); key('2');
    await settle();
    expect(phase()).toBe('saving');
    expect([...document.querySelectorAll('.kioku-review-grade, .kioku-review-back-button')].every((button) => button.disabled)).toBe(true);
    key('3'); key('1'); key('s'); key(' '); key('Enter');
    document.querySelector('.kioku-review-grade').click();
    document.querySelector('.kioku-review-back-button').click();
    document.querySelector('.kioku-review-gear-button').click();
    expect(document.querySelector('.kioku-review-skip').disabled).toBe(true);
    document.querySelector('.kioku-review-skip').click();
    release(); await settle();
    expect(historyLines(adapter).map((line) => line.grade)).toEqual([2]);
    expect(phase()).toBe('question');
    expect(question()).toBe('心拍数は？');
  });

  it('retries a failed save with the same event (same eventId), never as a new rating', async () => {
    const { adapter, plugin } = setup();
    let fail = true;
    let attempted = null;
    adapter.hooks.append = (path, data) => { if (path === H && fail) { attempted = JSON.parse(data); throw new Error('EIO'); } };
    await startDeck(plugin);
    key(' '); key('3'); await settle();
    expect(phase()).toBe('failed');
    expect(document.querySelector('.kioku-review-message').textContent).toBe('評価を保存できませんでした：記録ファイルに書き込めませんでした（EIO）。');
    key('1'); key('s');
    expect(phase()).toBe('failed');
    fail = false;
    const gearButton = document.querySelector('.kioku-review-gear-button');
    expect(gearButton).toBeTruthy();
    gearButton.click();
    expect([...document.querySelectorAll('.kioku-review-menu-item')].map((item) => item.disabled)).toEqual([true, true, true]);
    expect(phase()).toBe('failed');
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
    const append = adapter.append.bind(adapter);
    adapter.append = async (path, data) => { if (path === H) { await gate; throw new Error('EIO'); } return append(path, data); };
    await startDeck(plugin);
    key(' '); key('3'); await settle();
    key('Escape');
    release(); await settle();
    expect(notices).toEqual(['Kioku：保存中に閉じた評価を保存できませんでした。次に開いたとき、その評価が反映されているか確認してください。（記録ファイルに書き込めませんでした（EIO）。）']);
  });
});

describe('review screen layout', () => {
  const classes = (element) => [...element.children].map((child) => child.className);

  it('header: ← | the deck tag and progress | gear, then the space of Obsidian\'s ×; no remaining-count text', async () => {
    const { plugin } = setup();
    await startDeck(plugin, '#英語');
    expect(picker().classList.contains('kioku-is-reviewing')).toBe(true);
    const header = document.querySelector('.kioku-review-header');
    expect(classes(header)).toEqual(['kioku-modal-header-start', 'kioku-review-progress', 'kioku-modal-header-end']);
    const back = header.querySelector('.kioku-review-back-button');
    expect([back.dataset.icon, back.classList.contains('clickable-icon'), back.getAttribute('aria-label')])
      .toEqual(['arrow-left', true, 'デッキに戻る']);
    const pill = header.querySelector('.kioku-review-progress');
    expect(classes(pill)).toEqual(['kioku-review-progress-deck', 'kioku-review-progress-separator', 'kioku-review-progress-count']);
    expect(pill.textContent).toBe('#英語1/2');
    expect(pill.getAttribute('aria-label')).toBe('#英語：1 / 2 枚');
    expect(pill.querySelector('.kioku-review-progress-icon').dataset.icon).toBe('gallery-vertical-end');
    expect(header.textContent).not.toMatch(/残り/);
    const end = header.querySelector('.kioku-modal-header-end');
    expect(classes(end)).toEqual(['kioku-review-gear-wrapper', 'kioku-modal-close-space']);
    const gear = end.querySelector('.kioku-review-gear-button');
    expect(gear.dataset.icon).toBe('settings');
    expect(gear.querySelector('svg')).not.toBeNull();
    expect(gear.classList.contains('clickable-icon')).toBe(true);
    expect(gear.getAttribute('aria-label')).toBe('メニュー');
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    expect(gear.classList.contains('is-active')).toBe(false);
    gear.click();
    const open = document.querySelector('.kioku-review-gear-button');
    expect([open.getAttribute('aria-expanded'), open.classList.contains('is-active')]).toEqual(['true', true]);
    key('Escape');
    key('s');
    expect(progress()).toBe('2/2');
    back.click();
    expect(progress()).toBe('2/2');
    document.querySelector('.kioku-review-back-button').click(); await settle();
    expect(document.querySelector('.kioku-review')).toBeNull();
    expect(picker().classList.contains('kioku-is-reviewing')).toBe(false);
    expect(document.querySelector('.kioku-deck-list')).not.toBeNull();
  });

  it('body: 問題 / question, then a divider, 答え / answer; the footer below holds the reveal or the grades', async () => {
    const { plugin } = setup();
    await startDeck(plugin);
    const screen = document.querySelector('.kioku-review');
    expect(classes(screen)).toEqual(['kioku-modal-header kioku-review-header', 'kioku-review-body', 'kioku-review-footer']);
    const body = document.querySelector('.kioku-review-body');
    expect(classes(body)).toEqual(['kioku-review-qa-label', 'kioku-review-question markdown-rendered']);
    expect(body.firstChild.textContent).toBe('問題');
    expect(classes(document.querySelector('.kioku-review-footer'))).toEqual(['mod-cta kioku-review-reveal']);
    key(' ');
    expect(classes(body.isConnected ? body : document.querySelector('.kioku-review-body'))).toEqual(['kioku-review-qa-label',
      'kioku-review-question markdown-rendered', 'kioku-review-divider', 'kioku-review-qa-label', 'kioku-review-answer markdown-rendered']);
    expect([...document.querySelectorAll('.kioku-review-qa-label')].map((label) => label.textContent)).toEqual(['問題', '答え']);
    expect(classes(document.querySelector('.kioku-review-footer'))).toEqual(['kioku-review-grades']);
  });

  it('drops the menu on the done screen, where its items would have no card to act on', async () => {
    const { plugin } = setup();
    await startDeck(plugin, '#英語');
    key('s'); key('s');
    expect(phase()).toBe('done');
    expect(progress()).toBe('2/2');
    expect(document.querySelector('.kioku-review-gear-button')).toBeNull();
    expect(document.querySelector('.kioku-review-back-button').disabled).toBe(false);
    expect(document.activeElement.classList.contains('kioku-review-back')).toBe(true);
    key('Escape');
    expect(picker()).toBeNull();
  });

  it('shows every shortcut as the same badge; one mod-cta at most, colored grades instead of a primary grade', async () => {
    const { adapter, plugin } = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const append = adapter.append.bind(adapter);
    adapter.append = async (path, data) => { if (path === H) { await gate; throw new Error('EIO'); } return append(path, data); };
    await startDeck(plugin);
    const shortcut = (button) => {
      const badge = button.querySelector('.kioku-review-key');
      return { key: badge.textContent, hidden: badge.getAttribute('aria-hidden'), keyshortcuts: button.getAttribute('aria-keyshortcuts') };
    };
    const skip = () => {
      if (!document.querySelector('.kioku-review-skip')) document.querySelector('.kioku-review-gear-button').click();
      const item = document.querySelector('.kioku-review-skip');
      key('Escape');
      return item;
    };
    expect(shortcut(skip())).toEqual({ key: 'S', hidden: 'true', keyshortcuts: 'S' });
    expect(shortcut(document.querySelector('.kioku-review-reveal'))).toEqual({ key: 'Space', hidden: 'true', keyshortcuts: 'Space' });
    expect(primaries()).toEqual(['mod-cta kioku-review-reveal']);
    expect(document.querySelector('.kioku-review-status')).toBeNull();

    // Focus is back on the gear after the menu closed, so Space goes to the screen itself.
    key(' ', {}, document.querySelector('.kioku-review'));
    expect([...document.querySelectorAll('.kioku-review-grade')].map((button) => shortcut(button)))
      .toEqual(['1', '2', '3', '4'].map((value) => ({ key: value, hidden: 'true', keyshortcuts: value })));
    expect([...document.querySelectorAll('.kioku-review-grade')].map((button) => button.dataset.kiokuGrade)).toEqual(['1', '2', '3', '4']);
    expect(shortcut(skip())).toEqual({ key: 'S', hidden: 'true', keyshortcuts: 'S' });
    expect(primaries()).toEqual([]);

    key('2'); await settle();
    expect(phase()).toBe('saving');
    expect(document.querySelector('.kioku-review-status .kioku-review-message').textContent).toBe('保存しています…');
    expect(primaries()).toEqual([]);

    release(); await settle();
    expect(phase()).toBe('failed');
    const status = document.querySelector('.kioku-review-status');
    expect(status.querySelector('.kioku-review-message').textContent).toBe('評価を保存できませんでした：記録ファイルに書き込めませんでした（EIO）。');
    expect(status.querySelector('.kioku-review-retry')).toBe(document.activeElement);
    // The status row sits under the grades, so starting a save does not move them.
    expect(classes(document.querySelector('.kioku-review-footer'))).toEqual(['kioku-review-grades', 'kioku-review-status']);
    expect(primaries()).toEqual(['mod-cta kioku-review-retry']);
    expect([...document.querySelectorAll('.kioku-review-grade, .kioku-review-back-button')].every((button) => button.disabled)).toBe(true);
    expect(skip().disabled).toBe(true);
  });
});

describe('gear menu', () => {
  const SKIP = 'スキップ';
  const OPEN_NOTE = '元のノートを開く';
  const BACK = 'デッキに戻る';
  const gear = () => document.querySelector('.kioku-review-gear-button');
  const menuItems = () => [...document.querySelectorAll('.kioku-review-menu-item')];
  /** The item's own label (スキップ also carries its key badge). */
  const label = (item) => item.childNodes[0].textContent;
  const menuItem = (text) => menuItems().find((item) => label(item) === text);
  const openedLinks = (app) => app.calls.filter((call) => call.startsWith('workspace.openLinkText:'));
  const ACTIVATE = {
    click: (element) => element.click(),
    Enter: (element) => { element.focus(); key('Enter', {}, element); },
    Space: (element) => { element.focus(); key(' ', {}, element); },
  };

  /**
   * Opens the first card (both / kioku-dddddddddd) and drives it to `state`. For `saving` the history
   * append waits on `finish()`; for `failed` it throws until `finish()`. Either way `attempted` is the
   * event the first save tried to write, so a later write can be compared with it.
   */
  async function reach(state) {
    const vault = setup();
    const result = { ...vault, attempted: null, finish: () => {} };
    if (state === 'saving') {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const append = vault.adapter.append.bind(vault.adapter);
      vault.adapter.append = async (path, data) => {
        if (path === H) { result.attempted ??= JSON.parse(data); await gate; }
        return append(path, data);
      };
      result.finish = release;
    }
    if (state === 'failed') {
      let fail = true;
      vault.adapter.hooks.append = (path, data) => {
        if (path === H && fail) { result.attempted = JSON.parse(data); throw new Error('EIO'); }
      };
      result.finish = () => { fail = false; };
    }
    await startDeck(vault.plugin);
    if (state !== 'question') key(' ');
    if (state === 'saving' || state === 'failed') { key('3'); await settle(); }
    expect(phase()).toBe(state);
    return result;
  }

  for (const state of ['saving', 'failed']) {
    for (const [how, activate] of Object.entries(ACTIVATE)) {
      for (const text of [SKIP, OPEN_NOTE, BACK]) {
        it(`${state}: ${text} by ${how} does not act, and the unsaved rating is still saved once`, async () => {
          const { app, adapter, attempted, finish } = await reach(state);
          gear().click();
          const item = menuItem(text);
          expect(item.disabled).toBe(true);
          activate(item);
          await settle();
          expect(picker()).not.toBeNull();
          expect(phase()).toBe(state);
          expect(document.querySelector('.kioku-deck-list')).toBeNull();
          expect(openedLinks(app)).toEqual([]);
          expect(historyLines(adapter)).toEqual([]);
          finish();
          if (state === 'failed') document.querySelector('.kioku-review-retry').click();
          await settle();
          expect(historyLines(adapter)).toEqual([attempted]);
          expect(attempted).toMatchObject({ cardId: 'kioku-dddddddddd', grade: 3 });
          expect(phase()).toBe('question');
          expect(question()).toBe('心拍数は？');
        });
      }
    }
  }

  for (const state of ['question', 'answer']) {
    for (const [how, activate] of Object.entries(ACTIVATE)) {
      it(`${state}: ${SKIP} by ${how} skips the card and closes the menu, writing nothing`, async () => {
        const { adapter } = await reach(state);
        gear().click();
        activate(menuItem(SKIP));
        await settle();
        expect(phase()).toBe('question');
        expect(question()).toBe('心拍数は？');
        expect(menuItems()).toEqual([]);
        expect(progress()).toBe('2/4');
        expect(adapter.writes()).toEqual([]);
      });

      it(`${state}: ${OPEN_NOTE} by ${how} closes the modal and opens the card's note, writing nothing`, async () => {
        const { app, adapter } = await reach(state);
        gear().click();
        activate(menuItem(OPEN_NOTE));
        await settle();
        expect(picker()).toBeNull();
        expect(openedLinks(app)).toEqual(['workspace.openLinkText:学習/両方.md#^kioku-dddddddddd||false']);
        expect(adapter.writes()).toEqual([]);
      });

      it(`${state}: ${BACK} by ${how} returns to the deck list, writing nothing`, async () => {
        const { app, adapter } = await reach(state);
        gear().click();
        activate(menuItem(BACK));
        await settle();
        expect(picker()).not.toBeNull();
        expect(document.querySelector('.kioku-review')).toBeNull();
        expect(rows()[0]).toBe('#kioku | 新規 4 · 学習中 0 · 復習 0');
        expect(openedLinks(app)).toEqual([]);
        expect(adapter.writes()).toEqual([]);
      });
    }
  }

  for (const how of ['Enter', 'Space']) {
    it(`${how} on the focused gear opens the menu (not the answer) and moves focus to its first item`, async () => {
      await reach('question');
      ACTIVATE[how](gear());
      expect(phase()).toBe('question');
      expect(menuItems().map(label)).toEqual([SKIP, OPEN_NOTE, BACK]);
      expect(menuItem(SKIP).querySelector('.kioku-review-key').textContent).toBe('S');
      expect(document.activeElement).toBe(menuItem(SKIP));
      ACTIVATE[how](gear());
      expect(menuItems()).toEqual([]);
      expect(document.activeElement).toBe(gear());
      expect(phase()).toBe('question');
    });
  }

  it('Tab reaches the menu items right after the gear (focusable buttons in order)', async () => {
    await reach('answer');
    gear().click();
    const focusable = [...document.querySelectorAll('.kioku-review button')].filter((button) => !button.disabled && button.tabIndex >= 0);
    const at = focusable.indexOf(gear());
    expect(at).toBeGreaterThanOrEqual(0);
    expect(focusable.slice(at + 1, at + 4)).toEqual([menuItem(SKIP), menuItem(OPEN_NOTE), menuItem(BACK)]);
  });

  for (const state of ['question', 'answer', 'saving', 'failed']) {
    it(`${state}: Escape with the menu open closes only the menu and returns focus to the gear`, async () => {
      const { adapter, attempted, finish } = await reach(state);
      gear().click();
      const from = menuItem(BACK).disabled ? gear() : menuItem(BACK);
      from.focus();
      const event = key('Escape', {}, from);
      expect(event.defaultPrevented).toBe(true);
      expect(picker()).not.toBeNull();
      expect(phase()).toBe(state);
      expect(menuItems()).toEqual([]);
      expect(document.activeElement).toBe(gear());
      // With the menu closed, Escape closes the modal as before.
      if (state === 'question' || state === 'answer') {
        key('Escape', {}, gear());
        expect(picker()).toBeNull();
        expect(adapter.writes()).toEqual([]);
        return;
      }
      finish();
      if (state === 'failed') document.querySelector('.kioku-review-retry').click();
      await settle();
      expect(historyLines(adapter)).toEqual([attempted]);
    });
  }
});

describe('new-card limit', () => {
  it('stops at the daily limit, shows 残りは明日以降, and 今日だけ あと10枚 continues the same deck', async () => {
    const { adapter, plugin } = setup({ settings: { newPerDay: 2 } });
    await openPicker(plugin);
    expect(rows()[0]).toBe('#kioku | 新規 4 · 学習中 0 · 復習 0 | later');
    expect(row('#kioku').dataset.kiokuLater).toBe('2');
    expect(row('#kioku').getAttribute('aria-label'))
      .toBe('#kioku：新規 4 枚、学習中 0 枚、復習 0 枚、今日の新規は残り 2 枚（残りは明日以降）');
    row('#kioku').click(); await settle();
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
    // Allowance 10 covers the 4 new cards.
    expect(row('#kioku').dataset.kiokuLater).toBeUndefined();
    picker().querySelector('.modal-header-button').click();
    vi.setSystemTime(new Date(2026, 9, 3, 4, 0));
    vault = setup({ kioku, settings: { newPerDay: 2 } });
    await openPicker(vault.plugin);
    expect(row('#kioku').dataset.kiokuLater).toBe('2');
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

  it('今日だけ追加 before any rating writes nothing and survives returning to the picker', async () => {
    const { adapter, plugin } = setup({ settings: { newPerDay: 0 } });
    await startDeck(plugin);
    expect(phase()).toBe('done');
    document.querySelector('.kioku-review-extra').click(); await settle();
    expect(adapter.writes()).toEqual([]);
    expect(question()).toBe('both');
    backToPicker(); await settle();
    expect(row('#kioku').dataset.kiokuLater).toBeUndefined();
    expect(adapter.folders.has('Kioku')).toBe(false);
    row('#kioku').click(); await settle();
    key(' '); key('3'); await settle();
    expect(JSON.parse(adapter.files.get(S)).today).toEqual({ day: '2026-10-02', newIntroduced: 1, extraNew: 10 });
  });

  it('drops an unsaved 今日だけ追加 when the Kioku day changed before the picker reloads', async () => {
    const { adapter, plugin } = setup({ settings: { newPerDay: 0 } });
    await startDeck(plugin);
    document.querySelector('.kioku-review-extra').click(); await settle();
    vi.setSystemTime(new Date(2026, 9, 3, 9, 0));
    backToPicker(); await settle();
    expect(row('#kioku').dataset.kiokuLater).toBe('0');
    expect(adapter.writes()).toEqual([]);
  });

  it('shows how many notes were skipped because they are not indexed yet', async () => {
    const { app, plugin } = setup();
    const getFileCache = app.metadataCache.getFileCache;
    app.metadataCache.getFileCache = (file) => (file.path === '学習/英語.md' ? null : getFileCache(file));
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-not-indexed').textContent).toContain('索引中のノート 1 件（あとで再読み込み）');
  });

  it('hides Markdown image embeds too before the answer is shown', async () => {
    const notes = { 'a.md': '#kioku\nQ: 図 ![図](answer.png) と ![[x.png]]\nA: y ^kioku-gggggggggg\n' };
    const { plugin } = setup({ notes });
    await startDeck(plugin);
    expect(question()).toBe('図 [図](answer.png) と [[x.png]]');
    expect(renders.at(-1).markdown).toBe('図 [図](answer.png) と [[x.png]]');
    key(' ');
    expect(question()).toBe('図 ![図](answer.png) と ![[x.png]]');
  });

  it('skips adopted blocks whose ID is not a usable card ID and says so', async () => {
    const notes = { 'a.md': '#kioku\nQ: bad\nA: x ^kioku-\n\nQ: good\nA: y ^kioku-gggggggggg\n' };
    const { plugin } = setup({ notes });
    await openPicker(plugin);
    expect(rows()[0]).toBe('#kioku | 新規 1 · 学習中 0 · 復習 0');
    expect(document.querySelector('.kioku-deck-invalid-id').textContent).toBe('カード ID として使えない ID（^kioku-）のため出題しません：a.md');
  });

  it('refuses to open with an unusable data folder in data.json instead of starting an empty one', async () => {
    const { adapter, plugin } = setup({ settings: { dataFolder: '../outside' } });
    await openPicker(plugin);
    expect(document.querySelector('.kioku-deck-problem').textContent).toMatch(/読み込めませんでした（設定の学習データのフォルダ/);
    expect(document.querySelector('.kioku-deck-row')).toBeNull();
    // ⋯ (status, extraction) stays reachable and takes the focus.
    expect(document.activeElement).toBe(document.querySelector('.kioku-deck-more'));
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
    row('#kioku').click(); await settle();
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

  it('reports a failed settings save with a Notice instead of an unhandled rejection', async () => {
    const { plugin } = setup();
    plugin.saveData = async () => { throw new Error('EACCES'); };
    tab(plugin); await settle();
    input(field('1日の新規カード数').querySelector('input.mock-text'), '30'); await settle();
    expect(notices).toEqual(['Kioku：設定を保存できませんでした（EACCES）。']);
  });

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
