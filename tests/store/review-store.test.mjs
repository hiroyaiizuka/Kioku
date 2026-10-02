import { describe, expect, it } from 'vitest';
import { ReviewStore, checkFolderChange, folderHasData } from '../../src/store/review-store.ts';
import { emptyState, parseState, replayHistory, parseHistory, serializeEvent, serializeState } from '../../src/store/schema.ts';
import { FakeAdapter } from '../helpers/fake-adapter.mjs';
import { event } from '../helpers/events.mjs';

const H = 'Kioku/history-2026.jsonl';
const S = 'Kioku/state.json';
const lines = (...events) => events.map(serializeEvent).join('');
const stateFrom = (text) => replayHistory(null, [{ name: 'history-2026.jsonl', parse: parseHistory(text) }]).state;
const A1 = event('a', '1');
const B1 = event('b', '1');

describe('loading never writes', () => {
  it('treats a missing folder as new without creating anything', async () => {
    const adapter = new FakeAdapter({ 'Welcome.md': '# hi\n' });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.readOnly).toBe(false);
    expect(store.state).toEqual(emptyState());
    expect(adapter.writes()).toEqual([]);
    expect(adapter.folders.has('Kioku')).toBe(false);
  });

  it('rebuilds from history when state.json is missing, without writing it on load', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1, B1) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.readOnly).toBe(false);
    expect(Object.keys(store.state.cards).sort()).toEqual(['kioku-a', 'kioku-b']);
    expect(adapter.writes()).toEqual([]);
  });

  it('becomes read-only (and never writes) when state.json exists but is unreadable, invalid or from a newer version', async () => {
    for (const [content, pattern] of [['{broken', /読めません/], ['{"schemaVersion":1}', /読めません/], ['{"schemaVersion":9}', /新しい版/]]) {
      const adapter = new FakeAdapter({ [S]: content, [H]: lines(A1) });
      const store = await ReviewStore.load(adapter, 'Kioku');
      expect(store.readOnly).toBe(true);
      expect(store.problem.message).toMatch(pattern);
      expect(await store.record(event('c', '1'))).toEqual({ ok: false, reason: expect.stringMatching(/読み取り専用/) });
      expect(await store.saveState()).toBe(false);
      expect(await store.addExtraNew('2026-10-02', 10)).toBe(false);
      expect(adapter.writes()).toEqual([]);
      expect(adapter.files.get(S)).toBe(content);
    }
    const adapter = new FakeAdapter({ [S]: serializeState(emptyState()) });
    adapter.hooks.read = (path) => { if (path === S) throw new Error('EACCES'); };
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.problem.message).toMatch(/state\.json を読めません（EACCES）/);
  });

  it('offers no repair when a truncated tail comes with corruption elsewhere (any read-only problem wins)', async () => {
    const cut = serializeEvent(B1).slice(0, 40);
    const adapter = new FakeAdapter({ 'Kioku/history-2026.jsonl': `{oops\n${lines(A1)}`, 'Kioku/history-2027.jsonl': cut });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.problem).toEqual({ kind: 'read-only', message: expect.stringContaining('history-2026.jsonl の 1 行目') });
    expect((await store.repairTruncated()).ok).toBe(false);
    expect(adapter.writes()).toEqual([]);
  });

  it('writes nothing for 今日だけ追加 while read-only, even with an existing state.json', async () => {
    const adapter = new FakeAdapter({ [H]: `${lines(A1)}{oops\n${lines(B1)}`, [S]: serializeState(stateFrom(lines(A1))) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.readOnly).toBe(true);
    expect(await store.addExtraNew('2026-10-02', 10)).toBe(false);
    expect(adapter.writes()).toEqual([]);
  });

  it('tolerates a UTF-8 BOM at the start of state.json and history', async () => {
    const adapter = new FakeAdapter({ [H]: `\uFEFF${lines(A1)}`, [S]: `\uFEFF${serializeState(stateFrom(lines(A1)))}` });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.readOnly).toBe(false);
    expect(Object.keys(store.state.cards)).toEqual(['kioku-a']);
    const cut = serializeEvent(B1).slice(0, 30);
    const bom = new FakeAdapter({ [H]: `\uFEFF${cut}` });
    const truncated = await ReviewStore.load(bom, 'Kioku');
    expect((await truncated.repairTruncated()).ok).toBe(true);
    expect(bom.files.get(H)).toBe('\uFEFF');
  });

  it('becomes read-only with file and line for a corrupt middle line', async () => {
    const adapter = new FakeAdapter({ [H]: `${lines(A1)}{oops\n${lines(B1)}` });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.problem).toEqual({ kind: 'read-only', message: expect.stringContaining('Kioku/history-2026.jsonl の 2 行目') });
    expect((await store.record(event('c', '1'))).ok).toBe(false);
    expect(adapter.writes()).toEqual([]);
  });
});

describe('history that state.json already reflects must not disappear silently', () => {
  it('is read-only when an applied history file is missing or shorter, and never shrinks state.json', async () => {
    const full = serializeState(stateFrom(lines(A1, B1)));
    for (const kioku of [{ [S]: full }, { [S]: full, [H]: lines(A1) }]) {
      const adapter = new FakeAdapter(kioku);
      const store = await ReviewStore.load(adapter, 'Kioku');
      expect(store.problem).toEqual({ kind: 'read-only', message: expect.stringContaining('Kioku/history-2026.jsonl が見つからないか') });
      expect((await store.record(event('c', '1'))).ok).toBe(false);
      expect(adapter.writes()).toEqual([]);
      expect(adapter.files.get(S)).toBe(full);
      // Counts keep showing state.json's schedules, not "everything is new".
      expect(Object.keys(store.state.cards).sort()).toEqual(['kioku-a', 'kioku-b']);
    }
  });
  it('stops an append when the file became shorter than the applied position after loading', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1, B1), [S]: serializeState(stateFrom(lines(A1, B1))) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    adapter.files.set(H, lines(A1));
    expect((await store.record(event('c', '1'))).ok).toBe(false);
    expect(adapter.files.get(H)).toBe(lines(A1));
    expect(store.readOnly).toBe(true);
  });
  it('never appends an event that replay would reject (e.g. the card ID `kioku-`)', async () => {
    const adapter = new FakeAdapter();
    const store = await ReviewStore.load(adapter, 'Kioku');
    const bad = { ...event('x', '1'), cardId: 'kioku-', eventId: 'kioku-:0000000000' };
    expect(await store.record(bad)).toEqual({ ok: false, reason: '評価の記録を作れませんでした（カード ID が不正です）。' });
    expect(adapter.writes()).toEqual([]);
  });
});

describe('recording a rating', () => {
  it('creates the folder and history on the first rating, verifies it, then writes state.json', async () => {
    const adapter = new FakeAdapter();
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(A1)).toEqual({ ok: true, stateSaved: true });
    // History is always appended (never created by write); state.json is replaced via a verified temp file.
    expect(adapter.writes()).toEqual(['mkdir:Kioku', `append:${H}`, 'write:Kioku/state.json.tmp', 'rename:Kioku/state.json.tmp->Kioku/state.json']);
    expect(adapter.files.get(H)).toBe(lines(A1));
    const saved = parseState(adapter.files.get(S));
    expect(saved.state.cards['kioku-a'].dueDay).toBe('2026-10-05');
    expect(saved.state.applied['history-2026.jsonl']).toEqual({ lines: 1, lastEventId: A1.eventId });
    expect(adapter.files.has('Kioku/state.json.bak')).toBe(false); // nothing to back up yet
  });

  it('backs up state.json once per store before its first save', async () => {
    const before = serializeState(stateFrom(lines(A1)));
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: before });
    const store = await ReviewStore.load(adapter, 'Kioku');
    await store.record(B1);
    await store.record(event('c', '1'));
    expect(adapter.files.get('Kioku/state.json.bak')).toBe(before);
    expect(adapter.writes().filter((call) => call.endsWith('.bak'))).toEqual(['write:Kioku/state.json.bak']);
    expect(Object.keys(parseState(adapter.files.get(S)).state.cards).sort()).toEqual(['kioku-a', 'kioku-b', 'kioku-c']);
  });

  it('adds the missing line break before appending after a valid last line', async () => {
    const adapter = new FakeAdapter({ [H]: JSON.stringify(A1) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect((await store.record(B1)).ok).toBe(true);
    expect(adapter.files.get(H)).toBe(lines(A1, B1));
  });

  it('stops before appending after a truncated last line, and the confirmed repair moves only that line', async () => {
    const cut = serializeEvent(B1).slice(0, 50);
    const adapter = new FakeAdapter({ [H]: lines(A1) + cut, 'Kioku/history-2026.jsonl.broken': 'older' });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.problem).toMatchObject({ kind: 'truncated', file: 'history-2026.jsonl', line: 2, text: cut });
    expect((await store.record(event('c', '1'))).ok).toBe(false);
    expect(adapter.writes()).toEqual([]);
    const repaired = await store.repairTruncated();
    expect(repaired.ok).toBe(true);
    // .broken first (appended after completing its last line), then the history without that line.
    expect(adapter.writes()).toEqual(['append:Kioku/history-2026.jsonl.broken', `write:${H}`]);
    expect(adapter.files.get('Kioku/history-2026.jsonl.broken')).toBe(`older\n${cut}\n`);
    expect(adapter.files.get(H)).toBe(lines(A1));
    expect(repaired.store.readOnly).toBe(false);
    expect((await repaired.store.record(event('c', '1'))).ok).toBe(true);
    expect(adapter.files.get(H)).toBe(lines(A1, event('c', '1')));
  });

  it('re-checks the tail before every append: a line truncated after loading stops the append', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    const cut = serializeEvent(B1).slice(0, 30);
    adapter.files.set(H, lines(A1) + cut);
    expect(await store.record(event('c', '1'))).toEqual({ ok: false, reason: expect.stringContaining('途中で切れています') });
    expect(adapter.files.get(H)).toBe(lines(A1) + cut);
    expect(store.problem).toMatchObject({ kind: 'truncated', line: 2 });
    expect(adapter.writes()).toEqual([]);
  });

  it('does not remove the line when writing .broken cannot be confirmed', async () => {
    const cut = serializeEvent(B1).slice(0, 50);
    const adapter = new FakeAdapter({ [H]: lines(A1) + cut });
    adapter.hooks.append = (path) => { if (path.endsWith('.broken')) throw new Error('disk full'); };
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect((await store.repairTruncated()).ok).toBe(false);
    expect(adapter.files.get(H)).toBe(lines(A1) + cut);
  });

  it('refuses the repair when the file changed after the check', async () => {
    const cut = serializeEvent(B1).slice(0, 50);
    const adapter = new FakeAdapter({ [H]: lines(A1) + cut });
    const store = await ReviewStore.load(adapter, 'Kioku');
    adapter.files.set(H, `${lines(A1)}${cut}x`);
    expect(await store.repairTruncated()).toEqual({ ok: false, reason: expect.stringMatching(/変更されました/) });
    expect(adapter.writes()).toEqual([]);
  });

  it('reports a failed or unconfirmed append without updating state, and a retry with the same event does not duplicate', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    adapter.hooks.append = () => { throw new Error('EIO'); };
    expect(await store.record(B1)).toEqual({ ok: false, reason: '記録ファイルに書き込めませんでした（EIO）。' });
    expect(store.state.cards['kioku-b']).toBeUndefined();
    // The append "fails" after reaching the disk: the retry must find it and not append again.
    adapter.hooks.append = (path, data) => { adapter.files.set(path, adapter.files.get(path) + data); throw new Error('timeout'); };
    expect((await store.record(B1)).ok).toBe(false);
    adapter.hooks.append = undefined;
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: true });
    expect(adapter.files.get(H)).toBe(lines(A1, B1));
    // An append that silently does not land is not "saved".
    const quiet = new FakeAdapter({ [H]: lines(A1) });
    quiet.append = async () => {};
    const quietStore = await ReviewStore.load(quiet, 'Kioku');
    expect(await quietStore.record(B1)).toEqual({ ok: false, reason: '記録ファイルへの追記を確認できませんでした。' });
  });

  it('keeps the rating when only state.json fails (history already has it)', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1) });
    adapter.hooks.write = (path) => { if (path.startsWith(S)) throw new Error('EACCES'); };
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: false });
    expect(store.state.cards['kioku-b']).toBeDefined();
    adapter.hooks.write = undefined;
    const reloaded = await ReviewStore.load(adapter, 'Kioku');
    expect(reloaded.state.cards['kioku-b']).toBeDefined();
  });

  it('does not overwrite a state.json that became unreadable after loading', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: serializeState(stateFrom(lines(A1))) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    adapter.files.set(S, '{garbage');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: false });
    expect(adapter.files.get(S)).toBe('{garbage');
    expect(adapter.files.has('Kioku/state.json.bak')).toBe(false);
  });

  it('catches up an old state.json from later history lines and keeps extraNew', async () => {
    const old = { ...stateFrom(lines(A1)), today: { day: '2026-10-02', newIntroduced: 1, extraNew: 10 } };
    const adapter = new FakeAdapter({ [H]: lines(A1, B1, B1), [S]: serializeState(old) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(store.state.today).toEqual({ day: '2026-10-02', newIntroduced: 2, extraNew: 10 });
    expect(store.state.applied['history-2026.jsonl']).toEqual({ lines: 3, lastEventId: B1.eventId });
    expect(adapter.writes()).toEqual([]);
  });

  it('keeps 今日だけ追加 in memory before the first rating (no folder, no file), then saves it with the rating', async () => {
    const adapter = new FakeAdapter();
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.addExtraNew('2026-10-02', 10)).toBe(true);
    expect(await store.addExtraNew('2026-10-02', 20)).toBe(true);
    expect(store.state.today).toEqual({ day: '2026-10-02', newIntroduced: 0, extraNew: 30 });
    expect(adapter.writes()).toEqual([]);
    expect(adapter.folders.has('Kioku')).toBe(false);
    await store.record(A1);
    expect(parseState(adapter.files.get(S)).state.today).toEqual({ day: '2026-10-02', newIntroduced: 1, extraNew: 30 });
  });

  it('saves 今日だけ追加 to an existing state.json (history stays untouched)', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: serializeState(stateFrom(lines(A1))) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.addExtraNew('2026-10-02', 10)).toBe(true);
    expect(parseState(adapter.files.get(S)).state.today).toEqual({ day: '2026-10-02', newIntroduced: 1, extraNew: 10 });
    expect(adapter.files.get(H)).toBe(lines(A1));
  });

  it('writes state.json atomically: a crash while writing the temp file leaves state.json readable', async () => {
    const before = serializeState(stateFrom(lines(A1)));
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: before });
    adapter.hooks.write = (path, data) => { if (path === 'Kioku/state.json.tmp') { adapter.files.set(path, data.slice(0, 10)); throw new Error('crash'); } };
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: false });
    expect(adapter.files.get(S)).toBe(before);
    const reloaded = await ReviewStore.load(adapter, 'Kioku');
    expect(reloaded.readOnly).toBe(false);
    expect(Object.keys(reloaded.state.cards).sort()).toEqual(['kioku-a', 'kioku-b']);
  });

  it('reports an unconfirmed state write when the replaced state.json does not read back', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1) });
    adapter.rename = async () => {}; // claims success, moves nothing
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: false });
  });

  it('still detects a vanished applied history when state.json is gone but state.json.tmp / .bak remain', async () => {
    const old = { ...stateFrom(lines(A1)), applied: { 'history-2025.jsonl': { lines: 1, lastEventId: A1.eventId } } };
    for (const leftover of ['Kioku/state.json.tmp', 'Kioku/state.json.bak']) {
      const adapter = new FakeAdapter({ [leftover]: serializeState(old), [H]: lines(B1) });
      const store = await ReviewStore.load(adapter, 'Kioku');
      expect(store.problem).toEqual({ kind: 'read-only', message: expect.stringContaining('Kioku/history-2025.jsonl が見つからないか') });
      expect((await store.record(event('c', '1'))).ok).toBe(false);
      expect(adapter.writes()).toEqual([]);
    }
    // The temp file wins over the backup when both are valid.
    const both = new FakeAdapter({ 'Kioku/state.json.tmp': serializeState(stateFrom(lines(B1))),
      'Kioku/state.json.bak': serializeState(old), [H]: lines(B1) });
    expect((await ReviewStore.load(both, 'Kioku')).readOnly).toBe(false);
  });

  it('does not replace state.json with a temp file that did not land completely', async () => {
    const before = serializeState(stateFrom(lines(A1)));
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: before });
    const write = adapter.write.bind(adapter);
    adapter.write = async (path, data) => write(path, path.endsWith('.tmp') ? data.slice(0, 20) : data);
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: false });
    expect(adapter.files.get(S)).toBe(before);
  });

  it('when rename cannot replace a file, removes state.json first; a crash in that gap rebuilds from history', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1), [S]: serializeState(stateFrom(lines(A1))) });
    const store = await ReviewStore.load(adapter, 'Kioku');
    expect(await store.record(B1)).toEqual({ ok: true, stateSaved: true });
    expect(adapter.writes()).toContain(`remove:${S}`);
    expect(adapter.files.has('Kioku/state.json.tmp')).toBe(false);
    adapter.renameOverwrites = true;
    const direct = await ReviewStore.load(adapter, 'Kioku');
    adapter.calls.length = 0;
    expect((await direct.record(event('c', '1'))).ok).toBe(true);
    expect(adapter.writes()).not.toContain(`remove:${S}`);
    // Crash between remove and rename: no state.json, the temp file and .bak remain.
    adapter.renameOverwrites = false;
    const crashing = await ReviewStore.load(adapter, 'Kioku');
    adapter.hooks.rename = (pair) => { if (!adapter.files.has(S) && pair.endsWith('state.json')) throw new Error('crash'); };
    expect((await crashing.record(event('d', '1'))).ok).toBe(true);
    adapter.hooks.rename = undefined;
    expect(adapter.files.has(S)).toBe(false);
    const rebuilt = await ReviewStore.load(adapter, 'Kioku');
    expect(rebuilt.readOnly).toBe(false);
    expect(Object.keys(rebuilt.state.cards).sort()).toEqual(['kioku-a', 'kioku-b', 'kioku-c', 'kioku-d']);
  });

  it('appends to the latest year file after the clock was set back across New Year (append order = replay order)', async () => {
    const adapter = new FakeAdapter();
    const store = await ReviewStore.load(adapter, 'Kioku');
    const later = event('y', '1', { day: '2027-01-05', dueDay: '2027-01-08' });
    const earlier = event('y', '2', { day: '2026-12-30', dueDay: '2027-01-20', phaseBefore: 'review', reps: 2 });
    expect((await store.record(later)).ok).toBe(true);
    expect((await store.record(earlier)).ok).toBe(true);
    expect(adapter.files.has(H)).toBe(false);
    expect(adapter.files.get('Kioku/history-2027.jsonl')).toBe(lines(later, earlier));
    const reloaded = await ReviewStore.load(adapter, 'Kioku');
    expect(reloaded.state.cards['kioku-y'].dueDay).toBe('2027-01-20');
    expect(store.state.cards['kioku-y'].dueDay).toBe('2027-01-20');
  });
});

describe('data folder change guard', () => {
  it('refuses a new empty folder while the old one has data, and allows otherwise', async () => {
    const adapter = new FakeAdapter({ [H]: lines(A1), 'Moved/state.json': '{}', 'Notes/x.md': '' });
    expect(await folderHasData(adapter, 'Kioku')).toBe(true);
    expect(await folderHasData(adapter, 'Notes')).toBe(false);
    expect(await checkFolderChange(adapter, 'Kioku', 'Empty')).toBe('古いフォルダ（Kioku）にデータがあります。移動してから変更してください。');
    expect(await checkFolderChange(adapter, 'Kioku', 'Notes')).toMatch(/古いフォルダ/);
    expect(await checkFolderChange(adapter, 'Kioku', 'Moved')).toBeNull();
    expect(await checkFolderChange(adapter, 'Fresh', 'Other')).toBeNull();
    expect(adapter.writes()).toEqual([]);
  });
});
