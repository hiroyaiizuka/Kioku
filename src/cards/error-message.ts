/** Message of a thrown value, also for errors from another realm (e.g. a popout window). */
export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}
