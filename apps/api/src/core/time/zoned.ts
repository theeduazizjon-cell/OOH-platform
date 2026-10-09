/**
 * The instant at which a calendar date reaches `hour`:00 in a time zone (DST-aware, no library):
 * e.g. 17:00 on 2026-10-20 in Europe/Bucharest (EEST, UTC+3) is 14:00 UTC.
 */
export function atLocalTime(date: string, hour: number, timeZone: string): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  const guess = new Date(`${date}T${pad(hour)}:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const shownAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  // The zone's offset at that moment, removed from the guess.
  return new Date(guess.getTime() - (shownAsUtc - guess.getTime()));
}
