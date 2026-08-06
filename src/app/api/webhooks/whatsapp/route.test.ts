import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { CONFIRM_NO_BUTTON_ID, CONFIRM_YES_BUTTON_ID } from "@/lib/pendingConfirmations";
import { isUniqueViolation, resolveInteractiveReplyText } from "./route";

// WhatsApp Interactive Reply Buttons — mandatory scenario "הלקוח לוחץ על
// כפתור". A button tap arrives with no message.text at all; this proves
// the normalization into plain "כן"/"לא" text (which every existing
// resolver already understands) is correct, without needing a full
// signed-webhook-POST integration harness.
describe("resolveInteractiveReplyText", () => {
  it("normalizes the confirm-yes button id to \"כן\"", () => {
    const message = {
      from: "972500000000",
      id: "wamid.1",
      type: "interactive",
      interactive: { type: "button", button_reply: { id: CONFIRM_YES_BUTTON_ID, title: "כן" } },
    };
    expect(resolveInteractiveReplyText(message)).toBe("כן");
  });

  it("normalizes the confirm-no button id to \"לא\"", () => {
    const message = {
      from: "972500000000",
      id: "wamid.2",
      type: "interactive",
      interactive: { type: "button", button_reply: { id: CONFIRM_NO_BUTTON_ID, title: "לא" } },
    };
    expect(resolveInteractiveReplyText(message)).toBe("לא");
  });

  it("returns null for a plain text message (no interactive payload)", () => {
    const message = { from: "972500000000", id: "wamid.3", type: "text", text: { body: "כן" } };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });

  it("never guesses an unrecognized button id", () => {
    const message = {
      from: "972500000000",
      id: "wamid.4",
      type: "interactive",
      interactive: { type: "button", button_reply: { id: "some_other_id", title: "?" } },
    };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });

  it("returns null for a non-button interactive type (e.g. a list reply)", () => {
    const message = { from: "972500000000", id: "wamid.5", type: "interactive", interactive: { type: "list_reply" } };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });
});

// isUniqueViolation is the backstop behind the webhook's fast-path
// idempotency check (see handleInboundMessage) — it decides whether a
// thrown DB error is the *expected* outcome of two redelivered webhooks
// racing to insert the same WhatsApp message, or a genuinely unexpected
// failure that should be logged and surfaced. Getting the error shape
// wrong (assuming a `.code`/`.constraint_name` shape postgres-js doesn't
// actually produce) would either swallow real bugs or spam false alarms
// for every duplicate webhook delivery — worth proving against a real
// Postgres engine (PGlite), not just a guessed error shape.
describe("isUniqueViolation", () => {
  it("recognizes a real unique-constraint violation on documents.whatsapp_message_id", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db as never, { migrationsFolder: "./drizzle" });

    const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
    const [clientRow] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "Client", phone: "+972500000000" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p" })
      .returning();

    await db.insert(schema.documents).values({
      organizationId: org.id,
      collectionRequestId: request.id,
      fileName: "a.jpg",
      whatsappMessageId: "wamid.same",
    });

    let caught: unknown = null;
    try {
      await db.insert(schema.documents).values({
        organizationId: org.id,
        collectionRequestId: request.id,
        fileName: "b.jpg",
        whatsappMessageId: "wamid.same",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught, "documents_whatsapp_message_id_idx")).toBe(true);
  }, 30_000);

  it("does not match a differently-named constraint (never swallows an unrelated unique violation)", () => {
    const fakeError = { code: "23505", constraint_name: "some_other_constraint" };
    expect(isUniqueViolation(fakeError, "documents_whatsapp_message_id_idx")).toBe(false);
  });

  it("does not match a non-unique-violation error", () => {
    const fakeError = { code: "23503", constraint_name: "documents_whatsapp_message_id_idx" };
    expect(isUniqueViolation(fakeError, "documents_whatsapp_message_id_idx")).toBe(false);
  });

  it("handles non-object errors safely", () => {
    expect(isUniqueViolation("plain string error", "documents_whatsapp_message_id_idx")).toBe(false);
    expect(isUniqueViolation(null, "documents_whatsapp_message_id_idx")).toBe(false);
    expect(isUniqueViolation(undefined, "documents_whatsapp_message_id_idx")).toBe(false);
  });
});
