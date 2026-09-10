/** Discord's own elapsed clock: minutes and seconds until the first hour, then hours in front. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}
