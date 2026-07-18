import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { organizations, sessions, users } from "@/db/schema";

const SESSION_COOKIE = "centro_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
}

export async function createSession(userId: string, organizationId: string) {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
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
      organizationId: organizations.id,
      organizationName: organizations.name,
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
    organizationId: row.organizationId,
    organizationName: row.organizationName,
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
  return session;
}
