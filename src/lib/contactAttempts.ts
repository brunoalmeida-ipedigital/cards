// Contact attempt scheduling logic
// Attempts 2-6 are scheduled for the next business day, between 9-11am

function isBusinessDay(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function getNextBusinessDay(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  d.setHours(9, 0, 0, 0);
  return d;
}

/**
 * Given the date of the last attempt, returns the date when the next attempt should happen.
 * Always the next business day at 9:00.
 */
export function getNextAttemptDate(lastAttemptDate: Date): Date {
  return getNextBusinessDay(lastAttemptDate);
}

/**
 * Determine if the button for a given attempt should blink.
 * It blinks if:
 * 1. The previous attempt was done
 * 2. The current attempt is NOT done
 * 3. Today is the scheduled day (next business day after previous attempt)
 * 4. Current time is between 9:00 and 11:00
 */
export function shouldBlink(
  attemptIndex: number, // 0-based (attempt 2 = index 1)
  tentativas: boolean[],
  tentativasDatas: Record<string, string>, // { "0": "2026-04-14T10:30:00", ... }
  now: Date
): boolean {
  // Attempt 1 (index 0) never blinks, it's automatic
  if (attemptIndex === 0) return false;

  // Previous attempt must be done
  if (!tentativas[attemptIndex - 1]) return false;

  // Current attempt must NOT be done
  if (tentativas[attemptIndex]) return false;

  // Get the date of the previous attempt
  const prevDateStr = tentativasDatas[String(attemptIndex - 1)];
  if (!prevDateStr) return false;

  const prevDate = new Date(prevDateStr);
  if (isNaN(prevDate.getTime())) return false;

  // Calculate the scheduled date (next business day)
  const scheduledDate = getNextAttemptDate(prevDate);

  // Check if today matches the scheduled day (or is after it)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const scheduledStart = new Date(scheduledDate);
  scheduledStart.setHours(0, 0, 0, 0);

  if (todayStart.getTime() < scheduledStart.getTime()) return false;

  // If today is after scheduled date, still blink (overdue)
  // If today matches, check time window 9-11
  if (todayStart.getTime() === scheduledStart.getTime()) {
    const hour = now.getHours();
    return hour >= 9 && hour < 11;
  }

  // Overdue: always blink during business hours
  if (isBusinessDay(now)) {
    const hour = now.getHours();
    return hour >= 9 && hour < 18;
  }

  return false;
}

/**
 * Get the message to send to Pipefy for a contact attempt.
 */
export function getAttemptMessage(attemptNumber: number): string {
  return `${attemptNumber}ª tentativa de contato com cliente`;
}

/**
 * Get the "checking with client" message.
 */
export function getCheckingMessage(): string {
  return "Verificando status com o cliente";
}
