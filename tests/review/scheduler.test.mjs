import { describe, expect, it } from 'vitest';
import { SCHEDULER_ID, intervalLabel, previewIntervals, rateCard } from '../../src/review/scheduler.ts';
import { addDays, dayNoonUtc } from '../../src/review/day.ts';
import { contentHash, createReviewEvent } from '../../src/review/event.ts';
import { validateEvent } from '../../src/store/schema.ts';

const DAY = '2026-10-02';

describe('FSRS integration (ts-fsrs 5.4.2, retention 0.9, no short-term steps, no fuzz)', () => {
  it('schedules a new card Again 1 / Hard 2 / Good 3 / Easy 8 days, as decided', () => {
    expect(previewIntervals(null, DAY)).toEqual({ 1: 1, 2: 2, 3: 3, 4: 8 });
    const expected = { 1: '2026-10-03', 2: '2026-10-04', 3: '2026-10-05', 4: '2026-10-10' };
    for (const grade of [1, 2, 3, 4]) {
      const { schedule, scheduledDays, elapsedDays } = rateCard(null, DAY, grade);
      expect(schedule.dueDay).toBe(expected[grade]);
      expect(scheduledDays).toBe({ 1: 1, 2: 2, 3: 3, 4: 8 }[grade]);
      expect(elapsedDays).toBe(0);
      expect(schedule).toMatchObject({ phase: 'review', reps: 1, lapses: 0, lastReviewDay: DAY });
    }
    expect(rateCard(null, DAY, 3).schedule.stability).toBeCloseTo(2.3065, 3);
    expect(SCHEDULER_ID).toBe('ts-fsrs@5.4.2');
  });

  it('gives the same intervals for any day (UTC-noon normalisation), including DST transition days', () => {
    for (const day of ['2026-03-08', '2026-03-29', '2026-11-01', '2026-10-25', '2026-12-31', '2028-02-29']) {
      expect(previewIntervals(null, day)).toEqual({ 1: 1, 2: 2, 3: 3, 4: 8 });
      expect(rateCard(null, day, 4).schedule.dueDay).toBe(addDays(day, 8));
    }
  });

  it('continues from the stored schedule on time: Good after 3 days grows the interval; Again counts a lapse', () => {
    const first = rateCard(null, DAY, 3).schedule;
    const onTime = first.dueDay;
    const good = rateCard(first, onTime, 3);
    expect(good.elapsedDays).toBe(3);
    expect(good.scheduledDays).toBe(14);
    expect(good.schedule).toMatchObject({ reps: 2, lapses: 0, lastReviewDay: onTime });
    const again = rateCard(first, onTime, 1);
    expect(again.scheduledDays).toBe(1);
    expect(again.schedule.lapses).toBe(1);
    expect(previewIntervals(first, onTime)).toEqual({ 1: 1, 2: 9, 3: 14, 4: 24 });
  });

  it('never schedules the same Kioku day, whatever the grade', () => {
    let schedule = null;
    for (let index = 0; index < 6; index += 1) {
      const outcome = rateCard(schedule, DAY, 1);
      expect(outcome.schedule.dueDay > DAY).toBe(true);
      expect(outcome.scheduledDays).toBeGreaterThanOrEqual(1);
      schedule = outcome.schedule;
    }
  });

  it('does not leave ts-fsrs Date.prototype helpers on the shared global', () => {
    for (const name of ['scheduler', 'diff', 'format', 'dueFormat']) expect(name in Date.prototype).toBe(false);
  });

  it('labels intervals briefly', () => {
    expect([1, 30, 45, 400].map(intervalLabel)).toEqual(['1日', '30日', '約1.5か月', '約1.1年']);
  });
});

describe('history event', () => {
  it('records the rating, the schedule after it, the content hash and the scheduler, with a stable eventId', async () => {
    const random = () => Uint8Array.from({ length: 20 }, (_, index) => index);
    const now = new Date(2026, 9, 2, 9, 30);
    const card = { question: '光合成とは？', answer: '光で糖を作る反応' };
    const event = await createReviewEvent({ cardId: 'kioku-abcdefghij', card, before: null, grade: 3, now, dayStartHour: 4, random });
    expect(event).toMatchObject({ v: 1, eventId: 'kioku-abcdefghij:0123456789', cardId: 'kioku-abcdefghij', at: now.getTime(),
      day: '2026-10-02', grade: 3, phaseBefore: 'new', elapsedDays: 0, scheduledDays: 3, phase: 'review', dueDay: '2026-10-05',
      reps: 1, lapses: 0, scheduler: 'ts-fsrs@5.4.2' });
    expect(event.contentHash).toBe(await contentHash(card));
    expect(event.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await contentHash({ ...card, answer: '別の答え' })).not.toBe(event.contentHash);
    expect(validateEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(dayNoonUtc(event.day).toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });
});
