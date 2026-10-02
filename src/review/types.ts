// Kioku's own review types (Obsidian- and ts-fsrs-independent). See docs/m2-design.md §6.

/** `kioku-…` block ID. Case-sensitive, exactly as the M1 parser reads it. */
export type CardId = string;
/** 1 = again, 2 = hard, 3 = good, 4 = easy. */
export type Grade = 1 | 2 | 3 | 4;
export const GRADES: readonly Grade[] = [1, 2, 3, 4];
export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';
export const PHASES: readonly CardPhase[] = ['new', 'learning', 'review', 'relearning'];
/** Local calendar date `YYYY-MM-DD` after the configurable day start hour. */
export type KiokuDay = string;

export interface CardSchedule {
  readonly phase: CardPhase;
  readonly dueDay: KiokuDay;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewDay: KiokuDay | null;
}

/**
 * One rating, appended as one line to `<dataFolder>/history-YYYY.jsonl` (the source of truth).
 * Skip is never recorded. Besides the fields needed for future parameter optimisation, the event
 * carries the complete schedule after the rating, so replaying history never re-runs the scheduler.
 */
export interface ReviewEvent {
  readonly v: 1;
  /** `${cardId}:${random 10 chars}`; a retry reuses it and replay drops repeated IDs. */
  readonly eventId: string;
  readonly cardId: CardId;
  /** Real time of the rating, UTC epoch ms. Never used to order or position replay. */
  readonly at: number;
  readonly day: KiokuDay;
  readonly grade: Grade;
  readonly phaseBefore: CardPhase;
  /** Kioku days since the previous rating (0 for the first). */
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  /** Schedule after this rating. */
  readonly phase: CardPhase;
  readonly dueDay: KiokuDay;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  /** Hash of the effective Q/A at review time, so later edits stay distinguishable (Q8). */
  readonly contentHash: string;
  readonly scheduler: string;
}

export interface TodayCounter {
  readonly day: KiokuDay;
  /** New cards rated for the first time on `day`. */
  readonly newIntroduced: number;
  /** "今日だけ あと N 枚" additions for `day`; ignored on any other day. */
  readonly extraNew: number;
}

export interface AppliedPosition {
  /** 1-based physical line number of the last history line reflected in `cards`. */
  readonly lines: number;
  readonly lastEventId: string;
}

export interface KiokuStateV1 {
  readonly schemaVersion: 1;
  readonly cards: Readonly<Record<CardId, CardSchedule>>;
  readonly today: TodayCounter | null;
  /** Replay position per history file name (e.g. `history-2026.jsonl`). */
  readonly applied: Readonly<Record<string, AppliedPosition>>;
}

export interface KiokuSettings {
  readonly schemaVersion: 1;
  /** Without `#`; matched case-insensitively. */
  readonly triggerTags: readonly string[];
  readonly dayStartHour: number;
  /** `null` = unlimited. */
  readonly newPerDay: number | null;
  /** Vault-relative folder without leading / trailing slash. */
  readonly dataFolder: string;
}
