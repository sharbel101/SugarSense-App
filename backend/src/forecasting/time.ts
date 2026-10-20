/**
 * Local-time helpers kept OUT of the pure engine (the spec: no Date inside the core, because DST rules
 * differ between runtimes). The service layer turns an instant + IANA zone into minutes after local
 * midnight once, and the engine only ever sees resolved numbers.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight (0-1439) at the given UTC instant. Falls back to UTC for an invalid zone. */
export function localMinuteOfDay(tSec: number, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(tSec * 1000));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

export const toSec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
export const toIso = (sec: number): string => new Date(sec * 1000).toISOString();

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar day (YYYY-MM-DD) of an instant, where the "day" starts at `dayStartHour` local time (default 03:00) rather than midnight. */
export function localDayKey(tSec: number, timeZone: string, dayStartHour = 3): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  let f = dayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(tz, f);
  }
  return f.format(new Date((tSec - dayStartHour * 3600) * 1000));
}

/** Unix seconds of the most recent local `dayStartHour`:00 at or before `tSec` (within about an hour on a daylight-saving change day). */
export function localDayStartSec(tSec: number, timeZone: string, dayStartHour = 3): number {
  const sinceStartMin = (localMinuteOfDay(tSec, timeZone) - dayStartHour * 60 + 1440) % 1440;
  return tSec - sinceStartMin * 60;
}
