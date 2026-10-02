import type { RandomBytes } from '../cards/card-id';
import { randomBase36 } from '../cards/card-id';
import type { CardText } from '../cards/parser';
import { kiokuDay } from './day';
import { SCHEDULER_ID, rateCard } from './scheduler';
import type { CardId, CardSchedule, Grade, ReviewEvent } from './types';

/** SHA-256 of the effective Q/A (`question NUL answer`), as `sha256:<hex>`. */
export async function contentHash(card: CardText): Promise<string> {
  const bytes = new TextEncoder().encode(`${card.question}\u0000${card.answer}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface RatingInput {
  readonly cardId: CardId;
  readonly card: CardText;
  readonly before: CardSchedule | null;
  readonly grade: Grade;
  readonly now: Date;
  readonly dayStartHour: number;
  readonly random?: RandomBytes;
}

/** Builds the history event for one rating. The event ID is fixed here and reused on every retry. */
export async function createReviewEvent(input: RatingInput): Promise<ReviewEvent> {
  const day = kiokuDay(input.now, input.dayStartHour);
  const outcome = rateCard(input.before, day, input.grade);
  return {
    v: 1,
    eventId: `${input.cardId}:${randomBase36(10, input.random)}`,
    cardId: input.cardId,
    at: input.now.getTime(),
    day,
    grade: input.grade,
    phaseBefore: input.before?.phase ?? 'new',
    elapsedDays: outcome.elapsedDays,
    scheduledDays: outcome.scheduledDays,
    phase: outcome.schedule.phase,
    dueDay: outcome.schedule.dueDay,
    stability: outcome.schedule.stability,
    difficulty: outcome.schedule.difficulty,
    reps: outcome.schedule.reps,
    lapses: outcome.schedule.lapses,
    contentHash: await contentHash(input.card),
    scheduler: SCHEDULER_ID,
  };
}
