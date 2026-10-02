// The only module that touches ts-fsrs. Everything outside sees Kioku's own types.
import { restoreDatePrototype } from './fsrs-guard';
import { State, createEmptyCard, fsrs, type Card } from 'ts-fsrs';
import { addDays, dayNoonUtc, daysBetween, utcDay } from './day';
import { GRADES, type CardPhase, type CardSchedule, type Grade, type KiokuDay } from './types';

restoreDatePrototype();

/** Recorded in every history event; bump together with the pinned ts-fsrs version. */
export const SCHEDULER_ID = 'ts-fsrs@5.4.2';

/** Decided in docs/m2-design.md §4.1: default parameters, 90 % retention, no learning steps, no fuzz. */
const engine = fsrs({ request_retention: 0.9, enable_short_term: false, enable_fuzz: false });

const PHASE_OF: Record<State, CardPhase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};
const STATE_OF: Record<CardPhase, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/** Rebuilds the ts-fsrs card from Kioku's schedule; every instant is a Kioku day at 12:00 UTC. */
function toCard(schedule: CardSchedule | null, day: KiokuDay): Card {
  if (!schedule) return createEmptyCard(dayNoonUtc(day));
  const card: Card = {
    due: dayNoonUtc(schedule.dueDay),
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsed_days: 0,
    scheduled_days: schedule.lastReviewDay ? Math.max(0, daysBetween(schedule.lastReviewDay, schedule.dueDay)) : 0,
    learning_steps: 0,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: STATE_OF[schedule.phase],
  };
  if (schedule.lastReviewDay) card.last_review = dayNoonUtc(schedule.lastReviewDay);
  return card;
}

export interface RatingOutcome {
  readonly schedule: CardSchedule;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
}

/** Due day from the ts-fsrs due instant; never today (no same-day re-review). */
function dueDayOf(due: Date, day: KiokuDay): KiokuDay {
  const dueDay = utcDay(due);
  return dueDay > day ? dueDay : addDays(day, 1);
}

/** Schedules one rating made on Kioku day `day`. Pure and deterministic. */
export function rateCard(schedule: CardSchedule | null, day: KiokuDay, grade: Grade): RatingOutcome {
  const { card } = engine.next(toCard(schedule, day), dayNoonUtc(day), grade);
  const dueDay = dueDayOf(card.due, day);
  return {
    schedule: {
      phase: PHASE_OF[card.state],
      dueDay,
      stability: card.stability,
      difficulty: card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      lastReviewDay: day,
    },
    elapsedDays: schedule?.lastReviewDay ? Math.max(0, daysBetween(schedule.lastReviewDay, day)) : 0,
    scheduledDays: daysBetween(day, dueDay),
  };
}

/** Days until the next review for each grade, as shown on the rating buttons. */
export function previewIntervals(schedule: CardSchedule | null, day: KiokuDay): Record<Grade, number> {
  const preview = engine.repeat(toCard(schedule, day), dayNoonUtc(day));
  const result = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Grade, number>;
  for (const grade of GRADES) result[grade] = daysBetween(day, dueDayOf(preview[grade].card.due, day));
  return result;
}

/** Short Japanese interval label for buttons: 「1日」「3日」「約2.5か月」「約1.2年」. */
export function intervalLabel(days: number): string {
  if (days < 31) return `${days}日`;
  if (days < 365) return `約${(days / 30).toFixed(1).replace(/\.0$/, '')}か月`;
  return `約${(days / 365).toFixed(1).replace(/\.0$/, '')}年`;
}
