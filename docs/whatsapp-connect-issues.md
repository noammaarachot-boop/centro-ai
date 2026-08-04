# WhatsApp / Facebook Connect — Issues List

Track and fix issues. See also **[`docs/whatsapp-connect-implementation.md`](./whatsapp-connect-implementation.md)** (current architecture + status).

**Status key:** `open` · `in_progress` · `done` · `wontfix` · `needs_logs` · `optional`

---

## Live status snapshot (2026-08-04)

| Area | Status |
|------|--------|
| WhatsApp **connect** (IDs stored, UI connected) | **Working** |
| OAuth redirect_uri / domains | Resolved with controlled callback URI + Meta config |
| Outbound first message delivery | **Investigate** (WA-15) — not proved by “connected” alone |
| Admin every-step audit UI | Not built (WA-16) |

---

## Deployment constraints

| Item | Value |
|------|--------|
| Live URL | https://www.centro-ai.co.il/ |
| Hosting | Vercel (git push → deploy) |
| Repo access | Git + push |
| Often missing from agent machine | Local `.env`, Vercel logs, production DB |

### Diagnostics without full infra access

| Tool | Use |
|------|-----|
| Browser `[wa-debug]` | Popup / client flow |
| `GET /api/auth/whatsapp/debug-config` | App ID, redirect URIs, secret↔app probe (session required) |
| Vercel Runtime Logs | `[whatsapp-oauth]`, `[whatsapp] send failed…` (**Meta HTTP + body for sends**) |
| DB | `organizations.whatsapp_*`, `messages.delivery_status` |

---

## Required Vercel env (Production)

- `NEXT_PUBLIC_WHATSAPP_APP_ID`
- `NEXT_PUBLIC_WHATSAPP_CONFIG_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `WHATSAPP_OAUTH_REDIRECT_URI` — recommend  
  `https://www.centro-ai.co.il/api/auth/whatsapp/oauth`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`

Webhook callback in code:  
`https://www.centro-ai.co.il/api/webhooks/whatsapp`

---

## Priority / status table

| # | ID | Severity | Status | Title |
|---|----|----------|--------|-------|
| 1 | WA-01 | High | **done** | Prefer user token after signup for phone/webhooks |
| 2 | WA-02 | High | **done** | Webhook fail must not block store |
| 3 | WA-03 | High | **done** | Surface failure `step` / debug to client |
| 4 | WA-04 | Medium | **done** | Phone list includes Meta body |
| 5 | WA-05 | Medium | **done** | No blind withRetry burn of OAuth code |
| 6 | WA-06 | Medium | **done** | 36008/191 detection + hints |
| 7 | WA-07 | Medium | **done** | Clearer missing granular scope |
| 8 | WA-08 | Low | **done** | FB SDK reload hang (legacy FB path) |
| 9 | WA-09 | Low | **done** | Architecture docs match no postMessage WABA |
| 10 | WA-10 | Info | **done** | Live connect verified (UI shows connected) |
| 11 | WA-11 | High | **done** | Controlled dialog/oauth + fixed redirect_uri |
| 12 | WA-12 | High | **done** | Signed OAuth state + cookies on redirect |
| 13 | WA-13 | Medium | **done** | Popup via window.open + postMessage |
| 14 | WA-14 | Low | **optional** | Disable temporary hardcodedConfig for env-only |
| 15 | WA-15 | High | **open** | Connected but outbound message not delivered |
| 16 | WA-16 | Low | **optional** | Admin step-by-step WhatsApp logs (newest first) |

---

## WA-01 … WA-09 (early batch)

### WA-01 — System User used too early  
**Status:** done  
User token preferred for phone/webhooks at connect; System User fallback.

### WA-02 — Webhook abort connect  
**Status:** done  
Store + audit first; subscribe returns boolean, non-fatal.

### WA-03 — Hidden failure step  
**Status:** done  
JSON `{ error, step, meta? }`; `[wa-debug]` client logs. Full-page/popup paths use redirect or postMessage errors.

### WA-04 — Phone Meta body  
**Status:** done  
`phoneNumbers.ts` includes Graph body in errors.

### WA-05 — Code exchange retry  
**Status:** done  
No withRetry wrapping successful multi-use burning; exchange candidates tried carefully.

### WA-06 — redirect_uri / 36008  
**Status:** done (code + controlled URI)  
Diagnostics + fixed `https://www.centro-ai.co.il/api/auth/whatsapp/oauth` dialog+exchange. Client must keep URI on Meta Valid OAuth list.

### WA-07 — Missing granular scopes  
**Status:** done (error clarity)  
Config permissions still Meta dashboard.

### WA-08 — SDK hang  
**Status:** done  
Settle/poll path when FB SDK script already present (less critical after dialog/oauth).

### WA-09 — Docs / architecture postMessage  
**Status:** done  
Then superseded by WA-11; docs refreshed 2026-08-04 again.

---

## WA-10 — Live connect verification

**Status:** **done**  

Confirmed: client UI shows **WhatsApp connected** with phone after full OAuth flow.  
Connect path stores WABA + phone_number_id server-side before UI success.

---

## WA-11 — Controlled dialog OAuth (redirect_uri)

**Status:** done  

**Problem:**  
`FB.login` codes could not be exchanged: live Meta responses **36008** (URI mismatch) and earlier **191** (App Domains).

**Solution:**

- `GET /api/auth/whatsapp/start` → Meta `dialog/oauth` with  
  `redirect_uri=https://www.centro-ai.co.il/api/auth/whatsapp/oauth`
- `GET /api/auth/whatsapp/oauth` completes signup (`completeWhatsAppSignup`)

**Files:**  
`start/route.ts`, `oauth/route.ts`, `completeSignup.ts`, `embeddedSignup.ts`, `WhatsAppConnectButton.tsx`

---

## WA-12 — Invalid state / mixed `whatsapp=connected` + errors

**Status:** done  

**Problem:**  
Cookie-only CSRF dropped after Facebook return; double hits stacked `error=` and `whatsapp=`.

**Solution:**

- HMAC-signed `state` payload (`oauthState.ts`): returnTo, redirectUri, csrf, popup flag  
- Cookies set on **redirect Response**  
- Clean return URL builders (no param stacking)  
- Soft handling of code already used / empty second hit  

---

## WA-13 — Popup UX without FB.login

**Status:** done  

- Connect opens `window.open(/api/auth/whatsapp/start?popup=1…)`  
- Popup finishes → HTML postMessages `centro-whatsapp-oauth` → opener `router.refresh()`  
- Popup blocked → full-page fallback  

---

## WA-14 — Temporary hardcode (optional)

**Status:** optional  

`src/lib/whatsapp/hardcodedConfig.ts` with `WHATSAPP_HARDCODE_ENABLED = true` forces App ID / Config ID / redirect strings.  
**Secrets empty** → still Vercel.  
Turn `ENABLED` false for clean env-only production.

---

## WA-15 — Connected but no WhatsApp message

**Status:** open  

**Not the same as connect.**

Initial automated message uses:

- org `whatsappPhoneNumberId`  
- `WHATSAPP_SYSTEM_USER_TOKEN`  
- template (e.g. `centro_initial_request` / `he`)  
- gates: automation, business hours  

**Need from production for root Meta error:**

1. Vercel log: `[whatsapp] send failed` (status + full body)  
2. DB: last `messages.delivery_status`  
3. Meta: template approval status for that WABA  
4. Meta: System User asset access on that WABA  

Code paths: `conversationOrchestration.ts` → `send.ts`.

---

## WA-16 — Admin step logs descending (optional)

**Status:** optional  

Today: sparse `audit_logs` + Vercel console.  
Desired: every OAuth/send step in owner/org UI, newest first, no secrets.

---

## Progress log

| Date | Note |
|------|------|
| 2026-08-03 | Issues list created |
| 2026-08-04 | WA-01…WA-09 implemented |
| 2026-08-04 | WA-11–WA-13 OAuth rewrite; hardcode for diagnosis |
| 2026-08-04 | WA-10 live connect confirmed; WA-15 outbound still open |
| 2026-08-04 | Docs fully refreshed (issues + implementation + ARCHITECTURE) |
