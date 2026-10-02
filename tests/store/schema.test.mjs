import { describe, expect, it } from 'vitest';
import { emptyState, parseHistory, parseState, replayHistory, serializeEvent, serializeState } from '../../src/store/schema.ts';
import { DEFAULT_SETTINGS, normalizeDataFolder, parseSettings } from '../../src/store/settings.ts';
import { event } from '../helpers/events.mjs';

const lines = (...events) => events.map(serializeEvent).join('');
const file = (name, text) => ({ name, parse: parseHistory(text) });

describe('state.json validation', () => {
  it('accepts exactly schema 1 and distinguishes unknown versions from invalid files', () => {
    const state = { ...emptyState(), cards: { 'kioku-a': { phase: 'review', dueDay: '2026-10-05', stability: 1, difficulty: 2, reps: 1, lapses: 0, lastReviewDay: '2026-10-02' } },
      today: { day: '2026-10-02', newIntroduced: 1, extraNew: 10 }, applied: { 'history-2026.jsonl': { lines: 1, lastEventId: 'kioku-a:x' } } };
    expect(parseState(serializeState(state))).toEqual({ kind: 'ok', state });
    expect(parseState('{"schemaVersion":2,"cards":{}}')).toEqual({ kind: 'unknown-schema', version: '2' });
    for (const text of ['', '{', 'null', '[]', '{"cards":{}}', '{"schemaVersion":1,"cards":{"x":{}},"today":null,"applied":{}}',
      '{"schemaVersion":1,"cards":{},"today":{"day":"2026-13-01","newIntroduced":0,"extraNew":0},"applied":{}}',
      '{"schemaVersion":1,"cards":{},"today":null,"applied":{"notes.md":{"lines":1,"lastEventId":"a"}}}']) {
      expect(parseState(text).kind).toBe('invalid');
    }
  });
});

describe('history parsing', () => {
  it('reads events with line numbers, skipping blank lines', () => {
    const text = `${serializeEvent(event('a', '1'))}\n${serializeEvent(event('b', '2'))}`;
    const parse = parseHistory(text);
    expect(parse.entries.map((entry) => [entry.line, entry.event.cardId])).toEqual([[1, 'kioku-a'], [3, 'kioku-b']]);
    expect(parse).toMatchObject({ lines: 3, missingFinalNewline: false, problem: null });
    expect(parseHistory('')).toMatchObject({ entries: [], lines: 0, problem: null });
  });
  it('flags a valid last line without a line break (to be completed before the next append)', () => {
    const parse = parseHistory(lines(event('a', '1')) + JSON.stringify(event('b', '2')));
    expect(parse).toMatchObject({ lines: 2, missingFinalNewline: true, problem: null });
  });
  it('separates a truncated last line from other corruption and unknown versions', () => {
    const good = lines(event('a', '1'));
    const cut = serializeEvent(event('b', '2')).slice(0, 40);
    expect(parseHistory(good + cut).problem).toEqual({ kind: 'truncated', line: 2, text: cut, start: good.length });
    expect(parseHistory(`${good}${cut}\n`).problem).toMatchObject({ kind: 'corrupt', line: 2 });
    expect(parseHistory(`${cut}\n${good}`).problem).toMatchObject({ kind: 'corrupt', line: 1 });
    expect(parseHistory(`${good}{"v":1,"cardId":"kioku-x"}\n`).problem).toMatchObject({ kind: 'corrupt', line: 2 });
    expect(parseHistory(`${good}{"v":2}\n`).problem).toEqual({ kind: 'unknown-version', line: 2, version: '2' });
    expect(parseHistory(good + cut).entries).toHaveLength(1);
  });
});

describe('replay from history (history is the source of truth)', () => {
  const A1 = event('a', '1');
  const B1 = event('b', '1', { dueDay: '2026-10-04' });
  const A2 = event('a', '2', { day: '2026-10-05', dueDay: '2026-10-19', phaseBefore: 'review', reps: 2 });

  it('rebuilds state from nothing and counts today\'s new cards', () => {
    const { state } = replayHistory(null, [file('history-2026.jsonl', lines(A1, B1, A2))]);
    expect(state.cards['kioku-a']).toMatchObject({ dueDay: '2026-10-19', reps: 2, lastReviewDay: '2026-10-05' });
    expect(state.cards['kioku-b'].dueDay).toBe('2026-10-04');
    expect(state.today).toEqual({ day: '2026-10-02', newIntroduced: 2, extraNew: 0 });
    expect(state.applied).toEqual({ 'history-2026.jsonl': { lines: 3, lastEventId: A2.eventId } });
  });

  it('continues after the applied position (line count + eventId), not by timestamps', () => {
    const behind = replayHistory(null, [file('history-2026.jsonl', lines(A1))]).state;
    const sameTime = { ...A2, at: A1.at - 1 }; // clock moved backwards: still applied
    const result = replayHistory(behind, [file('history-2026.jsonl', lines(A1, B1, sameTime))]);
    expect(result).toMatchObject({ fullReplay: false, applied: 2 });
    expect(result.state.cards['kioku-a'].dueDay).toBe('2026-10-19');
  });

  it('applies a retried (duplicated) eventId only once, before or after the position', () => {
    const behind = replayHistory(null, [file('history-2026.jsonl', lines(A1))]).state;
    const result = replayHistory(behind, [file('history-2026.jsonl', lines(A1, A1, B1, B1))]);
    expect(result.applied).toBe(1);
    expect(result.state.today.newIntroduced).toBe(2);
    expect(replayHistory(null, [file('history-2026.jsonl', lines(A1, A1, B1, B1))]).state.today.newIntroduced).toBe(2);
  });

  it('replays everything when the applied line no longer holds the recorded eventId', () => {
    const state = replayHistory(null, [file('history-2026.jsonl', lines(A1, B1))]).state;
    const withExtra = { ...state, today: { ...state.today, extraNew: 10 }, cards: { ...state.cards, 'kioku-ghost': state.cards['kioku-a'] } };
    const result = replayHistory(withExtra, [file('history-2026.jsonl', lines(B1, A1))]);
    expect(result.fullReplay).toBe(true);
    expect(result.state.cards['kioku-ghost']).toBeUndefined();
    expect(result.state.today).toEqual({ day: '2026-10-02', newIntroduced: 2, extraNew: 10 });
    expect(replayHistory(state, []).fullReplay).toBe(true); // the file disappeared
  });

  it('replays several year files in order', () => {
    const Y1 = event('y', '1', { day: '2026-12-31', dueDay: '2027-01-02' });
    const Y2 = event('y', '2', { day: '2027-01-02', dueDay: '2027-01-10', phaseBefore: 'review', reps: 2 });
    const { state } = replayHistory(null, [file('history-2027.jsonl', lines(Y2)), file('history-2026.jsonl', lines(Y1))]);
    expect(state.cards['kioku-y'].dueDay).toBe('2027-01-10');
    expect(Object.keys(state.applied).sort()).toEqual(['history-2026.jsonl', 'history-2027.jsonl']);
  });
});

describe('settings (data.json)', () => {
  it('fills defaults and validates fields', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ schemaVersion: 1, triggerTags: ['kioku'], dayStartHour: 4, newPerDay: 20, dataFolder: 'Kioku' });
    expect(parseSettings({ triggerTags: ['#Deck', 'deck', 7], dayStartHour: 0, newPerDay: null, dataFolder: '/学習/Kioku/' }))
      .toEqual({ schemaVersion: 1, triggerTags: ['Deck'], dayStartHour: 0, newPerDay: null, dataFolder: '学習/Kioku' });
    expect(parseSettings({ triggerTags: [], dayStartHour: 24, newPerDay: -1, dataFolder: '../x' })).toEqual(DEFAULT_SETTINGS);
    expect(['', ' / ', '.obsidian', 'a/../b', 'a:b'].map(normalizeDataFolder)).toEqual([null, null, null, null, null]);
  });
});
