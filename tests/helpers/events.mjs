/** A valid schema-1 history event for tests. */
export const event = (card, suffix, { day = '2026-10-02', dueDay = '2026-10-05', phaseBefore = 'new', reps = 1 } = {}) => ({
  v: 1, eventId: `kioku-${card}:${suffix.padEnd(10, '0')}`, cardId: `kioku-${card}`, at: 1_790_000_000_000, day, grade: 3,
  phaseBefore, elapsedDays: 0, scheduledDays: 3, phase: 'review', dueDay, stability: 2.3, difficulty: 2.1, reps, lapses: 0,
  contentHash: 'sha256:00', scheduler: 'ts-fsrs@5.4.2',
});
