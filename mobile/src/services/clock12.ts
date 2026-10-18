/**
 * 12-hour clock helpers: every time the app shows or asks for is "h:mm AM/PM", whatever the phone's
 * region setting. Built by hand on purpose (not `toLocaleTimeString`), because a phone set to a
 * 24-hour region would otherwise print "14:30". Internally times stay 24-hour "HH:MM" strings and
 * UTC instants; only the presentation and the typed input are 12-hour. Pure.
 */

export type Meridiem = 'AM' | 'PM';

/** "2:30 PM" for a Date's local time. */
export function formatTime12(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Local "2:30 PM" for an ISO instant; '' when it does not parse. */
export function formatIsoTime12(iso: string): string {
  return formatTime12(new Date(iso));
}

/** "14:30" -> { text: "2:30", meridiem: "PM" }; null when it is not a valid 24-hour "H:MM". */
export function hhmmTo12(hhmm: string): { text: string; meridiem: Meridiem } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { text: `${h % 12 === 0 ? 12 : h % 12}:${m[2]}`, meridiem: h < 12 ? 'AM' : 'PM' };
}

/** "07:30" -> "7:30 AM" for display; the input unchanged when it is not a valid 24-hour time. */
export function formatHhmm12(hhmm: string): string {
  const t = hhmmTo12(hhmm);
  return t ? `${t.text} ${t.meridiem}` : hhmm;
}

export type ParsedClock = { ok: true; hhmm: string; meridiem: Meridiem } | { ok: false };

/**
 * Reads what the person typed plus the AM/PM choice and returns the 24-hour "HH:MM".
 * Accepts "2:30", "230", "2", "2:30 pm" (a typed am/pm wins over the chips) and, for convenience,
 * "14:30" (an hour of 13 to 23 is already 24-hour, so the AM/PM choice is ignored and corrected).
 * "12" with AM is midnight, with PM is noon. Minutes must be 00-59.
 */
export function parseClock12(text: string, meridiem: Meridiem): ParsedClock {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return { ok: false };
  const hourTyped = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59) return { ok: false };
  let chosen: Meridiem = meridiem;
  if (m[3]) chosen = m[3].startsWith('p') ? 'PM' : 'AM';

  let hour24: number;
  if (hourTyped >= 13 && hourTyped <= 23) {
    hour24 = hourTyped;
    chosen = 'PM';
  } else if (hourTyped === 0) {
    hour24 = 0;
    chosen = 'AM';
  } else if (hourTyped >= 1 && hourTyped <= 12) {
    hour24 = (hourTyped % 12) + (chosen === 'PM' ? 12 : 0);
  } else {
    return { ok: false };
  }
  return { ok: true, hhmm: `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, meridiem: chosen };
}
