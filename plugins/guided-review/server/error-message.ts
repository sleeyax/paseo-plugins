/** What went wrong, as a sentence the panel can show: an error's message, or whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
