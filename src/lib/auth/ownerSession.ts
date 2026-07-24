import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { platformOwners, platformOwnerSessions } from "@/db/schema";

// Deliberately separate from src/lib/auth/session.ts's cookie/session
// system rather than an extension of it — see the Owner Dashboard plan's
// Authentication & Security section for the full rationale. Same recipe
// (opaque random id in an httpOnly cookie, no crypto in the cookie itself),
// own cookie name and own table, so a regular customer session and an
// owner session can never collide or escalate into each other.
const OWNER_SESSION_COOKIE = "centro_owner_session";
// One fixed duration — unlike the customer-facing login there's no product
// reason for a "remember me" toggle here (there is exactly one owner).
const OWNER_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface OwnerSession {
  sessionId: string;
  platformOwnerId: string;
  email: string;
}

export async function createOwnerSession(platformOwnerId: string) {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + OWNER_SESSION_DURATION_MS);
  const [session] = await db
    .insert(platformOwnerSessions)
    .values({ platformOwnerId, expiresAt })
    .returning({ id: platformOwnerSessions.id });

  const cookieStore = await cookies();
  cookieStore.set(OWNER_SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // Defense-in-depth only (the guard is what actually protects data) —
    // scoping the cookie to /owner means it's never sent on any of the
    // ~40 existing customer-facing routes.
    path: "/owner",
    expires: expiresAt,
  });
}

// Deduped per request via React's cache(), matching getSession()'s own
// precedent — a layout and the pages/actions it wraps share one lookup.
export const getOwnerSession = cache(async (): Promise<OwnerSession | null> => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(OWNER_SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const db = await getDb();
  const [row] = await db
    .select({
      sessionId: platformOwnerSessions.id,
      expiresAt: platformOwnerSessions.expiresAt,
      platformOwnerId: platformOwners.id,
      email: platformOwners.email,
    })
    .from(platformOwnerSessions)
    .innerJoin(platformOwners, eq(platformOwnerSessions.platformOwnerId, platformOwners.id))
    .where(eq(platformOwnerSessions.id, sessionId))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() < Date.now()) {
    await destroyOwnerSession();
    return null;
  }

  return {
    sessionId: row.sessionId,
    platformOwnerId: row.platformOwnerId,
    email: row.email,
  };
});

export async function destroyOwnerSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(OWNER_SESSION_COOKIE)?.value;
  if (sessionId) {
    const db = await getDb();
    await db.delete(platformOwnerSessions).where(eq(platformOwnerSessions.id, sessionId));
  }
  cookieStore.delete({ name: OWNER_SESSION_COOKIE, path: "/owner" });
}

// The one guard every owner-only page, layout, and Server Action must call.
// A layout only protects the pages it wraps, not the Server Actions those
// pages invoke (a Server Action is independently callable regardless of
// which page rendered it — the same reason src/app/(app)/assistant/actions.ts
// re-checks requireSession() in every action despite its layout already
// gating the page). A missed check here is a materially worse leak than
// elsewhere in the app: it exposes every tenant's data at once.
export async function requireOwnerSession(): Promise<OwnerSession> {
  const session = await getOwnerSession();
  if (!session) {
    redirect("/owner/login");
  }
  return session;
}
