export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isPastOrNow(iso: string, reference = nowIso()): boolean {
  return Date.parse(iso) <= Date.parse(reference);
}

/** "2026-09-01T10:00:00.000Z" -> "2026-09-01" */
export function isoDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}
