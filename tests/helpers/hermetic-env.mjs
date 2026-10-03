// Test children must never join the developer's Mac-wide heavy-job queue (LEV-305). An opted-in `npm run check` exports
// KIOKU_HEAVY_QUEUE=1 (and its runner passes ORCA_HEAVY_QUEUE_TOKEN), so a simulated smoke or harness CLI started by a
// test would otherwise consult the real queue and (rightly) refuse outside a native slot.
export const heavyQueueVariables = ['KIOKU_HEAVY_QUEUE', 'ORCA_HEAVY_QUEUE_DIR', 'ORCA_HEAVY_QUEUE_TOKEN'];

/** A copy of `env` without the heavy-job queue variables. */
export function withoutHeavyQueue(env = process.env) {
  const copy = { ...env };
  for (const key of heavyQueueVariables) delete copy[key];
  return copy;
}
