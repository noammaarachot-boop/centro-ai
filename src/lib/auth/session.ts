import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { organizations, sessions, users } from "@/db/schema";

const SESSION_COOKIE = "centro_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// UX Polish M6 — "Remember Me" unchecked. Applies to both the cookie and
// the DB session row's own expiresAt, so an unchecked login is genuinely
// shorter-lived server-side too, not just a shorter browser cookie.
const SHORT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day

export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  organizationId: string;
  organizationName: string;
  // Owner Dashboard Phase 5 — null unless the platform owner has
  // suspended this organization. Enforced in requireSession() below,
  // not here: getSession()'s existing null/non-null return contract is
  // relied on unchanged by callers like the login page and
  // redirectAfterAuth(), so a suspended org still gets a real Session
  // object back from getSession() itself.
  organizationSuspendedAt: Date | null;
  // Internal QA Mode — null unless the platform owner has marked this
  // organization for QA testing (src/app/owner/(dashboard)/organizations/
  // [id]/actions.ts). Not enforced here — it's a permission grant, not a
  // lockout, so it never blocks a request the way organizationSuspendedAt
  // does. Callers that need to honor it (onboarding's finishOnboarding)
  // read it straight off the session, which is exactly as trustworthy as
  // organizationSuspendedAt already is: sourced from this same DB join,
  // never from client-supplied input.
  organizationQaModeEnabledAt: Date | null;
}

// `rememberMe` defaults to true so every existing caller (register(), and
// login() when the checkbox is unavailable/unchecked-by-omission) keeps
// today's exact 30-day behavior unless it explicitly opts into the short
// duration.
export async function createSession(
  userId: string,
  organizationId: string,
  rememberMe: boolean = true
) {
  const db = await getDb();
  const expiresAt = new Date(
    Date.now() + (rememberMe ? SESSION_DURATION_MS : SHORT_SESSION_DURATION_MS)
  );
  const [session] = await db
    .insert(sessions)
    .values({ userId, organizationId, expiresAt })
    .returning({ id: sessions.id });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

// Deduped per request via React's cache() so a layout and the pages it
// wraps share one lookup instead of querying the session on every level.
export const getSession = cache(async (): Promise<Session | null> => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const db = await getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSuspendedAt: organizations.suspendedAt,
      organizationQaModeEnabledAt: organizations.qaModeEnabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(sessions.organizationId, organizations.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() < Date.now()) {
    await destroySession();
    return null;
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    fullName: row.fullName,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSuspendedAt: row.organizationSuspendedAt,
    organizationQaModeEnabledAt: row.organizationQaModeEnabledAt,
  };
});

export async function destroySession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  cookieStore.delete(SESSION_COOKIE);
}

// Next.js recommends verifying auth inside each protected route/action
// rather than relying on proxy.ts alone (a matcher change can silently
// remove coverage) — this is the single guard every protected page calls.
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  // Owner Dashboard Phase 5 — checked here, not inside getSession(), so
  // this is the one gate every protected page/action already goes
  // through (same reasoning as the rest of this comment). /suspended
  // itself reads getSession() directly rather than calling
  // requireSession(), so it can never redirect into itself.
  if (session.organizationSuspendedAt) {
    redirect("/suspended");
  }
  return session;
}
