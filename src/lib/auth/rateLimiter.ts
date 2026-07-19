// Process-local, in-memory rate limiting for login attempts. A pilot runs
// as a single server instance, so this is sufficient without adding a
// shared store (Redis, etc.) — BR-13.2: security controls shall not
// introduce unnecessary operational complexity during the pilot. Revisit
// with a shared store if/when this ever runs as multiple instances.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; firstAttemptAt: number }>();

function currentEntry(key: string) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAttemptAt > WINDOW_MS) {
    return null;
  }
  return entry;
}

export function isRateLimited(key: string): boolean {
  const entry = currentEntry(key);
  return entry !== null && entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string): void {
  const entry = currentEntry(key);
  if (entry) {
    entry.count += 1;
  } else {
    attempts.set(key, { count: 1, firstAttemptAt: Date.now() });
  }
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
