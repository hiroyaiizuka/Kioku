import type { CardSchedule, CardId, KiokuDay, TodayCounter } from './types';

/** One unique card as presented in a session (duplicates already resolved by the deck index). */
export interface ReviewCard {
  readonly id: CardId;
  /** Note shown and opened for this card (first path in path order when the ID is duplicated). */
  readonly path: string;
  readonly question: string;
  readonly answer: string;
  /** Position in path order, then occurrence order inside the note. */
  readonly order: number;
}

export type ScheduleLookup = (id: CardId) => CardSchedule | undefined;

export const isDue = (schedule: CardSchedule | undefined, today: KiokuDay): boolean =>
  schedule !== undefined && schedule.dueDay <= today;

/** New cards still allowed today. `Infinity` when `newPerDay` is unlimited (`null`). */
export function newAllowance(counter: TodayCounter | null, today: KiokuDay, newPerDay: number | null): number {
  if (newPerDay === null) return Number.POSITIVE_INFINITY;
  const current = counter?.day === today ? counter : null;
  return Math.max(0, newPerDay + (current?.extraNew ?? 0) - (current?.newIntroduced ?? 0));
}

export const isLearning = (schedule: CardSchedule): boolean =>
  schedule.phase === 'learning' || schedule.phase === 'relearning';

/**
 * Today's work of a deck in three disjoint columns (docs/m2-design.md §4.3): `learning` and `due`
 * split the due cards by FSRS phase, so new + learning + due is what a session can show today
 * (before the new-card limit).
 */
export interface DeckCounts {
  readonly new: number;
  /** Due cards in the learning or relearning phase. */
  readonly learning: number;
  /** Due cards in any other phase (review). */
  readonly due: number;
  readonly total: number;
}

export function countCards(cards: Iterable<ReviewCard>, lookup: ScheduleLookup, today: KiokuDay): DeckCounts {
  let fresh = 0;
  let learning = 0;
  let due = 0;
  let total = 0;
  for (const card of cards) {
    total += 1;
    const schedule = lookup(card.id);
    if (!schedule) fresh += 1;
    else if (isDue(schedule, today)) {
      if (isLearning(schedule)) learning += 1;
      else due += 1;
    }
  }
  return { new: fresh, learning, due, total };
}

/**
 * One session's queue: due cards (oldest due day first), then new cards in note order, each card
 * at most once. Rated and skipped cards leave the queue for the rest of the session. New cards are
 * taken lazily against the allowance passed to `next`, so a skipped new card does not use it up.
 */
export class ReviewQueue {
  private readonly due: ReviewCard[];
  private readonly fresh: ReviewCard[];
  private readonly done = new Set<CardId>();
  rated = 0;
  skipped = 0;

  constructor(cards: Iterable<ReviewCard>, lookup: ScheduleLookup, today: KiokuDay) {
    const unique = new Map<CardId, ReviewCard>();
    for (const card of cards) if (!unique.has(card.id)) unique.set(card.id, card);
    const all = [...unique.values()].sort((a, b) => a.order - b.order);
    this.fresh = all.filter((card) => !lookup(card.id));
    this.due = all.filter((card) => isDue(lookup(card.id), today))
      .sort((a, b) => {
        const left = lookup(a.id)?.dueDay ?? '';
        const right = lookup(b.id)?.dueDay ?? '';
        return left < right ? -1 : left > right ? 1 : a.order - b.order;
      });
  }

  next(newAllowed: number): ReviewCard | null {
    const due = this.due.find((card) => !this.done.has(card.id));
    if (due) return due;
    if (newAllowed <= 0) return null;
    return this.fresh.find((card) => !this.done.has(card.id)) ?? null;
  }

  markRated(id: CardId): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    this.rated += 1;
  }

  markSkipped(id: CardId): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    this.skipped += 1;
  }

  private newLeft(): number {
    return this.fresh.filter((card) => !this.done.has(card.id)).length;
  }

  /** Cards this session can still show today. */
  remaining(newAllowed: number): number {
    return this.due.filter((card) => !this.done.has(card.id)).length + Math.min(this.newLeft(), newAllowed);
  }

  /** New cards held back by today's limit. */
  heldBack(newAllowed: number): number {
    return Math.max(0, this.newLeft() - newAllowed);
  }
}
