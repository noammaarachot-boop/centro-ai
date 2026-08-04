# WhatsApp Connect — Implementation Record

**Date:** 2026-08-04  
**Live URL:** https://www.centro-ai.co.il/  
**Issues source:** `docs/whatsapp-connect-issues.md`  
**Goal:** Fix Embedded Signup completion reliability and diagnostics without breaking Google Drive, messaging, webhooks for already-connected orgs, or successful connect paths.

---

## Summary

| ID | Title | Status | Code change? |
|----|--------|--------|--------------|
| WA-01 | Prefer user token after signup for phone/webhooks | **Done** | Yes |
| WA-02 | Webhook failure must not block saving connection | **Done** | Yes |
| WA-03 | Return/log failure step to client | **Done** | Yes |
| WA-04 | Include Meta body on phone-list errors | **Done** | Yes |
| WA-05 | No `withRetry` on single-use OAuth code exchange | **Done** | Yes |
| WA-06 | Detect redirect_uri / 36008 clearly in logs | **Done** | Yes (diagnostics; env still client-side) |
| WA-07 | Clearer missing-granular-scope error | **Done** | Yes (message; Meta Config still client-side) |
| WA-08 | Facebook SDK reload hang | **Done** | Yes |
| WA-09 | Architecture doc vs real flow | **Done** | Docs only |
| WA-10 | Confirm live failing step from production logs | **Open** | Needs live attempt after deploy |

---

## What did **not** change (safety)

Preserved on purpose so existing functionality stays intact:

- **Tech Provider model** — still one shared `WHATSAPP_SYSTEM_USER_TOKEN` for ongoing send/receive; no per-org WhatsApp token storage
- **DB schema** — same `organizations` WhatsApp columns; `storeWabaConnection` / `clearWabaConnection` unchanged
- **Webhook route** — `GET/POST /api/webhooks/whatsapp` untouched (inbound path unchanged)
- **Outbound send / templates / phone E.164** — `send.ts`, `templates.ts`, `phone.ts` untouched
- **Facebook login params** — still `config_id`, `response_type: "code"`, `override_default_response_type`, `extras` (sessionInfoVersion `"3"`)
- **User-facing Hebrew error** — still generic “חיבור WhatsApp נכשל. נסו שוב.” (detail only in console/`step` JSON)
- **Session requirement** on callback — still `requireSession()`
- **Template auto-provisioning** — still best-effort after connect
- **Google Drive OAuth** — completely separate; untouched

---

## New post-signup order (callback)

**Before (fragile):**

1. Exchange code  
2. Resolve WABA  
3. **Subscribe webhooks (System User only) — fatal**  
4. **List phones (System User only) — fatal**  
5. Store connection  

**After (safer):**

1. Exchange code (user access token)  
2. Resolve WABA from user token  
3. List phones (**user token first**, System User fallback)  
4. **Store connection + audit**  
5. Subscribe webhooks (**best-effort**, user token then System User)  
6. Template provisioning (best-effort, unchanged)

If step 5 fails, the org still shows as **WhatsApp connected**. Inbound webhooks may not work until reconnect or Meta asset share succeeds — logged as non-fatal.

---

## File-by-file changes

### 1. `src/lib/whatsapp/embeddedSignup.ts`

| Change | Why |
|--------|-----|
| `WhatsAppSignupStep` type + `step` on `WhatsAppSignupError` | WA-03 safe diagnostics |
| `exchangeSignupCode` uses single `fetch` (no `withRetry`) | WA-05 single-use codes |
| 36008 body → extra log hint about `WHATSAPP_OAUTH_REDIRECT_URI` | WA-06 |
| `resolveWabaIdFromToken` errors tagged `waba-resolve` + Config permission hint | WA-03, WA-07 |
| `subscribeToWabaWebhooks(wabaId, preferredAccessToken?)` → `Promise<boolean>` | WA-01, WA-02 |
| Tries preferred user token, then System User, never throws for WABA-level fail | WA-01, WA-02 |

### 2. `src/lib/whatsapp/phoneNumbers.ts`

| Change | Why |
|--------|-----|
| `getFirstPhoneNumberForWaba(wabaId, preferredAccessToken?)` | WA-01 |
| Tries preferred token then System User | WA-01 |
| Error messages include Meta response body | WA-04 |
| `WhatsAppApiError.step = "phone-lookup"` | WA-03 |

### 3. `src/app/api/auth/whatsapp/callback/route.ts`

| Change | Why |
|--------|-----|
| Reordered flow: resolve phone → store → webhooks | WA-02 |
| Passes `userAccessToken` into phone + webhook helpers | WA-01 |
| Failure JSON: `{ error, step }` | WA-03 |
| Success JSON: `{ ok: true, webhooksSubscribed: boolean }` | Visibility of soft webhook lag |
| Server log includes `step=` | Ops without inventing new infra |

### 4. `src/components/app/WhatsAppConnectButton.tsx`

| Change | Why |
|--------|-----|
| Parses callback JSON; logs `step` / status on failure | WA-03 |
| Logs `webhooksSubscribed` on success | Soft webhook lag visibility |
| SDK load: settle guard, poll for `window.FB`, handle existing script load | WA-08 |
| Click → `FB.login` remains synchronous (no await before popup) | Do not re-break popup |

### 5. `ARCHITECTURE.md` (M-WA-2 row)

Updated to match server-side WABA/phone derivation and best-effort webhooks (no longer describes dual postMessage + client ids).

### 6. `docs/whatsapp-connect-issues.md`

Statuses updated to match this implementation pass.

---

## API contract (callback)

### Success — `200`

```json
{
  "ok": true,
  "webhooksSubscribed": true
}
```

`webhooksSubscribed: false` means connection **was saved**, but Meta WABA subscribe failed (check server logs). Messaging out via System User may still work later; **inbound** may not until subscribe succeeds.

### Failure — `502`

```json
{
  "error": "whatsapp-signup-failed" | "whatsapp-unknown-error",
  "step": "code-exchange" | "waba-resolve" | "phone-lookup" | "store" | "webhook-subscribe" | "unknown"
}
```

### Failure — `400`

```json
{ "error": "invalid-request" }
```

**Not returned to client (security):** App Secret, tokens, raw Graph bodies. Those remain in **Vercel Function logs** under `[whatsapp-oauth]` / `[whatsapp]`.

---

## How to test on Vercel (live)

1. Deploy this branch/commits to production (git push → Vercel).  
2. Log in as Meta **App Admin / Developer** on https://www.centro-ai.co.il/  
3. Open Settings / Onboarding connect WhatsApp.  
4. DevTools → Console filter `[wa-debug]`, Network → `callback`.  
5. Complete Embedded Signup popup.

**Pass criteria:**

| Check | Expected |
|-------|----------|
| Popup opens | Yes |
| Network `POST /api/auth/whatsapp/callback` | `200` with `ok: true` |
| UI shows connected number | Yes |
| If `webhooksSubscribed: false` | Connection still shown; investigate Meta System User share / env |
| On failure | Console shows `step` (e.g. `code-exchange`, `phone-lookup`) |

**If `step` is `code-exchange` and logs mention 36008:**  
Verify Vercel `WHATSAPP_OAUTH_REDIRECT_URI` matches Meta Valid OAuth Redirect URIs **exactly** (or clear both if unused).

**If `step` is `waba-resolve`:**  
Check Embedded Signup Configuration permissions in Meta dashboard.

**If `step` is `phone-lookup`:**  
Token cannot see phone numbers yet — permissions or Business Verification / asset sharing.

---

## Client env still required (not code)

Vercel Production must have:

- `NEXT_PUBLIC_WHATSAPP_APP_ID`
- `NEXT_PUBLIC_WHATSAPP_CONFIG_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `WHATSAPP_OAUTH_REDIRECT_URI` (if Meta has a redirect URI configured)
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`

Webhook callback URL in code remains:

`https://www.centro-ai.co.il/api/webhooks/whatsapp`

---

## Meta Business Verification note

These fixes improve **code completion and diagnostics**.  
They do **not** replace Meta Business Verification / WhatsApp partner approval.

- **Admin/Developer** accounts may complete connect after these fixes.  
- **All customers + production messaging** may still need verification.

---

## Double-check checklist (author)

- [x] No schema / migration  
- [x] No change to Google Drive routes  
- [x] No change to webhook signature / GET handshake  
- [x] System User still used as fallback + for future send/receive  
- [x] Popup sync-click path preserved  
- [x] Existing successful path still returns 200 + stores connection when Meta allows it  
- [x] Existing WhatsApp unit tests still pass (phone / templates / webhookSignature)  

---

## Progress log

| Date | Action |
|------|--------|
| 2026-08-03 | Issues list created; no code changes |
| 2026-08-04 | WA-01…WA-09 implemented as above; implementation record written |
