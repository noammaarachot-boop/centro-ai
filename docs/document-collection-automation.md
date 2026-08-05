# Document-Collection Automation — Implementation Record

**Date:** 2026-08-04
**Branch:** `feature/document-collection-automation`
**Migration:** `drizzle/0031_handy_retro_girl.sql`
**Related:** [`whatsapp-connect-implementation.md`](./whatsapp-connect-implementation.md), [`whatsapp-connect-issues.md`](./whatsapp-connect-issues.md)

This chapter documents the switch from the generic `automationActivatedAt` gate to an explicit, dynamic, tenant-scoped document-collection model, and the separation of human-initiated (manual) sends from autonomous (automated) ones.

---

## 1. Purpose of `documentCollectionEnabled`

A dedicated boolean on `organizations` that is the **long-term source of truth** for whether the automated document-collection pipeline may run for that organization. It supersedes `automationActivatedAt` for this purpose (that column is kept only for transitional backward compatibility and is no longer the authority; the recurring scheduler and the send gate now read `documentCollectionEnabled`).

## 2. Manual vs automated

`sendOutboundMessage` / `startConversation` / `attemptScheduledDelivery` now carry an explicit `trigger: "manual" | "automated"` (default `"automated"`), orthogonal to `senderType: "ai" | "employee"` (a WhatsApp transport concern — template vs free text).

- **manual** — a human explicitly triggered the send (Send Now, Initiate, an employee reply). **Always allowed**; never gated by `documentCollectionEnabled`, per-service pause, or business hours.
- **automated** — an autonomous action (scheduler/cron, follow-up prompt, reminder, auto-confirmation). Runs only while the gates allow it.

The decision rule is a pure, unit-tested function: `src/lib/documentCollectionGate.ts` → `evaluateAutomationGate()`.

## 3. Default model

- **New organization:** `documentCollectionEnabled` is set to `true` the moment WhatsApp finishes connecting (`storeWabaConnection`) — no separate activation step, no extra user confirmation.
- **Disconnect:** `clearWabaConnection` sets it back to `false` (an org with no connected WhatsApp cannot run automated collection).
- **Column default:** `false` (safe) — an org that never connected WhatsApp stays `false`.

## 4. The backfill

Migration `0031` runs, after adding the column:
```sql
UPDATE "organizations" SET "document_collection_enabled" = true WHERE "whatsapp_connected_at" IS NOT NULL;
```
Only organizations with a real WhatsApp connection are enabled. Orgs without a connected number stay `false`. Idempotent.

## 5. Data path — from request to WhatsApp message
```
sendTemplateRequest (Send Now = manual)
  → block if the service has zero serviceDocumentRequirements → error=no_active_document_requirements
  → attemptScheduledDelivery(trigger="manual")
    → startConversation(trigger)
      → sendOutboundMessage(trigger)
          manual    → always proceeds
          automated → evaluateAutomationGate(documentCollectionEnabled, paused, businessHours)
        → sendViaWhatsApp → sendTemplateMessage → POST /{phoneNumberId}/messages → Meta
```

## 6. New template structure (Phase 2)

`centro_initial_request` is a **static** UTILITY template with no parameter — it cannot carry a dynamic list. `centro_initial_request_v2` (UTILITY, `he`) is added with a single `{{1}}` BODY parameter:

> "שלום! זהו סנטרו, העוזר הדיגיטלי של המשרד. כדי שנוכל להמשיך בטיפול בבקשה, נא שלחו את המסמכים הבאים: {{1}}"

`{{1}}` is built dynamically from `collectionRequestRequirements` via `getRequestRequirementNames()` + `formatRequirementListForTemplateParam()` as a **single-line, comma-separated** string. **Meta forbids newlines / tabs / >4 consecutive spaces in a body parameter**, so a bulleted multi-line list is not representable in the first (template) message; a comma-separated list is used instead.

**v2 is provisioned for Meta approval now (it is in `REQUIRED_TEMPLATES`) but the live send path is NOT switched to it until it is APPROVED on the WABA (Phase 2).** Until then the initial send continues to use the existing static `centro_initial_request`.

### Phase 2 plumbing (built, tested, flag-gated OFF)

All of the dynamic-list send logic is complete and wired end to end, behind a single master switch so the live WhatsApp send does not change until Meta approves:

- `INITIAL_REQUEST_V2_ENABLED` (`templates.ts`) — currently `false`. This is the **only** line to change once Meta approves the template.
- `buildInitialRequestSend(requirementNames, v2Enabled?)` (`whatsapp/initialRequestMessage.ts`) — pure resolver. With v2 disabled it returns the static v1 template and no params (identical to current production). With v2 enabled and a non-empty list it returns `centro_initial_request_v2`, `params: [comma-separated list]`, and a `renderedBody` with `{{1}}` substituted (what the client sees / what is stored on the message row). Empty list → falls back to v1.
- `startConversation` now reads the request's own requirement snapshot via `getRequestRequirementNames(organizationId, collectionRequestId)` and passes an explicit template descriptor down through `sendOutboundMessage` → `sendViaWhatsApp`, which sends via `sendTemplateMessage(name, language, params)`. The `TEMPLATE_BY_BODY` exact-body lookup remains the path for the other static templates (thank-you / reminder / duplicate).

**When Meta approves:** flip `INITIAL_REQUEST_V2_ENABLED` to `true`, run one end-to-end test, then deploy. No other code change is required.

## 7. Requirement snapshot

The per-request document list is the frozen snapshot `collectionRequestRequirements`, created at send time from `serviceDocumentRequirements` and any per-client `clientDocumentRequirements` deviations (BR-002). A later edit to the service template never changes a historical request's list. Never a hardcoded list; if a service has no requirements the send is blocked (§ below).

## 8. No active requirements

If a service has no `serviceDocumentRequirements`, `sendTemplateRequest` blocks the whole send, logs `document_collection_send_blocked { reason: "no_active_document_requirements" }`, and redirects with `?error=no_active_document_requirements`. The collections manage page shows a clear message telling the user to define documents first. Centro never sends a generic "please send the required documents" message.

## 9. Statuses (no new enum / no migration)

The logical stages are derived from existing fields, not a new enum:

| Stage | Source |
|-------|--------|
| file_received | `documents.status = "received"` |
| identified | classification `supported && readable` |
| matched | `documents.requirementId` set |
| verified | `documents.status = "approved"` |
| rejected | `documents.status = "rejected"` |
| needs_review | `documents.status = "needs_review"` |
| missing (per requirement) | no approved document for that `collectionRequestRequirements` row |

## 10. Document identification (unchanged)

`documentClassifier` is untouched. Existing protections remain: unmatched → `needs_review`; confidence `< AUTO_APPROVE_CONFIDENCE (0.6)` → `needs_review`; no auto-approval without a clear match; never guesses a match to close a requirement. **Follow-up (not done):** explicit ambiguous-match handling (confidence gap between the top two candidates).

## 11. History / audit trail

Preserved and extended: the requirement snapshot (`collectionRequestRequirements`) records exactly what was requested per request; audit events (`collection_request.created`, `collection_request.scheduled_send_delivered`, document received/classified/assigned events) and structured send logs record the lifecycle. Manual status changes are recorded via the existing document-review audit events.

## 12. Logging

Permanent structured events (no secrets, no tokens, no document content, no full phone numbers):
`document_collection_send_started`, `document_collection_send_blocked` (with `reason`), `document_collection_send_accepted` (with `whatsappMessageId`), `document_collection_send_failed`.

Temporary `[wa-diag]` console logs remain **only until one more end-to-end test passes**, then are removed (Phase 3), leaving the four structured events plus the existing `[whatsapp] send failed` line.

This E2E test confirms the Phase 1 gate logic (`documentCollectionEnabled` / manual-vs-automated) over a real send using the already-approved static `centro_initial_request` template — it does **not** require `centro_initial_request_v2` or Meta's approval of it. It is unrelated to the Phase 2 dependency below. It has not been run: it requires deliberately sending a real WhatsApp message from a connected org, so it is a manual/QA action, not something automated tooling (including an agent) should trigger on its own initiative.

## 13. Tenant isolation

Every requirement/list read is organization-scoped: `getRequestRequirementNames(organizationId, collectionRequestId)` joins through `collectionRequests` and filters by `organizationId`, so one tenant can never read another's requirements (covered by an integration test). Classification candidates are always the specific request's own requirements.

## 14. Migrations

`0031_handy_retro_girl.sql`: `ADD COLUMN document_collection_enabled boolean NOT NULL DEFAULT false` + the connected-only backfill. No other schema change (statuses reuse existing fields).

## 15. Product decisions (locked)

1. Manual send always allowed, independent of `documentCollectionEnabled` / `automationActivatedAt`.
2. Automated document collection allowed only when `documentCollectionEnabled = true`.
3. Enabled by default after WhatsApp connect; toggleable in Settings ("איסוף מסמכים אוטומטי"); off for orgs with no WhatsApp.
4. No hardcoded document lists — the DB is the source of truth (`serviceDocumentRequirements` → `collectionRequestRequirements`, plus `clientDocumentRequirements`).
5. Generic: any new service works with the pipeline automatically, no code change.

## 16. Known limitations / follow-ups

- **Meta approval dependency:** resolved — `centro_initial_request_v2` was approved on the WABA on 2026-08-05, and `INITIAL_REQUEST_V2_ENABLED` is now `true` in production.
- **First-message list format:** single-line comma-separated (Meta parameter constraint), not bulleted multi-line.
- **Ambiguous matching:** confidence-gap disambiguation between the top two candidates is a documented follow-up.
- **`automationActivatedAt`:** retained temporarily for compatibility; a later change should remove its remaining read sites once fully superseded.
- **Binary PDF project book:** this chapter is the source-of-truth record in `docs/`. Regenerating `reports/Centro-Implementation-Report.pdf` requires the external doc pipeline (no `pdf-lib` or generation script exists in the repo, and Hebrew RTL embedding is non-trivial) — tracked as a separate step, not bundled into this change.

## Phase plan

- **Phase 1 (done):** column + migration + backfill; manual/automated split; block-when-no-requirements; settings toggle; dynamic list builder; structured logging; tests.
- **Phase 2 (done):** `centro_initial_request_v2` approved by Meta 2026-08-05; `INITIAL_REQUEST_V2_ENABLED` flipped to `true`. The initial document request now sends the dynamic per-request list live. No other code change was required — confirmed by tracing `startConversation` → `buildInitialRequestSend` → `sendOutboundMessage` → `sendViaWhatsApp`, the single path used by both manual (Send Now / Initiate) and automated (scheduler/cron) sends.
- **Phase 3 (pending a live-send QA pass):** remove temporary `[wa-diag]` logs, keep the four structured events. Gated on the E2E pass described in §12, now being run against production following the Phase 2 flag flip.

### Status as of 2026-08-05

Phase 1 and Phase 2 code is merged to `main`. The live E2E confirmation (real WhatsApp send → real device receipt → document upload → flow completion) is being run manually against production immediately after this deploy, since the WhatsApp send credentials (`WHATSAPP_SYSTEM_USER_TOKEN` etc.) exist only in the Production environment — there is no sandbox to validate against first. Phase 3 (log cleanup) follows once that pass is confirmed.
