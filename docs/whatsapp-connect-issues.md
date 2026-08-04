# WhatsApp / Facebook Connect — Issues List

Track and fix these one by one. Do not start the next issue until the current one is verified.

**Status key:** `open` · `in_progress` · `done` · `wontfix` · `needs_logs`

**Implementation record:** [`docs/whatsapp-connect-implementation.md`](./whatsapp-connect-implementation.md)

---

## Deployment constraints (live)

| Item | Value |
|------|--------|
| Live URL | https://www.centro-ai.co.il/ |
| Hosting | Vercel |
| Our access | **Git repo only** (push → Vercel auto-deploy) |
| Not assumed | Vercel dashboard, Meta App Dashboard, production DB, server log access |

### How we ship + test under these constraints

1. Fix one issue in a branch / commit
2. Push to GitHub → Vercel builds and deploys production (or preview URL if using PR previews)
3. Test on live: log into app → Connect WhatsApp → watch browser Network + Console
4. For server-side Meta errors we cannot see without Vercel logs — either:
   - ask client for Vercel Function logs, **or**
   - use **WA-03** `step` field on failed `POST /api/auth/whatsapp/callback`

### What we can do with git-only access
- Fix all code issues (WA-01 … WA-05, WA-08, WA-09)
- Deploy via git push
- Verify from browser on https://www.centro-ai.co.il/ (UI, Network tab, `[wa-debug]` console)

### What we need from the client (cannot do from git alone)
- **Vercel env check** for WhatsApp vars (especially `WHATSAPP_OAUTH_REDIRECT_URI`) — WA-06
- **Vercel Runtime Logs** for `[whatsapp-oauth]` full bodies — still useful
- **Meta App Dashboard** if Config permissions / redirect URI / System User sharing are wrong — WA-06, WA-07
- A test Meta Business + WhatsApp number for safe live connect attempts

### Required Vercel env vars (Production)

- `NEXT_PUBLIC_WHATSAPP_APP_ID`
- `NEXT_PUBLIC_WHATSAPP_CONFIG_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `WHATSAPP_OAUTH_REDIRECT_URI` (only if Meta dashboard has a Valid OAuth Redirect URI)
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`

Webhook callback in code:  
`https://www.centro-ai.co.il/api/webhooks/whatsapp`

---

## Priority order

| # | ID | Severity | Status | Title |
|---|----|----------|--------|-------|
| 1 | WA-01 | High | **done** | Connection fails after Meta popup because System User token is used too early |
| 2 | WA-02 | High | **done** | Webhook subscribe failure aborts the whole connection |
| 3 | WA-03 | High | **done** | UI hides the real failure step / Meta error |
| 4 | WA-04 | Medium | **done** | Phone number lookup drops Meta error body |
| 5 | WA-05 | Medium | **done** | OAuth code exchange is wrapped in `withRetry` (codes are single-use) |
| 6 | WA-06 | Medium | **done** (code) / **needs client env** | `WHATSAPP_OAUTH_REDIRECT_URI` mismatch — code detects 36008; env must match Meta |
| 7 | WA-07 | Medium | **done** (code) / **needs Meta Config** | WABA resolve fails when granular scopes are missing |
| 8 | WA-08 | Low | **done** | Facebook SDK reload can hang if script already loaded |
| 9 | WA-09 | Low | **done** | Architecture docs still describe the old postMessage flow |
| 10 | WA-10 | Info | **needs_logs** | Confirm exact production failing step from live logs after deploy |

---

## WA-01 — System User token used too early after Embedded Signup

**Severity:** High  
**Status:** done  
**Files:**
- `src/app/api/auth/whatsapp/callback/route.ts`
- `src/lib/whatsapp/phoneNumbers.ts`
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
`getFirstPhoneNumberForWaba` and `subscribeToWabaWebhooks` accept optional preferred (user) access token, tried before System User token.

**Done when:**  
Fresh Embedded Signup can resolve phone number using the user token when System User cannot see the WABA yet. *(Live verify: WA-10)*

---

## WA-02 — Webhook subscribe failure aborts the whole connection

**Severity:** High  
**Status:** done  
**Files:**
- `src/app/api/auth/whatsapp/callback/route.ts`
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
Store connection + audit first. Webhook subscribe runs after store and returns `boolean` instead of throwing. Failures logged non-fatal; response includes `webhooksSubscribed`.

---

## WA-03 — UI hides the real failure step / Meta error

**Severity:** High  
**Status:** done  
**Files:**
- `src/app/api/auth/whatsapp/callback/route.ts`
- `src/components/app/WhatsAppConnectButton.tsx`
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
API returns `{ error, step }`. Client logs step under `[wa-debug]`. User-facing copy stays generic.

---

## WA-04 — Phone number lookup drops Meta error body

**Severity:** Medium  
**Status:** done  
**Files:**
- `src/lib/whatsapp/phoneNumbers.ts`

**What was done:**  
Failed phone list includes response text in `WhatsAppApiError` (server logs).

---

## WA-05 — OAuth code exchange uses `withRetry`

**Severity:** Medium  
**Status:** done  
**Files:**
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
Code exchange uses a single `fetch` (no retry).

---

## WA-06 — `redirect_uri` / env mismatch can still 502

**Severity:** Medium  
**Status:** done (code diagnostics) — env still client responsibility  
**Files:**
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
If Meta body contains `36008`, error message appends hint about `WHATSAPP_OAUTH_REDIRECT_URI`.

**Still needed from client:** Confirm Vercel env matches Meta dashboard.

---

## WA-07 — WABA resolve fails when granular scopes are missing

**Severity:** Medium  
**Status:** done (clearer error) — Config still Meta dashboard  
**Files:**
- `src/lib/whatsapp/embeddedSignup.ts`

**What was done:**  
Richer error pointing at Embedded Signup Configuration permissions; step `waba-resolve`.

---

## WA-08 — Facebook SDK reload hang edge case

**Severity:** Low  
**Status:** done  
**Files:**
- `src/components/app/WhatsAppConnectButton.tsx`

**What was done:**  
Settle guard, poll for `window.FB`, existing-script load handlers so remount does not hang 15s when SDK already present.

---

## WA-09 — Docs out of date vs current implementation

**Severity:** Low  
**Status:** done  
**Files:**
- `ARCHITECTURE.md` (M-WA-2 row)
- `docs/whatsapp-connect-implementation.md`

---

## WA-10 — Confirm exact production failing step (needs live attempt)

**Severity:** Info  
**Status:** needs_logs  

**Needed after deploy:**
1. One Connect attempt as Meta admin/developer  
2. Browser: `[wa-debug]` + Network response for `/api/auth/whatsapp/callback`  
3. Optional: Vercel log `[whatsapp-oauth]`

---

## Progress log

| Date | Issue | Note |
|------|-------|------|
| 2026-08-03 | — | Issues list created. No fixes applied. |
| 2026-08-04 | WA-01…WA-09 | Implemented carefully; see implementation record. WA-10 open until live verify. |
