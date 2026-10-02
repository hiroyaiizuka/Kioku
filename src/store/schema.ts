// Validation and history replay for `<dataFolder>/`. Pure; docs/m2-design.md §7.
import { isKiokuDay } from '../review/day';
import { PHASES, type AppliedPosition, type CardPhase, type CardSchedule, type KiokuStateV1, type ReviewEvent,
  type TodayCounter } from '../review/types';

export const STATE_FILE = 'state.json';
export const STATE_BACKUP_FILE = 'state.json.bak';
export const HISTORY_FILE = /^history-(\d{4})\.jsonl$/;
export const historyFileName = (day: string): string => `history-${day.slice(0, 4)}.jsonl`;
/**
 * The file a new event is appended to: its own year, or a later year file that already exists
 * (after the clock was set back across New Year), so append order always equals replay order.
 */
export function appendTarget(day: string, existing: Iterable<string>): string {
  let target = historyFileName(day);
  for (const name of existing) if (HISTORY_FILE.test(name) && name > target) target = name;
  return target;
}
export const brokenFileName = (historyFile: string): string => `${historyFile}.broken`;

export const emptyState = (): KiokuStateV1 => ({ schemaVersion: 1, cards: {}, today: null, applied: {} });

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPhase = (value: unknown): value is CardPhase => PHASES.includes(value as CardPhase);
export const isCardId = (value: unknown): value is string => typeof value === 'string' && /^kioku-[A-Za-z0-9-]+$/.test(value);

function validSchedule(value: unknown): value is CardSchedule {
  return isObject(value) && isPhase(value.phase) && isKiokuDay(value.dueDay) && isFiniteNumber(value.stability)
    && isFiniteNumber(value.difficulty) && isCount(value.reps) && isCount(value.lapses)
    && (value.lastReviewDay === null || (isKiokuDay(value.lastReviewDay) && value.dueDay > value.lastReviewDay));
}

function validToday(value: unknown): value is TodayCounter | null {
  return value === null || (isObject(value) && isKiokuDay(value.day) && isCount(value.newIntroduced) && isCount(value.extraNew));
}

function validApplied(value: unknown): value is AppliedPosition {
  return isObject(value) && Number.isInteger(value.lines) && (value.lines as number) >= 1
    && typeof value.lastEventId === 'string';
}

export type StateParse =
  | { readonly kind: 'ok'; readonly state: KiokuStateV1 }
  | { readonly kind: 'unknown-schema'; readonly version: string }
  | { readonly kind: 'invalid'; readonly detail: string };

/** Parses `state.json`. Anything not exactly a valid schema 1 state is rejected, never repaired. */
export function parseState(text: string): StateParse {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { kind: 'invalid', detail: (error as Error).message };
  }
  if (!isObject(value)) return { kind: 'invalid', detail: 'not an object' };
  if (value.schemaVersion !== 1) {
    return typeof value.schemaVersion === 'number'
      ? { kind: 'unknown-schema', version: String(value.schemaVersion) }
      : { kind: 'invalid', detail: 'schemaVersion missing' };
  }
  const { cards, today, applied } = value;
  if (!isObject(cards) || Object.entries(cards).some(([id, schedule]) => !isCardId(id) || !validSchedule(schedule))) {
    return { kind: 'invalid', detail: 'cards' };
  }
  if (!validToday(today)) return { kind: 'invalid', detail: 'today' };
  if (!isObject(applied) || Object.entries(applied).some(([file, position]) => !HISTORY_FILE.test(file) || !validApplied(position))) {
    return { kind: 'invalid', detail: 'applied' };
  }
  return { kind: 'ok', state: { schemaVersion: 1, cards: cards as KiokuStateV1['cards'], today, applied: applied as KiokuStateV1['applied'] } };
}

export const serializeState = (state: KiokuStateV1): string => `${JSON.stringify(state, null, 2)}\n`;
export const serializeEvent = (event: ReviewEvent): string => `${JSON.stringify(event)}\n`;

/** A complete, schema-1 history event, or null. */
export function validateEvent(value: unknown): ReviewEvent | null {
  if (!isObject(value) || value.v !== 1 || !isCardId(value.cardId) || typeof value.eventId !== 'string'
      || !value.eventId.startsWith(`${value.cardId}:`) || value.eventId.length <= value.cardId.length + 1
      || !isFiniteNumber(value.at) || !isKiokuDay(value.day) || ![1, 2, 3, 4].includes(value.grade as number)
      || !isPhase(value.phaseBefore) || !isCount(value.elapsedDays) || !isCount(value.scheduledDays)
      || !isPhase(value.phase) || !isKiokuDay(value.dueDay) || !(value.dueDay > value.day)
      || !isFiniteNumber(value.stability) || !isFiniteNumber(value.difficulty) || !isCount(value.reps) || !isCount(value.lapses)
      || typeof value.contentHash !== 'string' || !value.contentHash
      || typeof value.scheduler !== 'string' || !value.scheduler) return null;
  return value as unknown as ReviewEvent;
}

export interface HistoryEntry {
  /** 1-based physical line number. */
  readonly line: number;
  readonly event: ReviewEvent;
}

export type HistoryProblem =
  /** The last line has no line break and is not a valid event: an interrupted append. */
  | { readonly kind: 'truncated'; readonly line: number; readonly text: string; readonly start: number }
  | { readonly kind: 'corrupt'; readonly line: number; readonly detail: string }
  | { readonly kind: 'unknown-version'; readonly line: number; readonly version: string };

export interface HistoryParse {
  /** Valid events before the first problem, in file order. */
  readonly entries: readonly HistoryEntry[];
  /** Physical lines that hold a complete event or are blank (excludes a truncated last line). */
  readonly lines: number;
  /** The file ends with a valid event but without `\n`; the next append must add one first. */
  readonly missingFinalNewline: boolean;
  readonly problem: HistoryProblem | null;
}

/**
 * Splits a history file on `\n` (a trailing `\r` is tolerated by JSON.parse). Blank lines are
 * skipped but counted, so line numbers always match a text editor's. A leading UTF-8 BOM (added by
 * some editors) is ignored; offsets stay offsets into the original text.
 */
export function parseHistory(text: string): HistoryParse {
  const entries: HistoryEntry[] = [];
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  const body = text.slice(bom);
  const physical = body === '' ? [] : body.split('\n');
  const terminated = body.endsWith('\n');
  if (terminated) physical.pop();
  let offset = bom;
  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index] ?? '';
    const line = index + 1;
    const start = offset;
    offset += raw.length + 1;
    if (!raw.trim()) continue;
    const isLast = index === physical.length - 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (isLast && !terminated) {
        return { entries, lines: line - 1, missingFinalNewline: false, problem: { kind: 'truncated', line, text: raw, start } };
      }
      return { entries, lines: line - 1, missingFinalNewline: false, problem: { kind: 'corrupt', line, detail: (error as Error).message } };
    }
    if (isObject(value) && typeof value.v === 'number' && value.v !== 1) {
      return { entries, lines: line - 1, missingFinalNewline: false,
        problem: { kind: 'unknown-version', line, version: String(value.v) } };
    }
    const event = validateEvent(value);
    if (!event) {
      if (isLast && !terminated) {
        return { entries, lines: line - 1, missingFinalNewline: false, problem: { kind: 'truncated', line, text: raw, start } };
      }
      return { entries, lines: line - 1, missingFinalNewline: false, problem: { kind: 'corrupt', line, detail: 'invalid event' } };
    }
    entries.push({ line, event });
  }
  const lastRaw = physical[physical.length - 1] ?? '';
  return { entries, lines: physical.length, missingFinalNewline: !terminated && lastRaw.trim() !== '', problem: null };
}

export interface HistoryFile {
  readonly name: string;
  readonly parse: HistoryParse;
}

interface Draft {
  cards: Record<string, CardSchedule>;
  today: TodayCounter | null;
  applied: Record<string, AppliedPosition>;
}

function applyEvent(draft: Draft, event: ReviewEvent): void {
  draft.cards[event.cardId] = {
    phase: event.phase, dueDay: event.dueDay, stability: event.stability, difficulty: event.difficulty,
    reps: event.reps, lapses: event.lapses, lastReviewDay: event.day,
  };
  if (event.phaseBefore !== 'new') return;
  const today = draft.today;
  if (!today || event.day > today.day) draft.today = { day: event.day, newIntroduced: 1, extraNew: 0 };
  else if (event.day === today.day) draft.today = { ...today, newIntroduced: today.newIntroduced + 1 };
}

export interface ReplayResult {
  readonly state: KiokuStateV1;
  /** True when `applied` did not match the files and everything was replayed from the start. */
  readonly fullReplay: boolean;
  /** Number of events applied on top of `base`. */
  readonly applied: number;
}

/** True when `base.applied` still points at the same lines (same eventId) of the current files. */
function positionsMatch(base: KiokuStateV1, files: readonly HistoryFile[]): boolean {
  const byName = new Map(files.map((file) => [file.name, file]));
  return Object.entries(base.applied).every(([name, position]) => {
    const file = byName.get(name);
    const entry = file?.parse.entries.find((item) => item.line === position.lines);
    return entry?.event.eventId === position.lastEventId;
  });
}

/**
 * History that state.json says was already applied but that is now missing or shorter (a deleted,
 * truncated or partially restored file). Replaying from what is left would silently drop schedules,
 * so the store becomes read-only instead. Returns the file name, or null when consistent.
 */
export function missingAppliedHistory(base: KiokuStateV1, files: readonly HistoryFile[]): string | null {
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const [name, position] of Object.entries(base.applied)) {
    const file = byName.get(name);
    if (!file || file.parse.lines < position.lines) return name;
  }
  return null;
}

/**
 * Brings `base` (state.json, or null when missing) up to date with the history files (sorted by
 * year). Positions are line numbers plus the eventId on that line, never timestamps. When they do
 * not match (the files changed elsewhere), all history is replayed from an empty state. Events whose
 * eventId was already seen (a retried append) are applied only once.
 */
export function replayHistory(base: KiokuStateV1 | null, files: readonly HistoryFile[]): ReplayResult {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const full = base === null || !positionsMatch(base, sorted);
  const start = full ? emptyState() : base;
  const draft: Draft = { cards: { ...start.cards }, today: start.today, applied: { ...start.applied } };
  const seen = new Set<string>();
  let applied = 0;
  for (const file of sorted) {
    const from = full ? 0 : start.applied[file.name]?.lines ?? 0;
    for (const { line, event } of file.parse.entries) {
      if (line <= from) {
        seen.add(event.eventId);
        continue;
      }
      if (!seen.has(event.eventId)) {
        seen.add(event.eventId);
        applyEvent(draft, event);
        applied += 1;
      }
      draft.applied[file.name] = { lines: line, lastEventId: event.eventId };
    }
  }
  // "今日だけ あと N 枚" lives only in state.json; keep it for the same day across a full replay.
  if (full && base?.today && draft.today?.day === base.today.day) draft.today = { ...draft.today, extraNew: base.today.extraNew };
  else if (full && base?.today && (!draft.today || base.today.day > draft.today.day)) draft.today = base.today;
  return { state: { schemaVersion: 1, cards: draft.cards, today: draft.today, applied: draft.applied }, fullReplay: full && base !== null, applied };
}
