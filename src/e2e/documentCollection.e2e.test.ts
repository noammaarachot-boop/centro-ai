import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { makeTestDocument, type TestDocument } from "./fixtures";
import { CONFIRM_NO_BUTTON_ID, CONFIRM_YES_BUTTON_ID } from "@/lib/pendingConfirmations";
import { seedApprovedWhatsAppTemplates } from "@/test/whatsappFixtures";

/**
 * Document-collection engine — comprehensive, re-runnable, end-to-end
 * suite. Unlike the unit/integration tests scattered across src/lib/**,
 * every scenario here goes through the REAL exported webhook POST handler
 * (src/app/api/webhooks/whatsapp/route.ts), including REAL HMAC-SHA256
 * signature verification against a test app secret — this is the same
 * code path a genuine Meta webhook delivery hits in production, not an
 * internal function called directly.
 *
 * What's real: every business-logic module (classification routing,
 * requirement satisfaction, identity checks, case review, completion,
 * extension, deferral, PDF merging, audit trail) runs unmocked, against a
 * real Postgres-compatible database (PGlite).
 *
 * What's simulated (and exactly why): the three genuinely external
 * boundaries this process cannot reach from an automated test run —
 *   1. Meta's real Graph API (no real WHATSAPP_SYSTEM_USER_TOKEN exists in
 *      this environment; see the session's final report for confirmation
 *      this was verified, not assumed) — sendTextMessage/sendTemplateMessage/
 *      sendInteractiveButtonsMessage and downloadMedia are mocked at their
 *      own module boundary, with every call still recorded and asserted on.
 *   2. Google Drive's real API (same reasoning — no real Drive access
 *      token available here) — mocked with a realistic in-memory
 *      filesystem model (folders, files, real content bytes, real merged
 *      PDFs via the actual pdf-lib code path) so folder-structure and
 *      file-content assertions are still meaningful, not just "was called."
 *   3. The AI model provider — mocked via generateObject, with each
 *      scenario declaring the exact classification result a real model
 *      would very plausibly return for that message, in the same style
 *      every other test in this codebase already uses.
 *
 * Every "document" sent in these scenarios is a synthetic fixture (see
 * ./fixtures.ts), clearly labeled "מסמך בדיקה בלבד — לא מסמך אמיתי".
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const TEST_APP_SECRET = "e2e-test-app-secret-not-real";
vi.mock("@/lib/whatsapp/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/config")>("@/lib/whatsapp/config");
  return {
    ...actual,
    getWhatsAppConfig: () => ({
      appId: "e2e-test-app-id",
      appSecret: TEST_APP_SECRET,
      systemUserToken: "e2e-test-system-user-token",
      oauthRedirectUri: null,
      webhookVerifyToken: "e2e-test-verify-token",
    }),
  };
});

// ---- WhatsApp send/media boundary -----------------------------------
const sentMessages: Array<{ kind: "text" | "template" | "interactive"; to: string; body: string; extra?: unknown }> = [];
const sendTextMessage = vi.fn(async (_phoneNumberId: string, to: string, body: string) => {
  sentMessages.push({ kind: "text", to, body });
  console.log("[e2e] outbound text", { to: to.slice(-4), body });
  return { messageId: `wamid.out.${sentMessages.length}` };
});
const sendTemplateMessage = vi.fn(async (_phoneNumberId: string, to: string, templateName: string, _lang: string, params?: unknown) => {
  sentMessages.push({ kind: "template", to, body: templateName, extra: params });
  console.log("[e2e] outbound template", { to: to.slice(-4), templateName, params });
  return { messageId: `wamid.out.${sentMessages.length}` };
});
const sendInteractiveButtonsMessage = vi.fn(async (_phoneNumberId: string, to: string, bodyText: string, buttons: unknown) => {
  sentMessages.push({ kind: "interactive", to, body: bodyText, extra: buttons });
  console.log("[e2e] outbound interactive", { to: to.slice(-4), bodyText });
  return { messageId: `wamid.out.${sentMessages.length}` };
});
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: Parameters<typeof sendTextMessage>) => sendTextMessage(...args),
    sendTemplateMessage: (...args: Parameters<typeof sendTemplateMessage>) => sendTemplateMessage(...args),
    sendInteractiveButtonsMessage: (...args: Parameters<typeof sendInteractiveButtonsMessage>) => sendInteractiveButtonsMessage(...args),
  };
});

const mediaByWamid = new Map<string, { bytes: Buffer; mimeType: string }>();
vi.mock("@/lib/whatsapp/media", () => ({
  downloadMedia: async (mediaId: string) => {
    const found = mediaByWamid.get(mediaId);
    if (!found) throw new Error(`[e2e] no fixture registered for media id ${mediaId}`);
    console.log("[e2e] downloadMedia", { mediaId, byteLength: found.bytes.length, mimeType: found.mimeType });
    return found;
  },
}));

// ---- Google Drive boundary (realistic in-memory filesystem) ---------
interface FakeFolder {
  id: string;
  name: string;
  parentId: string;
  properties?: Record<string, string>;
  trashed?: boolean;
}
interface FakeFile {
  id: string;
  name: string;
  parentId: string;
  content?: Buffer;
  mimeType?: string;
}
let fakeFolders: FakeFolder[] = [];
let fakeFiles: FakeFile[] = [];
let nextDriveId = 1;
// Deliberately NEVER reset in beforeEach (unlike nextDriveId, which is
// purely cosmetic for readable fake Drive ids) — the PGlite instance is
// shared across every test in this file (beforeAll, not beforeEach), so
// each seeded organization needs a genuinely unique whatsappPhoneNumberId
// or two journeys' webhook traffic can resolve to the wrong organization
// entirely (a real bug this fixture bug would otherwise mask, not surface).
let nextOrgSeq = 1;

vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return { ...actual, getValidAccessToken: async () => "e2e-fake-drive-token" };
});

vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return {
    ...actual,
    createDriveFolder: vi.fn(async (_t: string, name: string, parentId?: string, properties?: Record<string, string>) => {
      const id = `folder-${nextDriveId++}`;
      fakeFolders.push({ id, name, parentId: parentId ?? "", properties });
      console.log("[e2e] Drive createFolder", { id, name, parentId });
      return { id, name };
    }),
    findFoldersByName: vi.fn(async (_t: string, parentId: string, name: string) =>
      fakeFolders.filter((f) => f.parentId === parentId && f.name === name && !f.trashed).map((f) => ({ id: f.id, name: f.name }))
    ),
    findFolderByClientProperty: vi.fn(async (_t: string, parentId: string, clientId: string) => {
      const found = fakeFolders.find((f) => f.parentId === parentId && !f.trashed && f.properties?.centroClientId === clientId);
      return found ? { id: found.id, name: found.name } : null;
    }),
    setFolderClientProperty: vi.fn(async (_t: string, folderId: string, clientId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.properties = { ...folder.properties, centroClientId: clientId };
    }),
    listFolderFiles: vi.fn(async (_t: string, folderId: string) =>
      fakeFiles.filter((f) => f.parentId === folderId).map((f) => ({ id: f.id, name: f.name, webViewLink: null }))
    ),
    moveDriveFile: vi.fn(async (_t: string, fileId: string, _from: string, toParentId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.parentId = toParentId;
    }),
    trashDriveFolder: vi.fn(async (_t: string, folderId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.trashed = true;
    }),
    uploadDriveFile: vi.fn(async (_t: string, options: { name: string; parentId: string; mimeType?: string; content?: Buffer }) => {
      const id = `file-${nextDriveId++}`;
      fakeFiles.push({ id, name: options.name, parentId: options.parentId, content: options.content, mimeType: options.mimeType });
      console.log("[e2e] Drive uploadFile", { id, name: options.name, parentId: options.parentId, mimeType: options.mimeType });
      return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
    }),
    renameDriveFile: vi.fn(async (_t: string, fileId: string, newName: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.name = newName;
      console.log("[e2e] Drive renameFile", { fileId, newName });
    }),
    downloadDriveFile: vi.fn(async (_t: string, fileId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (!file) throw new Error(`[e2e] fake drive file ${fileId} not found`);
      return { bytes: file.content ?? Buffer.from(""), mimeType: file.mimeType ?? "application/octet-stream" };
    }),
    updateDriveFileContent: vi.fn(async (_t: string, fileId: string, content: Buffer, mimeType: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) {
        file.content = content;
        file.mimeType = mimeType;
      }
      console.log("[e2e] Drive updateFileContent", { fileId, mimeType, byteLength: content.length });
    }),
  };
});

// ---- AI vision classifier boundary (document classification) --------
const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

// ---- Shared text-classifier boundary (generateObject/generateText/resolveLanguageModel) ----
// Every AI-backed text classifier in this codebase (deferral intent,
// follow-up intent, reopen intent, document-relation intent, yes/no,
// request-message intent, requirement semantics, and the two-call
// conversation-understanding pipeline below) goes through this one pair —
// queued per call, in the exact order route.ts's own resolver chain
// invokes them, matching this whole codebase's established test
// convention (vitest's own mockResolvedValueOnce queue) rather than
// content-sniffing the prompt text.
const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  generateText: (...args: unknown[]) => generateText(...args),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

// The unified conversation-understanding layer (src/lib/conversation/) now
// runs on EVERY inbound text message, by design — no deterministic
// shortcut exists anymore even for a bare "כן"/"לא" (this is the whole
// point of the architecture: no message bypasses real understanding).
// Phase 4 cutover: this is no longer one generateObject call — it's TWO,
// each with its own prompt and schema: resolveConversationReference
// (referenceResolution.ts) runs first, then reasonAboutMessage
// (conversationUnderstanding.ts). To avoid hand-queuing an explicit
// mockResolvedValueOnce pair for every single such message across this
// large file, a smart default mockImplementation (set fresh in beforeEach,
// below any test's own explicit mockResolvedValueOnce calls in the queue —
// vitest always drains queued once-values first) recognizes each of the
// two prompts by a marker unique to its own template and answers the
// mechanical common case correctly: reference resolution always defaults
// to "no reference" (none of these scenarios exercise pronoun/ordinal
// resolution — that is Phase 2's own dedicated test coverage elsewhere);
// reasoning defaults to a bare "כן"/"לא" against exactly one open question
// resolving it, "סיימתי" with no open question finishing the request, and
// anything else defaulting to the safe "unrelated" reading — so a test
// that needs something more specific (a correction, a deferral promise, a
// review question, a real answer, ...) still queues its own mock for it,
// exactly as before.
const REFERENCE_RESOLUTION_PROMPT_MARKER = "המטרה כאן אינה לענות על ההודעה";
const REASONING_PROMPT_MARKER = "שלח הודעה חדשה. Centro עוסק אך ורק בתחום המסמכים";

function referenceResolutionSmartDefault(args: unknown): { object: Record<string, unknown> } | undefined {
  const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content;
  if (typeof content !== "string" || !content.includes(REFERENCE_RESOLUTION_PROMPT_MARKER)) return undefined;
  return {
    object: { status: "no_reference", referentKind: null, referentId: null, provenance: null, confidence: 0.9, basis: null, ambiguousCandidateIds: null },
  };
}

// Root-cause fix (production incident, 2026-08-15) — reasonAboutMessage's
// real schema is now a discriminated union (by outcome, and — inside ACT —
// by actionKind), not one flat object with every field nullable. Every
// mock built here matches that real shape: only the fields the chosen
// branch actually declares, nothing else.
function reasoningSmartDefault(args: unknown): { object: Record<string, unknown> } | undefined {
  const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content;
  if (typeof content !== "string" || !content.includes(REASONING_PROMPT_MARKER)) return undefined;
  const messageMatch = content.match(/ההודעה החדשה מהלקוח: "([^"]*)"/);
  const newMessage = messageMatch?.[1]?.trim() ?? "";
  const openQuestionMatch = content.match(/שאלה פתוחה שממתינה לתשובה כרגע \(סוג: [^,]+, id=([^)]+)\):/);
  const openQuestionId = openQuestionMatch?.[1] ?? null;
  if (openQuestionId && newMessage === "כן") {
    return { object: { outcome: "ACT", confidence: 0.9, action: { actionKind: "resolve_pending", actionOpenQuestionId: openQuestionId, actionAnswer: "confirm" } } };
  }
  if (openQuestionId && newMessage === "לא") {
    return { object: { outcome: "ACT", confidence: 0.9, action: { actionKind: "resolve_pending", actionOpenQuestionId: openQuestionId, actionAnswer: "decline" } } };
  }
  if (!openQuestionId && newMessage === "סיימתי") {
    return { object: { outcome: "ACT", confidence: 0.9, action: { actionKind: "finish_request" } } };
  }
  return { object: { outcome: "UNRELATED", confidence: 0 } };
}

// composeGroundedAnswer (conversationUnderstanding.ts) is a plain
// generateText call — the real production prompt embeds the exact,
// code-validated fact set (never invented) as "- label: detail" lines.
// Echoing those lines back is more faithful than a canned string: it
// proves the real fact pool (buildGroundedFactPool, including this
// session's own fix for partial-quantity progress) actually reached the
// composition step, not just that "some text" was sent.
function groundedAnswerSmartDefault(args: unknown): { text: string } | undefined {
  const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content;
  if (typeof content !== "string" || !content.startsWith('לקוח שאל:')) return undefined;
  // composeGroundedAnswer's own prompt array is joined via .filter(Boolean)
  // — the "" spacer elements are stripped, so there is no blank line
  // between the facts block and the instruction line that follows it; the
  // capture must end at that literal next line, not at "\n\n".
  const factsMatch = content.match(/העובדות הידועות שמותר להשתמש בהן \(ואך ורק בהן\):\n([\s\S]*?)\nנסח תשובה/);
  if (!factsMatch) return { text: "אין לי כרגע מידע מאומת שעונה על השאלה הזו." };
  const lines = factsMatch[1]
    .split("\n")
    .map((line) => line.replace(/^-\s*/, ""))
    .join(". ");
  return { text: lines };
}

beforeEach(() => {
  fakeFolders = [];
  fakeFiles = [];
  nextDriveId = 1;
  mediaByWamid.clear();
  sentMessages.length = 0;
  sendTextMessage.mockClear();
  sendTemplateMessage.mockClear();
  sendInteractiveButtonsMessage.mockClear();
  classifyDocumentViaVisionAI.mockReset();
  resolveLanguageModel.mockReset();
  resolveLanguageModel.mockResolvedValue({ modelId: "e2e-fake-model" });
  generateObject.mockReset();
  generateObject.mockImplementation((args: unknown) => {
    const referenceDefault = referenceResolutionSmartDefault(args);
    if (referenceDefault) return Promise.resolve(referenceDefault);
    const reasoningDefault = reasoningSmartDefault(args);
    if (reasoningDefault) return Promise.resolve(reasoningDefault);
    return Promise.reject(new Error("[e2e] generateObject called with no queued mock and no smart default applies"));
  });
  generateText.mockReset();
  generateText.mockImplementation((args: unknown) => {
    const groundedDefault = groundedAnswerSmartDefault(args);
    if (groundedDefault) return Promise.resolve(groundedDefault);
    return Promise.reject(new Error("[e2e] generateText called with no smart default applies"));
  });
});

// ---- Test client — the one Meta/WhatsApp test number authorized for
// this session's testing, per explicit instruction. Never used to send
// anything for real in this file (the transport is fully mocked above);
// used here purely as a realistic, consistently-normalized phone value.
const TEST_CLIENT_PHONE = "055-9858685";
const TEST_CLIENT_WA_ID = "972559858685"; // same number, Meta's own from-field format (no leading +)

let wamidCounter = 1;
function nextWamid(): string {
  return `wamid.e2e.${wamidCounter++}`;
}

function signPayload(rawBody: string): string {
  return `sha256=${createHmac("sha256", TEST_APP_SECRET).update(rawBody, "utf-8").digest("hex")}`;
}

async function postWebhook(payload: unknown): Promise<void> {
  const rawBody = JSON.stringify(payload);
  const request = new Request("https://e2e-test.local/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": signPayload(rawBody), "content-type": "application/json" },
    body: rawBody,
  });
  const response = await POST(request as never);
  expect(response.status).toBe(200);
}

function textMessagePayload(phoneNumberId: string, from: string, body: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ from, id: nextWamid(), type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

async function sendText(phoneNumberId: string, body: string): Promise<void> {
  console.log("[e2e] inbound text", { body });
  await postWebhook(textMessagePayload(phoneNumberId, TEST_CLIENT_WA_ID, body));
}

// A real WhatsApp Interactive Reply Buttons tap — no message.text at all,
// only message.interactive.button_reply (see route.ts's own
// resolveInteractiveReplyText).
async function sendButtonReply(phoneNumberId: string, buttonId: string, title: string): Promise<void> {
  console.log("[e2e] inbound button tap", { buttonId });
  await postWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  from: TEST_CLIENT_WA_ID,
                  id: nextWamid(),
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { id: buttonId, title } },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function sendDocument(phoneNumberId: string, doc: TestDocument, caption?: string): Promise<void> {
  const mediaId = `media-${nextWamid()}`;
  mediaByWamid.set(mediaId, { bytes: doc.bytes, mimeType: doc.mimeType });
  const messageId = nextWamid();
  const isImage = doc.mimeType === "image/png";
  console.log("[e2e] inbound document", { kind: doc.kind, fileName: doc.fileName, caption });
  await postWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  from: TEST_CLIENT_WA_ID,
                  id: messageId,
                  type: isImage ? "image" : "document",
                  ...(isImage
                    ? { image: { id: mediaId, mime_type: doc.mimeType, ...(caption ? { caption } : {}) } }
                    : { document: { id: mediaId, mime_type: doc.mimeType, filename: doc.fileName, ...(caption ? { caption } : {}) } }),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

interface SeededRequest {
  orgId: string;
  clientId: string;
  serviceId: string;
  requestId: string;
  conversationId: string;
  phoneNumberId: string;
  requirements: (typeof schema.collectionRequestRequirements.$inferSelect)[];
}

async function seedActiveRequest(
  requirementNames: string[],
  requirementOverrides: Partial<typeof schema.collectionRequestRequirements.$inferInsert>[] = []
): Promise<SeededRequest> {
  const phoneNumberId = `e2e-phone-${nextOrgSeq++}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "משרד בדיקה E2E",
      googleDriveFolderId: "e2e-root-folder",
      whatsappPhoneNumberId: phoneNumberId,
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
      timezone: "Asia/Jerusalem",
      reminderIntervalDays: 2,
    })
    .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
  const [client] = await db
    .insert(schema.clients)
    // Matches the fixture documents' own extractedPersonName (fixtures.ts)
    // so the golden-path journey doesn't trip identity-anomaly detection
    // by accident — a real, deliberate identity mismatch is its own
    // dedicated journey below.
    .values({ organizationId: org.id, name: "ישראל ישראלי בדיקה", phone: TEST_CLIENT_PHONE })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות בדיקה" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "E2E", status: "active" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
    .returning();

  const requirements = [];
  for (let i = 0; i < requirementNames.length; i++) {
    const [req] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: requirementNames[i], ...requirementOverrides[i] })
      .returning();
    requirements.push(req);
  }

  return { orgId: org.id, clientId: client.id, serviceId: service.id, requestId: request.id, conversationId: conversation.id, phoneNumberId, requirements };
}

async function currentRequestStatus(requestId: string) {
  const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
  return request.status;
}

async function approvedDocuments(requestId: string) {
  return db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.collectionRequestId, requestId), eq(schema.documents.status, "approved")));
}

// ======================================================================
// Journey 1 — the golden path: creation, two ordinary documents (one
// image, one PDF, sent minutes apart), auto-completion, Drive folder
// structure and audit trail.
// ======================================================================
describe("E2E Journey 1 — simple two-document request, golden path", () => {
  it("collects an ID card and a driver's license, auto-completes, and files both correctly in Drive", async () => {
    const { requestId, phoneNumberId, requirements } = await seedActiveRequest(["תעודת זהות", "רישיון נהיגה"]);
    const [idReq, licenseReq] = requirements;

    const idDoc = await makeTestDocument("id_card");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.97,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, idDoc);

    const [docsAfterFirst] = [await approvedDocuments(requestId)];
    expect(docsAfterFirst).toHaveLength(1);
    expect(await currentRequestStatus(requestId)).not.toBe("completed");

    const licenseDoc = await makeTestDocument("drivers_license");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "רישיון נהיגה",
      identificationConfidence: 0.96,
      matchedRequirementId: licenseReq.id,
      matchConfidence: 0.94,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, licenseDoc);

    // "ברגע שכל הדרישות הושלמו... הבקשה נסגרת מיד" — immediate completion,
    // no explicit "finished" message needed.
    expect(await currentRequestStatus(requestId)).toBe("completed");
    const finalDocs = await approvedDocuments(requestId);
    expect(finalDocs).toHaveLength(2);
    expect(finalDocs.every((d) => d.googleDriveFileId !== null)).toBe(true);

    // Drive structure: an org-level month folder, a client folder nested
    // under it, and the two files nested under the client folder.
    const clientFolder = fakeFolders.find((f) => f.name.includes("ישראל ישראלי"));
    expect(clientFolder).toBeDefined();
    const filesInClientFolder = fakeFiles.filter((f) => f.parentId === clientFolder!.id);
    expect(filesInClientFolder).toHaveLength(2);

    // A real "thank you" message was actually sent (mocked transport, real
    // send-decision logic).
    expect(sentMessages.some((m) => m.body.includes("קיבלתי את כל המסמכים שנדרשו:"))).toBe(true);

    // Full audit trail exists for both documents.
    const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows.some((r) => r.eventType === "document.classified")).toBe(true);
    expect(auditRows.some((r) => r.eventType === "collection_request.status_changed")).toBe(true);
  });
});

// The unified conversation-understanding layer (src/lib/conversation/) runs
// exactly once per inbound text message — this queues its response,
// matching its real schema (conversationIntent.ts), with sensible defaults
// for every field not overridden.
// Queues a response for the FIRST of the pipeline's two calls
// (resolveConversationReference) — every scenario in this file is about
// reasoning/action outcomes, never pronoun/ordinal reference resolution
// (Phase 2's own dedicated tests cover that), so this is always
// "no_reference" unless a test explicitly overrides it.
function queueNoReference() {
  generateObject.mockResolvedValueOnce({
    object: { status: "no_reference", referentKind: null, referentId: null, provenance: null, confidence: 0.9, basis: null, ambiguousCandidateIds: null },
  });
}

function extractOpenQuestionIdFromPrompt(content: string): string | null {
  const match = content.match(/שאלה פתוחה שממתינה לתשובה כרגע \(סוג: [^,]+, id=([^)]+)\):/);
  return match?.[1] ?? null;
}

function extractAllFactIdsFromPrompt(content: string): string[] {
  return [...new Set([...content.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]))];
}

// Translates this codebase's old single-call classifier vocabulary
// (conversationIntent.ts's ConversationIntentKind) into the Phase 4
// reasonAboutMessage schema (outcomeSchema, conversationUnderstanding.ts).
// Every test in this file was written against the old vocabulary; this
// keeps that ergonomic, well-understood call shape at every call site
// while genuinely exercising the new two-call, new-schema pipeline
// end-to-end through the real webhook route — no test call site needed to
// change. Queues BOTH of the pipeline's calls (reference, then reasoning);
// callers that need a specific reference resolution result queue their own
// override and call queueConversationIntent second.
function queueConversationIntent(overrides: {
  kind:
    | "resolves_pending"
    | "corrects_resolved"
    | "reports_missing_document"
    | "needs_employee_review"
    | "resolves_review_item"
    | "asks_document_question"
    | "finished_signal"
    | "deferral_promise"
    | "unclear"
    | "unrelated";
  confidence?: number;
  pendingAnswer?: "confirm" | "decline" | null;
  correctionTargetType?: "document" | "confirmation" | null;
  correctionTargetId?: string | null;
  correctionDesiredOutcome?: string | null;
  missingDocumentMentionedType?: string | null;
  reviewCategory?: string | null;
  reviewGist?: string | null;
  reviewItemTargetId?: string | null;
  reviewItemAction?: "close_resolved" | "add_context_note" | null;
  reviewItemReason?: string | null;
  naturalAcknowledgment?: string | null;
  documentQuestionCategory?: string | null;
}) {
  queueNoReference();

  const confidence = overrides.confidence ?? 0.9;

  // resolve_pending and asks_document_question both need a real id
  // (the open question's, or the full grounded-fact set's) that only
  // exists once reasonAboutMessage's own prompt is built at call time —
  // mockImplementationOnce reads the real prompt content to extract it,
  // the same discipline the smart defaults above use, rather than
  // guessing/hardcoding an id the test itself doesn't otherwise know.
  //
  // Root-cause fix (production incident, 2026-08-15) — every object below
  // matches reasonAboutMessage's real discriminated-union schema: only the
  // fields the chosen outcome/actionKind branch actually declares.
  if (overrides.kind === "resolves_pending") {
    generateObject.mockImplementationOnce((args: unknown) => {
      const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? "";
      const openQuestionId = extractOpenQuestionIdFromPrompt(content) ?? "";
      return Promise.resolve({
        object: { outcome: "ACT", confidence, action: { actionKind: "resolve_pending", actionOpenQuestionId: openQuestionId, actionAnswer: overrides.pendingAnswer ?? "confirm" } },
      });
    });
    return;
  }

  if (overrides.kind === "asks_document_question") {
    generateObject.mockImplementationOnce((args: unknown) => {
      const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? "";
      const factIds = extractAllFactIdsFromPrompt(content);
      return Promise.resolve({ object: { outcome: "ANSWER", confidence, answerGroundedOn: factIds } });
    });
    return;
  }

  if (overrides.kind === "corrects_resolved") {
    generateObject.mockResolvedValueOnce({
      object: {
        outcome: "ACT",
        confidence,
        action: {
          actionKind: "correct_resolved",
          actionTargetType: overrides.correctionTargetType ?? "document",
          actionTargetId: overrides.correctionTargetId ?? "",
          actionDesiredOutcome: (overrides.correctionDesiredOutcome as "attach_to_requirement" | "save_as_extra" | "mark_withdrawn" | null) ?? "save_as_extra",
        },
      },
    });
    return;
  }

  if (overrides.kind === "reports_missing_document") {
    generateObject.mockResolvedValueOnce({
      object: { outcome: "ACT", confidence, action: { actionKind: "report_missing_document", actionMentionedType: overrides.missingDocumentMentionedType ?? null } },
    });
    return;
  }

  if (overrides.kind === "needs_employee_review") {
    generateObject.mockResolvedValueOnce({
      object: {
        outcome: "ESCALATE",
        confidence,
        escalateCategory: (overrides.reviewCategory as "alternative_or_policy_question" | "human_request" | "other" | null) ?? "other",
        escalateGist: overrides.reviewGist ?? "",
      },
    });
    return;
  }

  if (overrides.kind === "resolves_review_item") {
    generateObject.mockResolvedValueOnce({
      object: {
        outcome: "ACT",
        confidence,
        action: {
          actionKind: "resolve_review_item",
          actionReviewItemId: overrides.reviewItemTargetId ?? "",
          actionReviewAction: overrides.reviewItemAction ?? "close_resolved",
          actionReviewReason: overrides.reviewItemReason ?? "",
          actionAcknowledgment: overrides.naturalAcknowledgment ?? "",
        },
      },
    });
    return;
  }

  if (overrides.kind === "finished_signal") {
    generateObject.mockResolvedValueOnce({ object: { outcome: "ACT", confidence, action: { actionKind: "finish_request" } } });
    return;
  }

  if (overrides.kind === "deferral_promise") {
    generateObject.mockImplementationOnce((args: unknown) => {
      const content = (args as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? "";
      const messageMatch = content.match(/ההודעה החדשה מהלקוח: "([^"]*)"/);
      const replyText = messageMatch?.[1]?.trim() ?? "";
      return Promise.resolve({ object: { outcome: "ACT", confidence, action: { actionKind: "defer", actionReplyText: replyText } } });
    });
    return;
  }

  if (overrides.kind === "unclear") {
    generateObject.mockResolvedValueOnce({
      object: { outcome: "CLARIFY", confidence, clarifyQuestion: "אפשר להבהיר בדיוק למה התכוונת?", clarifyMissing: "unclear reply" },
    });
    return;
  }

  // "unrelated"
  generateObject.mockResolvedValueOnce({ object: { outcome: "UNRELATED", confidence: overrides.confidence ?? 0 } });
}

// ======================================================================
// Journey 2 — quantity-aware requirement ("3 תלושי שכר של 3 חודשים
// שונים"), client Q&A before and during collection, an "I don't have it"
// exception with an employee decision, duplicate-file detection, an
// unrelated message producing no response, and completion via an explicit
// "finished" signal.
// ======================================================================
describe("E2E Journey 2 — quantity requirement + Q&A + exception + duplicate + unrelated + explicit finish", () => {
  it("walks the full client conversation around a 3-different-months payslip requirement", async () => {
    const { requestId, phoneNumberId, requirements } = await seedActiveRequest(
      ["3 תלושי שכר של 3 החודשים האחרונים"],
      [
        {
          requiredCount: 3,
          semanticSpec: {
            originalText: "3 תלושי שכר של 3 החודשים האחרונים",
            documentType: "תלוש שכר",
            requiredCount: 3,
            periodType: "relative",
            explicitPeriods: null,
            relativePeriod: { kind: "last_n_months", n: 3 },
            samePeriodAllowed: false,
            distinctPeriodsRequired: true,
            distinctPeopleRequired: false,
            expectedPersonOrCompany: null,
            validityRequirement: null,
            supportingDocumentRelationship: null,
            freeTextConstraints: null,
            interpretationConfidence: 0.92,
            clarifyingQuestion: null,
          },
        },
      ]
    );
    const [payslipReq] = requirements;

    // 1) Client asks "כמה מסמכים חסרים לי?" before sending anything — must
    // reflect real (zero-progress) state, never invented.
    queueConversationIntent({ kind: "asks_document_question", documentQuestionCategory: "request_overview" });
    await sendText(phoneNumberId, "כמה מסמכים חסרים לי?");
    expect(sentMessages.at(-1)!.body).toContain("תלושי שכר");
    expect(sentMessages.at(-1)!.body).toContain("טרם התקבל");

    // 2) Two payslips for two distinct months arrive.
    const payslip1 = await makeTestDocument("payslip", { fileName: "payslip_june.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תלוש שכר",
      identificationConfidence: 0.93,
      matchedRequirementId: payslipReq.id,
      matchConfidence: 0.9,
      documentPeriodLabel: "06/2026",
      periodExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, payslip1);

    const payslip2 = await makeTestDocument("payslip", { fileName: "payslip_july.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תלוש שכר",
      identificationConfidence: 0.93,
      matchedRequirementId: payslipReq.id,
      matchConfidence: 0.9,
      documentPeriodLabel: "07/2026",
      periodExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, payslip2);

    expect(await currentRequestStatus(requestId)).not.toBe("completed");
    expect(await approvedDocuments(requestId)).toHaveLength(2);

    // 3) The exact same file sent again — duplicate detection, never a
    // third approved document.
    await sendDocument(phoneNumberId, payslip2);
    expect(await approvedDocuments(requestId)).toHaveLength(2);

    // 4) Client asks again — must now reflect real partial progress (2 of 3).
    queueConversationIntent({ kind: "asks_document_question", documentQuestionCategory: "request_overview" });
    await sendText(phoneNumberId, "כמה עוד חסר?");
    expect(sentMessages.at(-1)!.body).toContain("2 מתוך 3");

    // 5) A completely unrelated message — Centro must stay silent (no new
    // outbound message, no state change).
    const sentCountBeforeUnrelated = sentMessages.length;
    queueConversationIntent({ kind: "unrelated", confidence: 0 });
    await sendText(phoneNumberId, "מה שעות הפעילות שלכם?");
    expect(sentMessages).toHaveLength(sentCountBeforeUnrelated);

    // 6) "אין לי את התלוש השלישי" — opens a real employee exception rather
    // than being invented or silently dropped.
    queueConversationIntent({ kind: "reports_missing_document", missingDocumentMentionedType: null });
    await sendText(phoneNumberId, "אין לי את התלוש השלישי, איבדתי אותו");

    const [reqAfterException] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, payslipReq.id));
    expect(reqAfterException.exceptionStatus).toBe("reported_missing");
    expect(reqAfterException.exceptionNote).toContain("איבדתי");

    // 7) The employee waives the requirement — the request recomputes and,
    // since that was the only thing missing, completes immediately.
    const { resolveRequirementException } = await import("@/lib/requirementException");
    const waiveResult = await resolveRequirementException({
      organizationId: (await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId)))[0].organizationId,
      requirementId: payslipReq.id,
      decision: "waive",
    });
    expect(waiveResult.ok).toBe(true);
    expect(await currentRequestStatus(requestId)).toBe("completed");

    const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows.some((r) => r.eventType === "requirement.exception_reported")).toBe(true);
    expect(auditRows.some((r) => r.eventType === "requirement.exception_waived")).toBe(true);
  });
});

// ======================================================================
// Journey 3 — a multi-page document sent as three images (real PDF
// merging via pdf-lib, verified by loading the actual resulting bytes), a
// document replaced via caption, and reminder deferral to a real future
// date suppressing (then correctly resuming) the scheduler.
// ======================================================================
describe("E2E Journey 3 — multi-page PDF merge, document replace, reminder deferral", () => {
  it("merges 3 images of one contract into a real PDF, replaces a document via caption, and honors a dated reminder deferral", async () => {
    // A third, deliberately never-satisfied requirement keeps the request
    // open through the whole journey — otherwise it would auto-complete
    // right after the ID card (lease + ID both done), closing the
    // conversation before the replacement photo below ever arrives, and
    // routing it through the post-completion reopen flow instead of the
    // document-replace flow this scenario is actually testing.
    const { requestId, phoneNumberId, requirements } = await seedActiveRequest(["חוזה שכירות", "תעודת זהות", "אישור עבודה"]);
    const [leaseReq, idReq] = requirements;

    for (let page = 1; page <= 3; page++) {
      const doc = await makeTestDocument("lease_certificate", { fileName: `lease_page${page}.pdf` });
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.95,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.93,
        pageNumberCurrent: page,
        pageNumberTotal: 3,
      });
      await sendDocument(phoneNumberId, doc);
    }

    const leaseDocs = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.collectionRequestId, requestId), eq(schema.documents.requirementId, leaseReq.id)));
    const head = leaseDocs.find((d) => d.continuationOfDocumentId === null)!;
    expect(leaseDocs).toHaveLength(3);
    expect(head.mergedPdfDriveFileId).not.toBeNull();
    expect(head.mergedPdfVersion).toBe(2); // created at page 2, updated once at page 3

    const { PDFDocument } = await import("pdf-lib");
    const mergedFile = fakeFiles.find((f) => f.id === head.mergedPdfDriveFileId)!;
    const mergedPdf = await PDFDocument.load(mergedFile.content!);
    expect(mergedPdf.getPageCount()).toBe(3);

    // The lease still reads as one satisfied unit (requiredCount 1), not
    // three separate documents.
    expect(
      (await approvedDocuments(requestId)).filter((d) => d.requirementId === leaseReq.id && !d.continuationOfDocumentId)
    ).toHaveLength(1);

    // An ID card arrives, then the client says the FIRST id photo they
    // meant to send was wrong and this one replaces it — but here it's the
    // very first ID document, so "replace" has nothing to supersede;
    // instead this exercises the ordinary matched-and-approved path with a
    // caption present (never wrongly treated as a continuation page).
    const idDoc = await makeTestDocument("id_card");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.93,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, idDoc);
    const [firstIdDoc] = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.collectionRequestId, requestId), eq(schema.documents.requirementId, idReq.id)));
    expect(firstIdDoc.status).toBe("approved");

    // A second ID photo arrives with a caption saying it replaces the
    // first. Real, worth noting: a WhatsApp caption is read as this
    // message's own `body` too (route.ts has no separate "caption-only"
    // channel), so it first runs the ordinary conversational-understanding
    // chain (mocked as unrelated here, to isolate this test's real target —
    // the SEPARATE caption-triggered classifyDocumentRelationIntent, which
    // gets its own turn against the attachment itself once the document is
    // uploaded).
    queueConversationIntent({ kind: "unrelated", confidence: 0 });
    generateObject.mockResolvedValueOnce({ object: { relation: "replace" } });
    const idDoc2 = await makeTestDocument("id_card", { fileName: "test_id_card_v2.png" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.93,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    await sendDocument(phoneNumberId, idDoc2, "זה מחליף את הקודם, טעיתי בצילום");

    const [oldId, newId] = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.collectionRequestId, requestId), eq(schema.documents.requirementId, idReq.id)))
      .orderBy(schema.documents.receivedAt);
    expect(oldId.status).toBe("superseded");
    expect(newId.status).toBe("approved");
    // Superseded, never deleted — the old file is still in Drive, renamed.
    const oldFile = fakeFiles.find((f) => f.id === oldId.googleDriveFileId);
    expect(oldFile?.name).toContain("הוחלף");

    // The lease and ID are both satisfied, but the third requirement never
    // was — the request correctly stays open rather than completing.
    expect(await currentRequestStatus(requestId)).not.toBe("completed");
  });

  it("suppresses the normal reminder until a client's dated commitment, then reminds once it's genuinely due", async () => {
    const { requestId, phoneNumberId, conversationId } = await seedActiveRequest(["דף בנק"]);

    // "אני בחו״ל, אשלח עוד יומיים" — a real dated commitment (2 days),
    // resolved deterministically, never trusted to the model's own math.
    queueConversationIntent({ kind: "deferral_promise" });
    generateObject.mockResolvedValueOnce({
      object: { kind: "scheduled", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: 2, relativeWeeks: null, namedPeriod: null },
    });
    await sendText(phoneNumberId, "אני בחו\"ל, אשלח עוד יומיים");

    const [conversationAfterPromise] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversationAfterPromise.deferredReminderAt).not.toBeNull();
    // relativeDays: 2 -> "מחרתיים" (see resolveDeferralDate's own phrasing).
    expect(sentMessages.at(-1)!.body).toContain("מחרתיים");

    // Force the collection request into the reminder-eligible state
    // (waiting_for_client) the way a real inactivity evaluation would, and
    // simulate the deferred date already having arrived.
    await db
      .update(schema.collectionRequests)
      .set({ status: "waiting_for_client" })
      .where(eq(schema.collectionRequests.id, requestId));
    await db
      .update(schema.conversations)
      .set({ status: "waiting_for_client", deferredReminderAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.conversations.id, conversationId));

    // A recent inbound message keeps the free-form session window open so
    // the reminder's real (non-template) content is visible for assertion.
    await db.insert(schema.messages).values({
      organizationId: (await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId)))[0].organizationId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "אני בחו\"ל, אשלח עוד יומיים",
    });

    const sentCountBeforeDue = sentMessages.length;
    const { runScheduledTasks } = await import("@/lib/scheduler");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    await runScheduledTasks(request.organizationId);

    expect(sentMessages.length).toBeGreaterThan(sentCountBeforeDue);
    expect(sentMessages.at(-1)!.body).toContain("דף בנק");
    const [conversationAfterDue] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversationAfterDue.deferredReminderAt).toBeNull();
  });
});

// ======================================================================
// Journey 4 — an identity mismatch deferred to whole-case review, a
// genuinely unrecognized document resolved by the client's own words,
// "Centro checks the case, not the document" at the "finished" signal,
// and the full post-completion extension flow (multiple uploads without
// saying "finished," then an explicit close).
// ======================================================================
describe("E2E Journey 4 — identity anomaly, unrecognized document, and post-completion extension", () => {
  it("asks about an identity mismatch immediately (batched, not per-file) and replies immediately to an unrecognized document too, then stays fully silent after completion", async () => {
    const { requestId, phoneNumberId, conversationId, requirements } = await seedActiveRequest(["תעודת זהות", "אישור שכירות"]);
    const [idReq] = requirements;

    // A document whose extracted name doesn't match the client on file —
    // asked about immediately (not deferred to whole-case-review time),
    // but still held for its own short notification-grouping window
    // rather than sent as its own standalone message right away.
    const mismatchedId = await makeTestDocument("id_card", { fileName: "someone_elses_id.png" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.93,
      extractedPersonName: "מישהו אחר לגמרי",
      identityExtractionConfidence: 0.85,
    });
    await sendDocument(phoneNumberId, mismatchedId);

    const [heldDoc] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.collectionRequestId, requestId));
    expect(heldDoc.status).toBe("identity_anomaly_pending_confirmation");
    expect(heldDoc.deferredReviewKind).toBeNull();
    // A pendingConfirmation already exists right after intake...
    const [pendingRow] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(pendingRow.kind).toBe("identity_anomaly");
    expect(pendingRow.notifiedAt).toBeNull();
    // ...but not sent yet — still inside its own short grouping window,
    // not interrupting the client mid-collection with a standalone message.
    expect(sentMessages).toHaveLength(0);

    // A genuinely unrecognized file — unlike the identity mismatch above,
    // this isn't a business question that can wait; the client can still
    // fix it while they're in the chat, so it gets an immediate reply
    // asking for a resend instead of being deferred to case-review time.
    const mysteryDoc = await makeTestDocument("unrelated_document", { fileName: "mystery.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.1,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    await sendDocument(phoneNumberId, mysteryDoc);
    expect(sentMessages).toHaveLength(1);
    // "המסמך האחרון ששלחת" unambiguously refers to it — never the raw
    // storage filename (see src/lib/documents/displayLabel.ts).
    expect(sentMessages[0].body).toContain("המסמך האחרון ששלחת");
    expect(sentMessages[0].body).not.toContain("mystery.pdf");
    expect(sentMessages[0].body).not.toContain("שלחת אותו בכוונה");

    // The client says they're done — the identity_anomaly confirmation was
    // already created (immediately, at intake), but may still be inside
    // its own short grouping window; "finished" forces it straight to due
    // and flushes it right now rather than making the client wait out that
    // window. "סיימתי" is matched by pure-text isFinishedSignal, before
    // the AI-backed deferral/Q&A chain is ever reached — no generateObject
    // call at all.
    await sendText(phoneNumberId, "סיימתי");

    const openConfirmations = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
    expect(openConfirmations.length).toBeGreaterThanOrEqual(1);
    // Completion must wait for the still-open identity_anomaly confirmation
    // — this is exactly the gap runCaseReview's own hasPendingReview fix
    // closes: it's still open regardless of whether "finished" just
    // flushed it now or it had already been sent moments earlier.
    expect(await currentRequestStatus(requestId)).not.toBe("completed");

    // The employee (or client, via the same generic yes/no resolver)
    // resolves the identity anomaly as correct/intentional and the
    // clarification by naming the document — for this journey, simulate
    // the client answering the (batched or single) question directly, then
    // apply the real domain handlers exactly like route.ts's own resolver
    // chain does (resolving the pendingConfirmation row alone is not
    // enough — these are what actually update the document's own status).
    const { respondToPendingConfirmationManually } = await import("@/lib/pendingConfirmations");
    const { applyIdentityAnomalyDecision } = await import("@/lib/documentIdentityVerification");
    const { applyUnsolicitedConfirmationDecision } = await import("@/lib/documentIntakeReview");
    const orgIdForResolve = (await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId)))[0].organizationId;
    // A clarification reply can itself surface a NEW question (e.g. "did
    // you mean to send this unrelated document?") — loop until genuinely
    // nothing is left open rather than assuming a fixed count.
    for (let round = 0; round < 5; round++) {
      const stillOpen = await db
        .select()
        .from(schema.pendingConfirmations)
        .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
      if (stillOpen.length === 0) break;
      for (const confirmation of stillOpen) {
        const resolvedRow = await respondToPendingConfirmationManually(orgIdForResolve, confirmation.id, true);
        if (!resolvedRow) continue;
        await applyIdentityAnomalyDecision(resolvedRow);
        await applyUnsolicitedConfirmationDecision(resolvedRow);
      }
    }
    // document_clarification is open-ended free text, not yes/no — resolve
    // any that's still open (declared "not a document type we recognize,
    // filed as-is") without confirming/declining semantics.
    const remainingClarifications = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
    for (const confirmation of remainingClarifications) {
      await respondToPendingConfirmationManually(orgIdForResolve, confirmation.id, true);
    }

    // By design, a document flagged as belonging to someone else never
    // silently satisfies the ID requirement just because the client
    // confirmed it was sent on purpose — "never auto-treated as fulfilling
    // the requirement it doesn't actually match" (documentIdentityVerification.ts).
    // The requirement genuinely still needs a real matching document.
    expect(await currentRequestStatus(requestId)).not.toBe("completed");

    // ---- Post-completion silence (terminal-completion invariant) ------
    // Manually bring the request to completed+closed (the resolution above
    // doesn't itself re-run completion in this synthetic flow).
    await db.update(schema.collectionRequests).set({ status: "completed", completedAt: new Date() }).where(eq(schema.collectionRequests.id, requestId));
    await db.update(schema.conversations).set({ status: "closed" }).where(eq(schema.conversations.id, conversationId));

    // "שכחתי עוד מסמך" after completion — once a request is completed and
    // its conversation closed, Centro never engages again automatically:
    // no reply, no AI call, no reopen confirmation, no state change. The
    // message is still recorded as plain communication history (the real
    // webhook route's own recordInboundMessage), and that's all.
    const messagesBefore = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    sentMessages.length = 0;
    await sendText(phoneNumberId, "שכחתי לשלוח את אישור השכירות, אשלח עכשיו");

    const pendingConfirmationsAfter = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
    expect(pendingConfirmationsAfter).toHaveLength(0); // no automatic reopen question
    expect(sentMessages).toHaveLength(0); // no automated reply of any kind

    const messagesAfter = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messagesAfter.length).toBe(messagesBefore.length + 1); // only the inbound message itself was recorded
    expect(messagesAfter.at(-1)?.direction).toBe("inbound");

    // A document arriving after completion is equally inert — never
    // uploaded, never matched, never reopens the request.
    const leaseDoc = await makeTestDocument("lease_certificate");
    const docsBefore = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    await sendDocument(phoneNumberId, leaseDoc);
    const docsAfter = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docsAfter).toHaveLength(docsBefore.length); // no new document row

    const [finalRequest] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(finalRequest.status).toBe("completed"); // never auto-reopened to "active"
    const [finalConversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(finalConversation.status).toBe("closed");
  });
});

// ======================================================================
// Reply-routing priority — regression for a real production incident: a
// bare "כן" answering an open unsolicited-document question (with more
// than one confirmation open at once, so the specific yes/no resolvers
// correctly refused to guess which one it answered) fell through all the
// way to the free-text deferral/reminder classifier and was misread as a
// future-intent commitment ("לאיזה יום להזכיר?"). route.ts's own new
// ambiguity guard must catch this before it ever reaches deferral or
// generic intent classification — proven here via the REAL webhook POST
// handler, not by calling any single resolver in isolation, since the bug
// was specifically about the order/fallthrough between them.
// ======================================================================
// ======================================================================
// Real production incident: a button tap on "כן" never resolved at all
// (silently fell through to "not a recognized button tap"), while typing
// "כן" as plain text worked correctly — confirmed via diagnostic logging
// that Meta's real inbound webhook payload sets interactive.type to
// "button_reply", not "button" (route.ts's resolveInteractiveReplyText
// checked for the wrong value from day one). These tests prove button tap
// and typed text now produce byte-identical outcomes, for both
// unsolicited_document and identity_anomaly confirmations.
// ======================================================================
describe("button tap vs typed text — must resolve an open confirmation identically", () => {
  async function seedOneOpenUnsolicitedConfirmation() {
    const { requestId, phoneNumberId, conversationId } = await seedActiveRequest(["תעודת זהות"]);
    const invoiceDoc = await makeTestDocument("invoice", { fileName: "invoice1.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    await sendDocument(phoneNumberId, invoiceDoc);
    sentMessages.length = 0;
    return { requestId, phoneNumberId, conversationId };
  }

  it("button tap 'כן' resolves the open confirmation exactly like typed 'כן': same document status, same acknowledgment, same debounce arm", async () => {
    const { requestId, phoneNumberId, conversationId } = await seedOneOpenUnsolicitedConfirmation();

    await sendButtonReply(phoneNumberId, CONFIRM_YES_BUTTON_ID, "כן");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("unsolicited_approved");
    expect(sentMessages.at(-1)!.body).toBe("תודה! שמרתי את המסמך.");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).not.toBeNull();
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("confirmed");
  });

  it("button tap 'לא' resolves the open confirmation exactly like typed 'לא': same document status, same acknowledgment, same debounce arm", async () => {
    const { requestId, phoneNumberId, conversationId } = await seedOneOpenUnsolicitedConfirmation();

    await sendButtonReply(phoneNumberId, CONFIRM_NO_BUTTON_ID, "לא");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("unsolicited_rejected");
    expect(sentMessages.at(-1)!.body).toBe("בסדר, המסמך לא ייכלל.");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).not.toBeNull();
  });
});

describe("reply routing priority — an ambiguous yes/no answer with 2+ open questions must never be guessed or misread as a deferral promise", () => {
  // Two distinct unsolicited documents -> two simultaneously open
  // unsolicited_document confirmations, each sent as its own solo message.
  // The unified conversation-understanding layer's own context builder only
  // ever populates a single "open question" when EXACTLY one confirmation
  // is open (see correctionContext.ts) — with two open, it correctly
  // reports "no open question" to the classifier, so a well-behaved
  // classification of a bare "כן"/"לא" here is "unclear", never a guessed
  // resolution and never a deferral promise.
  async function seedTwoOpenUnsolicitedConfirmations() {
    const { requestId, phoneNumberId, conversationId } = await seedActiveRequest(["תעודת זהות"]);

    const invoiceDoc = await makeTestDocument("invoice", { fileName: "invoice1.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    await sendDocument(phoneNumberId, invoiceDoc);

    const leaseDoc = await makeTestDocument("lease_certificate", { fileName: "lease1.pdf" });
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "אישור שכירות",
      identificationConfidence: 0.88,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    await sendDocument(phoneNumberId, leaseDoc);

    const openBefore = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
    expect(openBefore).toHaveLength(2);

    sentMessages.length = 0; // only count what happens AFTER this point
    generateObject.mockClear();
    return { requestId, phoneNumberId, conversationId };
  }

  // Matches the new pipeline's real schema (conversationUnderstanding.ts) —
  // the realistic response for a bare "כן"/"לא" when the context builder
  // reports no single open question (2 are open at once): CLARIFY, not a
  // guess. queueConversationIntent queues both of the pipeline's calls
  // (reference resolution, then reasoning).
  function queueUnclearClassification() {
    queueConversationIntent({ kind: "unclear", confidence: 0.3 });
  }

  async function assertNoDeferralAndBothStillOpen(requestId: string) {
    // Exactly two AI calls — resolveConversationReference then
    // reasonAboutMessage, the pipeline's own two calls — never a third,
    // stray (old-style) deferral/generic classifier call layered on top.
    expect(generateObject).toHaveBeenCalledTimes(2);
    // Never sent a reminder-flavored reply, and never silently dropped —
    // a real (if generic) clarification went out instead.
    expect(sentMessages.some((m) => m.body.includes("להזכיר") || m.body.includes("יום"))).toBe(false);
    expect(sentMessages).toHaveLength(1);
    // Neither confirmation was guessed-resolved — both still open.
    const stillOpen = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")));
    expect(stillOpen).toHaveLength(2);
  }

  it("unsolicited question -> typed \"כן\" -> not guessed, not routed to reminder/deferral", async () => {
    const { requestId, phoneNumberId } = await seedTwoOpenUnsolicitedConfirmations();
    queueUnclearClassification();
    await sendText(phoneNumberId, "כן");
    await assertNoDeferralAndBothStillOpen(requestId);
  });

  it("unsolicited question -> button תap \"כן\" -> not guessed, not routed to reminder/deferral", async () => {
    const { requestId, phoneNumberId } = await seedTwoOpenUnsolicitedConfirmations();
    queueUnclearClassification();
    await sendButtonReply(phoneNumberId, CONFIRM_YES_BUTTON_ID, "כן");
    await assertNoDeferralAndBothStillOpen(requestId);
  });

  it("unsolicited question -> typed \"לא\" -> not guessed, not routed to reminder/deferral", async () => {
    const { requestId, phoneNumberId } = await seedTwoOpenUnsolicitedConfirmations();
    queueUnclearClassification();
    await sendText(phoneNumberId, "לא");
    await assertNoDeferralAndBothStillOpen(requestId);
  });

  it("unsolicited question -> button tap \"לא\" -> not guessed, not routed to reminder/deferral", async () => {
    const { requestId, phoneNumberId } = await seedTwoOpenUnsolicitedConfirmations();
    queueUnclearClassification();
    await sendButtonReply(phoneNumberId, CONFIRM_NO_BUTTON_ID, "לא");
    await assertNoDeferralAndBothStillOpen(requestId);
  });

  it("a genuine dated future commitment (\"אשלח שבוע הבא\") with NO open confirmation still triggers real deferral logic", async () => {
    const { phoneNumberId, conversationId } = await seedActiveRequest(["תעודת זהות"]);
    queueConversationIntent({ kind: "deferral_promise" });
    generateObject.mockResolvedValueOnce({
      object: { kind: "scheduled", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: 1, namedPeriod: null },
    });
    await sendText(phoneNumberId, "אשלח שבוע הבא");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).not.toBeNull();
  });

  it("a genuine vague future commitment (\"אשלח בקרוב\") with NO open confirmation still triggers real deferral logic", async () => {
    const { phoneNumberId, requestId } = await seedActiveRequest(["תעודת זהות"]);
    queueConversationIntent({ kind: "deferral_promise" });
    generateObject.mockResolvedValueOnce({
      object: { kind: "not_dated", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });
    generateObject.mockResolvedValueOnce({ object: { isFollowUpPromise: true } });
    await sendText(phoneNumberId, "אשלח בקרוב");

    // applyFollowUpPromiseIfAny's own short acknowledgment — proves the
    // real deferral/follow-up path actually ran, not just "some message".
    expect(sentMessages.at(-1)!.body).toBe("בסדר, תודה 😊");
    const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows.some((r) => r.eventType === "message.ambiguous_confirmation_reply")).toBe(false);
  });

  it("a bare \"כן\" with NO open confirmation at all never invents a reminder out of nothing", async () => {
    const { phoneNumberId } = await seedActiveRequest(["תעודת זהות"]);
    // Correctly classified as neither a resolvable answer nor a deferral
    // promise (nothing to interpret it against) — this test proves the
    // DOWNSTREAM behavior given that (correct) classification, not the
    // AI's own judgment call.
    queueUnclearClassification();

    await sendText(phoneNumberId, "כן");

    expect(sentMessages.every((m) => !m.body.includes("להזכיר"))).toBe(true);
  });
});

// ======================================================================
// human_control isolation — the owner's own explicit requirement: taking
// over one client's one specific collection-request conversation must
// NEVER affect any other client, any other request of the same client, or
// the general automation. These tests prove that structurally, through
// the real webhook route.
// ======================================================================
describe("human_control — silences the bot, strictly scoped to one conversation", () => {
  const OTHER_CLIENT_WA_ID = "972501112222";

  async function seedOrgWithTwoClients() {
    const phoneNumberId = `e2e-phone-${nextOrgSeq++}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({
        name: "משרד בדיקה E2E - human_control",
        googleDriveFolderId: "e2e-root-folder-hc",
        whatsappPhoneNumberId: phoneNumberId,
        documentCollectionEnabled: true,
        businessHoursStart: "00:00",
        businessHoursEnd: "23:59",
        businessDays: "0,1,2,3,4,5,6",
      })
      .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();

    async function seedClientRequest(name: string, phone: string) {
      const [client] = await db.insert(schema.clients).values({ organizationId: org.id, name, phone }).returning();
      const [request] = await db
        .insert(schema.collectionRequests)
        .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "E2E", status: "active" })
        .returning();
      const [conversation] = await db
        .insert(schema.conversations)
        .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
        .returning();
      await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
      return { clientId: client.id, requestId: request.id, conversationId: conversation.id };
    }

    return { phoneNumberId, orgId: org.id, seedClientRequest };
  }

  it("client A in human_control does not silence client B in the same organization", async () => {
    const { phoneNumberId, seedClientRequest } = await seedOrgWithTwoClients();
    const clientA = await seedClientRequest("לקוח A", TEST_CLIENT_PHONE);
    const clientB = await seedClientRequest("לקוח B", "+972501112222");

    await db.update(schema.conversations).set({ status: "human_control" }).where(eq(schema.conversations.id, clientA.conversationId));

    queueConversationIntent({ kind: "asks_document_question", documentQuestionCategory: "request_overview" });
    await postWebhook(textMessagePayload(phoneNumberId, OTHER_CLIENT_WA_ID, "מה עדיין חסר לי?"));

    // Client B was processed normally — got a real reply.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].body).toContain("תעודת זהות");
    // Client A's conversation is completely untouched — still human_control.
    const [convA] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, clientA.conversationId));
    expect(convA.status).toBe("human_control");
    // Client B's own conversation stays exactly what it always was — this
    // whole test proves the isolation runs both ways.
    const [convB] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, clientB.conversationId));
    expect(convB.status).toBe("open");
  });

  it("one request of a client in human_control plus that same client's other open request — with no unambiguous signal, asks which request instead of guessing", async () => {
    // Phase 8 remediation (request disambiguation) — this used to assert
    // the OLD "most recently updated conversation wins" behavior, forcing
    // conversationB's updatedAt artificially ahead specifically to make
    // that guess land correctly. That was never a real guarantee (see
    // src/lib/requestDisambiguation.ts's own doc comment) — two genuinely
    // active requests for the same client with no signal pointing at
    // either one must now be disambiguated by asking, never guessed by
    // recency. requestA is still correctly protected: human_control is
    // never silently bypassed just because a sibling request exists.
    const { phoneNumberId, seedClientRequest } = await seedOrgWithTwoClients();
    const requestA = await seedClientRequest("לקוח", TEST_CLIENT_PHONE);
    const [requestBRow] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: (await db.select().from(schema.clients).where(eq(schema.clients.id, requestA.clientId)))[0].organizationId, clientId: requestA.clientId, serviceId: (await db.select().from(schema.services))[0].id, periodLabel: "E2E-2", status: "active" })
      .returning();
    const [conversationB] = await db
      .insert(schema.conversations)
      .values({ organizationId: requestBRow.organizationId, clientId: requestA.clientId, collectionRequestId: requestBRow.id, status: "open", updatedAt: new Date(Date.now() + 1000) })
      .returning();
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestBRow.id, name: "רישיון נהיגה" });

    await db.update(schema.conversations).set({ status: "human_control" }).where(eq(schema.conversations.id, requestA.conversationId));

    await sendText(phoneNumberId, "מה עדיין חסר לי?");

    // Neither request answered directly — a clarification question went
    // out instead, naming both open requests.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].body).toContain("כמה בקשות איסוף מסמכים פתוחות");
    expect(sentMessages[0].body).toContain("E2E-2"); // requestB's own periodLabel, listed as an option

    // Neither conversation's substantive state changed — requestA still
    // human_control, requestB still open. (Whichever candidate is used as
    // the technical carrier for the clarification message does get its
    // own conversations.updatedAt bumped, same as any outbound send — see
    // createRequestDisambiguation's own comment; that's message-delivery
    // bookkeeping, not a business-state change, so it's not asserted here.)
    const [convA] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, requestA.conversationId));
    expect(convA.status).toBe("human_control");
    const [convB] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationB.id));
    expect(convB.status).toBe("open");
  });

  it("an attachment arriving during human_control is stashed, scoped to that one collection request, never auto-processed", async () => {
    const { phoneNumberId, seedClientRequest } = await seedOrgWithTwoClients();
    const requestA = await seedClientRequest("לקוח", TEST_CLIENT_PHONE);
    await db.update(schema.conversations).set({ status: "human_control" }).where(eq(schema.conversations.id, requestA.conversationId));

    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);

    // Never classified, never uploaded — vision AI never even called.
    expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestA.requestId));
    expect(doc.status).toBe("human_control_pending");
    expect(doc.pendingFileContent).not.toBeNull();
  });

  it("releasing control reprocesses only that request's stashed documents, never another request's", async () => {
    const { seedClientRequest } = await seedOrgWithTwoClients();
    const requestA = await seedClientRequest("לקוח A", TEST_CLIENT_PHONE);
    const requestB = await seedClientRequest("לקוח B", "+972503334444");

    const [stashedA] = await db
      .insert(schema.documents)
      .values({
        organizationId: (await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestA.requestId)))[0].organizationId,
        collectionRequestId: requestA.requestId,
        fileName: "stashed-a.pdf",
        status: "human_control_pending",
        pendingFileContent: Buffer.from("fake-bytes-a"),
        pendingFileMimeType: "application/pdf",
      })
      .returning();
    const [stashedB] = await db
      .insert(schema.documents)
      .values({
        organizationId: (await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestB.requestId)))[0].organizationId,
        collectionRequestId: requestB.requestId,
        fileName: "stashed-b.pdf",
        status: "human_control_pending",
        pendingFileContent: Buffer.from("fake-bytes-b"),
        pendingFileMimeType: "application/pdf",
      })
      .returning();

    const { reprocessHeldHumanControlDocument } = await import("@/app/(app)/collections/conversationActions");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({ identified: false });
    await reprocessHeldHumanControlDocument(stashedA.id);

    // Only request A's stashed document was touched (reprocessed/deleted-as-placeholder).
    const remainingA = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestA.requestId));
    expect(remainingA.find((d) => d.id === stashedA.id)).toBeUndefined(); // placeholder replaced
    const remainingB = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestB.requestId));
    expect(remainingB.find((d) => d.id === stashedB.id)).toBeDefined();
    expect(remainingB.find((d) => d.id === stashedB.id)?.status).toBe("human_control_pending"); // untouched
  });
});

// ======================================================================
// Multi-active-collection-request disambiguation (src/lib/requestDisambiguation.ts)
// — the real architectural gap the pre-Phase-8 verification proved: a
// client assigned to two different Services (or with a manually-opened
// second request) can genuinely have two collection requests open at
// once. Before this, an inbound message with no signal beyond the
// client's phone number was routed to "whichever conversation was most
// recently updated" — a silent guess that could mark the wrong request's
// requirement satisfied. These scenarios exercise the real fix through
// the actual webhook POST handler, no shortcuts.
// ======================================================================
describe("Multi-active-collection-request disambiguation", () => {
  async function seedClientWithTwoActiveRequests() {
    const phoneNumberId = `e2e-phone-${nextOrgSeq++}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({
        name: "משרד בדיקה E2E - disambiguation",
        googleDriveFolderId: "e2e-root-folder-disambig",
        whatsappPhoneNumberId: phoneNumberId,
        documentCollectionEnabled: true,
        businessHoursStart: "00:00",
        businessHoursEnd: "23:59",
        businessDays: "0,1,2,3,4,5,6",
      })
      .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
    const [client] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "ישראל ישראלי בדיקה", phone: TEST_CLIENT_PHONE })
      .returning();

    async function seedRequest(serviceName: string, periodLabel: string, requirementName: string) {
      const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: serviceName }).returning();
      const [request] = await db
        .insert(schema.collectionRequests)
        .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel, status: "active" })
        .returning();
      const [conversation] = await db
        .insert(schema.conversations)
        .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
        .returning();
      const [requirement] = await db
        .insert(schema.collectionRequestRequirements)
        .values({ collectionRequestId: request.id, name: requirementName })
        .returning();
      return { requestId: request.id, conversationId: conversation.id, requirementId: requirement.id, serviceId: service.id };
    }

    return { phoneNumberId, orgId: org.id, clientId: client.id, seedRequest };
  }

  it("a client with exactly one active collection request continues automatically — unaffected by the disambiguation logic", async () => {
    const { phoneNumberId } = await seedActiveRequest(["תעודת זהות"]);
    queueConversationIntent({ kind: "asks_document_question", documentQuestionCategory: "request_overview" });
    await sendText(phoneNumberId, "מה עדיין חסר לי?");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].body).toContain("תעודת זהות");
  });

  it("a client with two active collection requests and no signal either way gets asked, never guessed — no state changes on either request", async () => {
    const { phoneNumberId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);

    // A clarification question went out — never a silent guess, never a
    // document uploaded to either request.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].body).toContain("כמה בקשות איסוף מסמכים פתוחות");
    expect(sentMessages[0].body).toContain("תקופה-X");
    expect(sentMessages[0].body).toContain("תקופה-Y");
    expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled(); // never even classified yet

    const docsX = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, reqX.requestId));
    const docsY = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, reqY.requestId));
    expect(docsX).toHaveLength(0);
    expect(docsY).toHaveLength(0);
    expect(await currentRequestStatus(reqX.requestId)).toBe("active");
    expect(await currentRequestStatus(reqY.requestId)).toBe("active");

    // The held content is tracked, unresolved, against this client — never
    // attached to either candidate collectionRequestId yet.
    const pending = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.clientId, clientId));
    expect(pending).toHaveLength(1);
    expect(pending[0].resolvedAt).toBeNull();
    expect(pending[0].pendingFileContent).not.toBeNull();
    expect(new Set(pending[0].candidateCollectionRequestIds)).toEqual(new Set([reqX.requestId, reqY.requestId]));
  });

  it("the client's numbered reply resolves to the correct request — the document is processed only there, the other request is untouched", async () => {
    const { phoneNumberId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);
    expect(sentMessages).toHaveLength(1); // the clarification question

    // Candidates are listed most-recently-updated first, not by insertion
    // order — read the real held row to find reqX's actual position
    // rather than assuming it, so this test doesn't depend on incidental
    // timing. Scoped to THIS test's own client — the shared PGlite instance
    // can still hold an earlier test's deliberately-unresolved row for a
    // different client (e.g. the "no signal either way" test above).
    const [held] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(and(eq(schema.pendingRequestDisambiguations.clientId, clientId), isNull(schema.pendingRequestDisambiguations.resolvedAt)));
    const reqXChoice = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;
    expect(reqXChoice).toBeGreaterThan(0);

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.97,
      matchedRequirementId: reqX.requirementId,
      matchConfidence: 0.95,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    await sendText(phoneNumberId, String(reqXChoice));

    // reqX: the held document is now filed and completes the request
    // (its only requirement is satisfied).
    expect(await currentRequestStatus(reqX.requestId)).toBe("completed");
    const docsX = await db.select().from(schema.documents).where(and(eq(schema.documents.collectionRequestId, reqX.requestId), eq(schema.documents.status, "approved")));
    expect(docsX).toHaveLength(1);

    // reqY: completely untouched — still active, zero documents.
    expect(await currentRequestStatus(reqY.requestId)).toBe("active");
    const docsY = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, reqY.requestId));
    expect(docsY).toHaveLength(0);
  });

  it("exactly one candidate having an open question is an unambiguous signal — auto-routes there without asking", async () => {
    const { phoneNumberId, seedRequest, clientId } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    // Give reqX (only) a genuinely open question — mirrors how a real
    // unsolicited/identity-anomaly confirmation would already be open.
    const [reqXRow] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, reqX.requestId));
    const [conversationX] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, reqX.conversationId));
    await db.insert(schema.pendingConfirmations).values({
      organizationId: reqXRow.organizationId,
      clientId,
      collectionRequestId: reqX.requestId,
      conversationId: conversationX.id,
      kind: "unsolicited_document",
      payload: { documentIds: [], documentType: "קבלה" },
      question: "קיבלנו מסמך שלא ביקשנו — האם התכוונת לשלוח אותו?",
      status: "pending",
    });

    queueConversationIntent({ kind: "resolves_pending", pendingAnswer: "confirm" });
    await sendText(phoneNumberId, "כן");

    // Routed straight to reqX — no clarification question ever sent.
    expect(sentMessages.some((m) => m.body.includes("כמה בקשות איסוף מסמכים פתוחות"))).toBe(false);
    const [resolvedConfirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, reqX.requestId));
    expect(resolvedConfirmation.status).toBe("confirmed");

    // reqY: completely untouched — no confirmation, no document, still active.
    const reqYConfirmations = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, reqY.requestId));
    expect(reqYConfirmations).toHaveLength(0);
    expect(await currentRequestStatus(reqY.requestId)).toBe("active");
  });

  it("reminders and completion stay fully isolated per collection request even while two are open for the same client", async () => {
    const { seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    // reqX's requirement is already satisfied via a direct manual document
    // (bypassing WhatsApp entirely) — completion must only ever evaluate
    // reqX's own requirement, never reqY's.
    const [reqXRow] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, reqX.requestId));
    await db.insert(schema.documents).values({
      organizationId: reqXRow.organizationId,
      collectionRequestId: reqX.requestId,
      requirementId: reqX.requirementId,
      fileName: "manual.pdf",
      status: "approved",
    });

    const { checkCompletionGate } = await import("@/lib/collectionRequestStateMachine");
    expect(await checkCompletionGate(reqX.requestId)).toBeNull(); // nothing missing on reqX
    expect(await checkCompletionGate(reqY.requestId)).not.toBeNull(); // reqY still genuinely missing its own requirement
  });

  // Final Pre-Commit Review item #2 — two genuinely concurrent webhook
  // deliveries (not two messages in one payload, which processClaimedMessages
  // already handles sequentially) racing to open a disambiguation for the
  // SAME client. The partial unique index is the real guarantee; this
  // proves the race actually resolves safely end to end through the real
  // route, not just that the DB constraint exists in isolation.
  it("two concurrent messages racing to open a disambiguation for the same client never crash and never create two — the loser is dropped safely, the winner's question stands", async () => {
    const { phoneNumberId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    const idDoc = await makeTestDocument("id_card");
    const licenseDoc = await makeTestDocument("drivers_license");
    const results = await Promise.allSettled([sendDocument(phoneNumberId, idDoc), sendDocument(phoneNumberId, licenseDoc)]);

    // Neither webhook call itself throws/rejects — postWebhook's own
    // expect(response.status).toBe(200) already asserts a clean 2xx for
    // both; Promise.allSettled here just guards against an unhandled
    // rejection surfacing as a raw test crash instead of a clear failure.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Exactly one disambiguation exists for this client — never two, never
    // zero.
    const pending = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.clientId, clientId));
    expect(pending).toHaveLength(1);
    // Exactly one clarification question went out (the race loser's
    // create attempt failed before ever reaching sendOutboundMessage).
    expect(sentMessages).toHaveLength(1);
  });

  // Final Pre-Commit Review item #7 — the resolved request can genuinely
  // close between the clarification question being asked and the client
  // actually answering it (an employee finishes it manually here; the
  // scheduler completing it naturally would reach the same conversation
  // state). The reply must never be silently processed against a request
  // that isn't open anymore.
  it("if the chosen request completed while the disambiguation was still pending, the reply is fully silent — recorded as history, never processed, never reopened", async () => {
    const { phoneNumberId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);
    const [held] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(and(eq(schema.pendingRequestDisambiguations.clientId, clientId), isNull(schema.pendingRequestDisambiguations.resolvedAt)));
    const reqXChoice = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;
    expect(reqXChoice).toBeGreaterThan(0);

    // reqX completes independently (an employee finishing it directly)
    // while the client still hasn't answered.
    await db
      .update(schema.collectionRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.collectionRequests.id, reqX.requestId));
    await db.update(schema.conversations).set({ status: "closed" }).where(eq(schema.conversations.id, reqX.conversationId));

    sentMessages.length = 0;
    await sendText(phoneNumberId, String(reqXChoice));

    // Never silently filed — no approved document landed on the
    // now-completed reqX, and its status is untouched by the reply.
    const approvedOnX = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.collectionRequestId, reqX.requestId), eq(schema.documents.status, "approved")));
    expect(approvedOnX).toHaveLength(0);
    expect(await currentRequestStatus(reqX.requestId)).toBe("completed"); // still completed, not silently reopened
    expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled(); // never even classified

    // Terminal-completion invariant: no automated reopen confirmation, no
    // reply of any kind — the message is recorded as plain history and
    // nothing else happens.
    const reopenConfirmations = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(and(eq(schema.pendingConfirmations.collectionRequestId, reqX.requestId), eq(schema.pendingConfirmations.kind, "request_reopen")));
    expect(reopenConfirmations).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);

    // reqY (never chosen, never involved) is completely unaffected.
    expect(await currentRequestStatus(reqY.requestId)).toBe("active");
  });

  // Root-cause fix (production incident, 2026-08-13) — a disambiguation
  // that's genuinely open but doesn't resolve as an answer (not a number,
  // not an ordinal, not a candidate name) must never be re-asked forever;
  // it falls through to real conversation understanding for that turn,
  // while the disambiguation row itself is left completely untouched.
  it("E/F/G. a real question that doesn't answer the pending disambiguation is NOT re-asked — it reaches real conversation understanding once, and the disambiguation stays open unchanged", async () => {
    const { phoneNumberId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);
    expect(sentMessages).toHaveLength(1); // the clarification question
    const [heldBefore] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(and(eq(schema.pendingRequestDisambiguations.clientId, clientId), isNull(schema.pendingRequestDisambiguations.resolvedAt)));
    expect(heldBefore).toBeDefined();

    sentMessages.length = 0;
    generateObject.mockClear();

    // E. "מתי הכי מאוחר" — neither a number, an ordinal, nor a candidate
    // name — the exact real production incident's own reproduction.
    queueConversationIntent({ kind: "needs_employee_review", reviewCategory: "alternative_or_policy_question", reviewGist: "מתי הכי מאוחר אפשר לשלוח" });
    await sendText(phoneNumberId, "מתי הכי מאוחר אני יכול לשלוח");

    // Never re-sent the stale disambiguation question.
    expect(sentMessages.some((m) => m.body.includes("כמה בקשות איסוף מסמכים פתוחות"))).toBe(false);
    // The real understanding pipeline actually ran — never silently dropped.
    expect(generateObject).toHaveBeenCalled();
    // G. exactly one response for this turn — never a double response.
    expect(sentMessages).toHaveLength(1);

    // The pending disambiguation itself is untouched — still open, same
    // two candidates — a later numbered/ordinal/named reply can still
    // resolve it normally.
    const [heldAfterE] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.id, heldBefore.id));
    expect(heldAfterE.resolvedAt).toBeNull();
    expect(new Set(heldAfterE.candidateCollectionRequestIds)).toEqual(new Set([reqX.requestId, reqY.requestId]));

    sentMessages.length = 0;
    generateObject.mockClear();

    // F. "עד מתי אפשר לשלוח?" — same scenario, a second genuinely
    // different real message, proving this isn't a one-off.
    queueConversationIntent({ kind: "unrelated", confidence: 0 });
    await sendText(phoneNumberId, "עד מתי אפשר לשלוח?");

    expect(sentMessages.some((m) => m.body.includes("כמה בקשות איסוף מסמכים פתוחות"))).toBe(false);
    expect(generateObject).toHaveBeenCalled();

    const [heldAfterF] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.id, heldBefore.id));
    expect(heldAfterF.resolvedAt).toBeNull();

    // H. existing disambiguation behavior is NOT broken — the same
    // still-open row can still be resolved normally by a real numbered
    // reply, exactly like the pre-existing tests above.
    sentMessages.length = 0;
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.97,
      matchedRequirementId: reqX.requirementId,
      matchConfidence: 0.95,
      extractedPersonName: "ישראל ישראלי בדיקה",
      identityExtractionConfidence: 0.9,
    });
    const choiceIndex = heldBefore.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;
    await sendText(phoneNumberId, String(choiceIndex));
    const [heldAfterChoice] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.id, heldBefore.id));
    expect(heldAfterChoice.resolvedAt).not.toBeNull();
    expect(heldAfterChoice.resolvedCollectionRequestId).toBe(reqX.requestId);
  });

  // Point 7 — the full, real production incident reproduced end to end:
  // an old, still-open disambiguation between two OLD requests must never
  // hijack a natural follow-up about a BRAND-NEW request that didn't even
  // exist when that disambiguation was created.
  it("Point 7 — a stale disambiguation between two old requests never hijacks a natural follow-up about a brand-new request just sent", async () => {
    const { phoneNumberId, orgId, clientId, seedRequest } = await seedClientWithTwoActiveRequests();
    const reqX = await seedRequest("שירות X", "תקופה-X", "תעודת זהות");
    const reqY = await seedRequest("שירות Y", "תקופה-Y", "אישור ניהול חשבון");

    // A genuine disambiguation between the two OLD requests — mirrors the
    // real incident: created earlier, never answered.
    const idDoc = await makeTestDocument("id_card");
    await sendDocument(phoneNumberId, idDoc);
    expect(sentMessages).toHaveLength(1);
    sentMessages.length = 0;

    // A brand-new THIRD request is created and its real initial WhatsApp
    // message sent — the exact same production function (startConversation)
    // the real "Send Now"/wizard flow uses — while the old disambiguation
    // (which doesn't even know this request exists) is still open.
    const reqZ = await seedRequest("שירות Z", "תקופה-Z-חדשה", "אישור ניהול חשבון חדש");
    const { startConversation } = await import("@/lib/conversationOrchestration");
    await startConversation(orgId, reqZ.requestId, clientId, "manual");
    expect(sentMessages).toHaveLength(1); // the new request's own initial message

    sentMessages.length = 0;
    generateObject.mockClear();

    // A natural follow-up about the brand-new request.
    queueConversationIntent({ kind: "needs_employee_review", reviewCategory: "alternative_or_policy_question", reviewGist: "מתי הכי מאוחר אפשר לשלוח" });
    await sendText(phoneNumberId, "מתי הכי מאוחר אני יכול לשלוח");

    // Never the stale re-ask naming the two OLD requests.
    expect(sentMessages.some((m) => m.body.includes("כמה בקשות איסוף מסמכים פתוחות"))).toBe(false);
    expect(generateObject).toHaveBeenCalled();
    expect(sentMessages).toHaveLength(1);

    // Routed to the brand-new request specifically (the most recently
    // active conversation) — not silently to one of the two old ones.
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, reqZ.requestId));
    expect(reviewItems).toHaveLength(1);

    // The old disambiguation (reqX/reqY only) is still exactly as it was —
    // never touched, never resolved, never includes reqZ.
    const [heldAfter] = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(and(eq(schema.pendingRequestDisambiguations.clientId, clientId), isNull(schema.pendingRequestDisambiguations.resolvedAt)));
    expect(heldAfter).toBeDefined();
    expect(new Set(heldAfter.candidateCollectionRequestIds)).toEqual(new Set([reqX.requestId, reqY.requestId]));
  });
});
