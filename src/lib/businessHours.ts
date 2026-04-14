// Business hours: 9:00-18:00, Monday-Friday (Brazil timezone)

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;
const WORK_DAY_MS = (WORK_END_HOUR - WORK_START_HOUR) * 3600000; // 9h in ms

function isBusinessDay(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5; // Mon-Fri
}

function isBusinessTime(date: Date): boolean {
  if (!isBusinessDay(date)) return false;
  const h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const timeMs = (h * 3600 + m * 60 + s) * 1000;
  return timeMs >= WORK_START_HOUR * 3600000 && timeMs < WORK_END_HOUR * 3600000;
}

function getWorkStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(WORK_START_HOUR, 0, 0, 0);
  return d;
}

function getWorkEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(WORK_END_HOUR, 0, 0, 0);
  return d;
}

function getNextBusinessStart(date: Date): Date {
  const d = new Date(date);
  // If it's a business day and before work start, return work start today
  if (isBusinessDay(d)) {
    const workStart = getWorkStartOfDay(d);
    if (d.getTime() < workStart.getTime()) return workStart;
    const workEnd = getWorkEndOfDay(d);
    if (d.getTime() < workEnd.getTime()) return d; // already in business hours
  }
  // Move to next day until we find a business day
  d.setDate(d.getDate() + 1);
  d.setHours(WORK_START_HOUR, 0, 0, 0);
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Clamp a timestamp to the nearest business time.
 * If outside business hours, returns the start of the next business period.
 */
function clampToBusinessTime(ts: number): Date {
  const d = new Date(ts);
  if (isBusinessTime(d)) return d;
  return getNextBusinessStart(d);
}

/**
 * Calculate elapsed business-hours milliseconds between two timestamps.
 * Only counts time within 9:00-18:00, Mon-Fri.
 */
export function calcBusinessElapsed(startTs: number, nowTs: number): number {
  if (nowTs <= startTs) return 0;

  let elapsed = 0;
  let cursor = new Date(startTs);

  // Clamp start to business time
  if (!isBusinessTime(cursor)) {
    cursor = getNextBusinessStart(cursor);
  }

  const end = new Date(nowTs);

  while (cursor.getTime() < end.getTime()) {
    if (!isBusinessDay(cursor)) {
      // Skip to next business day
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(WORK_START_HOUR, 0, 0, 0);
      continue;
    }

    const workStart = getWorkStartOfDay(cursor);
    const workEnd = getWorkEndOfDay(cursor);

    // If cursor is before work start, jump to work start
    if (cursor.getTime() < workStart.getTime()) {
      cursor = workStart;
    }

    // If cursor is at or past work end, jump to next day
    if (cursor.getTime() >= workEnd.getTime()) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(WORK_START_HOUR, 0, 0, 0);
      continue;
    }

    // Calculate time in this business period
    const periodEnd = end.getTime() < workEnd.getTime() ? end : workEnd;
    elapsed += periodEnd.getTime() - cursor.getTime();

    // Move to next day
    cursor = new Date(workEnd);
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(WORK_START_HOUR, 0, 0, 0);
  }

  return Math.max(0, elapsed);
}

/**
 * Calculate remaining business-hours milliseconds for an SLA limit.
 */
export function calcBusinessRemaining(startTs: number, nowTs: number, limitMs: number): number {
  const elapsed = calcBusinessElapsed(startTs, nowTs);
  return limitMs - elapsed;
}

/**
 * Get the next business time from a given timestamp.
 */
export function getNextBusinessTime(ts: number): Date {
  return getNextBusinessStart(new Date(ts));
}

/**
 * Check if we are currently within business hours.
 */
export function isCurrentlyBusinessHours(now: Date): boolean {
  return isBusinessTime(now);
}
