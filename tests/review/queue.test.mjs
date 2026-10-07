import { describe, expect, it } from 'vitest';
import { ReviewQueue, countCards, newAllowance } from '../../src/review/queue.ts';

const card = (id, order) => ({ id, path: `n${order}.md`, question: `q${id}`, answer: `a${id}`, order });
const schedule = (dueDay) => ({ phase: 'review', dueDay, stability: 3, difficulty: 5, reps: 1, lapses: 0, lastReviewDay: '2026-09-01' });
const TODAY = '2026-10-02';

describe('new-card limit and 今日だけ追加', () => {
  it('counts today only and adds extraNew; unlimited is Infinity', () => {
    expect(newAllowance(null, TODAY, 20)).toBe(20);
    expect(newAllowance({ day: TODAY, newIntroduced: 18, extraNew: 0 }, TODAY, 20)).toBe(2);
    expect(newAllowance({ day: TODAY, newIntroduced: 20, extraNew: 10 }, TODAY, 20)).toBe(10);
    expect(newAllowance({ day: TODAY, newIntroduced: 35, extraNew: 10 }, TODAY, 20)).toBe(0);
    // Yesterday's counter and its extraNew no longer apply.
    expect(newAllowance({ day: '2026-10-01', newIntroduced: 5, extraNew: 0 }, TODAY, 20)).toBe(20);
    expect(newAllowance({ day: '2026-10-01', newIntroduced: 0, extraNew: 20 }, TODAY, 20)).toBe(20);
    expect(newAllowance({ day: TODAY, newIntroduced: 500, extraNew: 0 }, TODAY, null)).toBe(Number.POSITIVE_INFINITY);
    expect(newAllowance(null, TODAY, 0)).toBe(0);
  });
});

describe('session queue', () => {
  const states = { b: schedule('2026-10-02'), c: schedule('2026-09-20'), d: schedule('2026-10-03') };
  const lookup = (id) => states[id];
  const cards = [card('a', 1), card('b', 2), card('c', 3), card('d', 4), card('e', 5), card('f', 6), card('a', 7)];

  it('presents due cards oldest first, then new cards in note order, each ID once', () => {
    const queue = new ReviewQueue(cards, lookup, TODAY);
    expect(queue.remaining(10)).toBe(5);
    const seen = [];
    for (let card = queue.next(10); card; card = queue.next(10)) { seen.push(card.id); queue.markRated(card.id); }
    expect(seen).toEqual(['c', 'b', 'a', 'e', 'f']);
    expect(queue.rated).toBe(5);
    expect(countCards(cards.slice(0, 6), lookup, () => undefined, TODAY)).toEqual({ new: 3, learning: 0, due: 2, total: 6 });
  });

  it('splits due cards into 学習中 (last rated again) and 復習; the three columns are what a session shows', () => {
    const due = { a: schedule(TODAY), b: schedule('2026-09-28'), c: schedule(TODAY), d: schedule('2026-10-03'),
      e: schedule('2026-09-30'), f: schedule(TODAY) };
    const ratings = {
      a: { grade: 1, dueDay: TODAY },
      b: { grade: 1, dueDay: '2026-09-28' },
      c: { grade: 3, dueDay: TODAY },
      // Again but not due yet: in no column.
      d: { grade: 1, dueDay: '2026-10-03' },
      // An again that did not set the current due day (state.json is newer than the history) is not 学習中.
      e: { grade: 1, dueDay: '2026-09-25' },
      // No rating in the history (e.g. a hand-made state.json): 復習.
      // 難しい and 簡単 are not もう一度: 復習.
      g: { grade: 2, dueDay: TODAY },
      h: { grade: 4, dueDay: TODAY },
    };
    due.g = schedule(TODAY);
    due.h = schedule(TODAY);
    const all = [card('a', 1), card('b', 2), card('c', 3), card('d', 4), card('e', 5), card('f', 6), card('g', 7), card('h', 8), card('n', 9)];
    const counts = countCards(all, (id) => due[id], (id) => ratings[id], TODAY);
    expect(counts).toEqual({ new: 1, learning: 2, due: 5, total: 9 });
    // The phase is not used: Kioku's FSRS settings keep every rated card in review.
    const phased = { ...due, c: { ...schedule(TODAY), phase: 'relearning' } };
    expect(countCards(all, (id) => phased[id], (id) => ratings[id], TODAY)).toEqual(counts);
    // Learning cards are queued like any due card, so the columns add up to the session (within the new limit).
    expect(new ReviewQueue(all, (id) => due[id], TODAY).remaining(20)).toBe(counts.new + counts.learning + counts.due);
  });

  it('stops at the allowance and reports held-back new cards; skip does not use the allowance', () => {
    const queue = new ReviewQueue(cards, lookup, TODAY);
    expect(queue.remaining(1)).toBe(3);
    queue.markRated(queue.next(1).id); queue.markRated(queue.next(1).id);
    const first = queue.next(1); expect(first.id).toBe('a');
    queue.markSkipped('a');
    expect(queue.next(1).id).toBe('e');
    expect(queue.heldBack(1)).toBe(1);
    expect(queue.next(0)).toBeNull();
    expect(queue.heldBack(0)).toBe(2);
    expect(queue.skipped).toBe(1);
    queue.markSkipped('a');
    expect(queue.skipped).toBe(1);
  });
});
