# WhatsApp Connect — Implementation Record

**Last updated:** 2026-08-04  
**Live URL:** https://www.centro-ai.co.il/  
**Issues list:** [`docs/whatsapp-connect-issues.md`](./whatsapp-connect-issues.md)  
**Goal:** Reliable per-org WhatsApp Business connect (Embedded Signup / OAuth) without per-org tokens; Tech Provider System User for send/receive.

---

## Current production status (2026-08-04)

| Area | Status |
|------|--------|
| OAuth connect (WABA + phone ID stored) | **Working on live** — UI shows WhatsApp connected |
| Code exchange redirect_uri match | Fixed via controlled `dialog/oauth` + fixed callback URI |
| Meta App Domains / Valid OAuth | Required on Meta app; previously caused 191 / “URL Blocked” |
| App secret vs App ID | Confirmed OK (`GET /api/auth/whatsapp/debug-config` → graphAppLookup.ok) |
| Outbound first customer message | **Separate from connect** — may still fail (templates, System User rights, automation gates) |
| Admin step-by-step audit UI | **Not built** (sparse audit events only; detailed steps in Vercel logs) |

---

## Architecture (how connect works *now*)

```
[WhatsAppConnectButton]
    │  window.open(.../api/auth/whatsapp/start?popup=1&returnTo=...)
    ▼
[GET /api/auth/whatsapp/start]
    │  signed OAuth state (returnTo + redirectUri + csrf + popup)
    │  Set-Cookie on redirect Response
    ▼
[Facebook dialog/oauth]
    │  client_id, config_id, response_type=code, extras, redirect_uri=
    │  https://www.centro-ai.co.il/api/auth/whatsapp/oauth
    ▼
[GET /api/auth/whatsapp/oauth?code=&state=]
    │  completeWhatsAppSignup(...)
    ▼
[exchange code → user token] → [WABA via debug_token] → [phone via Graph]
    → storeWabaConnection (org columns) → audit integration.whatsapp_connected
    → webhooks best-effort → templates best-effort
    ▼
[popup postMessage ok → parent refresh]  or  [full-page redirect ?whatsapp=connected]
```

### Why not pure `FB.login` anymore?

Early `FB.login()` returned a code, but Graph **code exchange** failed with:

- **36008** — `redirect_uri` on exchange ≠ URI Meta bound in the dialog  
- **191** — domain not in Meta App Domains / redirect not owned by app  

Site origin and “omit redirect_uri” both failed live. Controlled **Web OAuth** with a **fixed** callback URI makes dialog and exchange match byte-for-byte.

Popup UX is restored via **`window.open` of `/api/auth/whatsapp/start`**, not opaque `FB.login`.

### OAuth callback URI (must match Meta Valid OAuth Redirect URIs)

```text
https://www.centro-ai.co.il/api/auth/whatsapp/oauth
```

Also list site origins on Meta as needed:

```text
https://www.centro-ai.co.il/
https://www.centro-ai.co.il
```

**App Domains** (no `https://`): `centro-ai.co.il`, `www.centro-ai.co.il`  
**Website Site URL:** `https://www.centro-ai.co.il/`  
**Client OAuth Login / Web OAuth Login / Login with JS SDK:** Yes  

### Tokens

| Token | Stored? | Used for |
|-------|---------|----------|
| Short-lived signup user token (from code) | **No** (request-only) | WABA resolve, phone list, best-effort webhook at connect |
| `WHATSAPP_SYSTEM_USER_TOKEN` | Env only | All ongoing Graph send/receive |

### What is saved on the organization

- `whatsappBusinessAccountId` (WABA)  
- `whatsappPhoneNumberId`  
- `whatsappDisplayPhoneNumber`  
- `whatsappVerifiedName`  
- `whatsappConnectedAt`  

**Not saved:** customer OAuth access token.

### Post-signup order (`completeWhatsAppSignup`)

1. Exchange code → user access token (`onlyPreferred` redirect for dialog flow)  
2. Resolve WABA (`debug_token` granular scopes)  
3. List phones (user token first, System User fallback)  
4. **Store + audit**  
5. Webhook subscribe (**best-effort**)  
6. Template provision (**best-effort**)  

UI “connected” only after step 4 succeeds.  
`ok: true` / popup `ok` only after that path returns (not “dialog closed only”).

---

## Issue tracker summary

| ID | Status | Notes |
|----|--------|-------|
| WA-01 … WA-09 | **Done** | Early reliability batch (user token, non-fatal webhooks, step errors, etc.) |
| WA-10 | **Done** | Live connect confirmed connected in UI |
| WA-11 | **Done** | Controlled dialog/oauth + fixed callback URI |
| WA-12 | **Done** | Signed OAuth state + cookies on redirect Response |
| WA-13 | **Done** | Popup via window.open + postMessage close |
| WA-14 | **Open / optional** | Disable temporary hardcode config; env-only production |
| WA-15 | **Open** | Outbound not delivering; diagnose Graph/templates/System User (not connect) |
| WA-16 | **Open / optional** | Admin step log UI (descending) for WhatsApp pipeline |

Full detail: [`whatsapp-connect-issues.md`](./whatsapp-connect-issues.md).

---

## Key files

| Path | Role |
|------|------|
| `src/components/app/WhatsAppConnectButton.tsx` | Popup `window.open` → start; listens for `centro-whatsapp-oauth` |
| `src/app/api/auth/whatsapp/start/route.ts` | Build Meta dialog URL; signed state; set cookies on redirect |
| `src/app/api/auth/whatsapp/oauth/route.ts` | Meta redirect target; complete signup; popup HTML or redirect |
| `src/app/api/auth/whatsapp/callback/route.ts` | Legacy JSON POST complete (if used) |
| `src/app/api/auth/whatsapp/debug-config/route.ts` | Session-only: App ID, redirect URIs, secret matches app (no token values) |
| `src/lib/whatsapp/completeSignup.ts` | Shared post-code pipeline |
| `src/lib/whatsapp/embeddedSignup.ts` | Exchange, WABA, webhooks, multi-candidate redirect diagnostics |
| `src/lib/whatsapp/oauthState.ts` | HMAC-signed state, clean returnTo, popup result HTML |
| `src/lib/whatsapp/hardcodedConfig.ts` | **Temporary** diagnosis switch (turn off when stable) |
| `src/lib/whatsapp/wabaTokens.ts` | Store / clear org WhatsApp identifiers |
| `src/lib/whatsapp/send.ts` | Outbound Graph send (**System User** + `phoneNumberId`) |

---

## Early batch (WA-01 … WA-09) — still in effect

| ID | Title |
|----|--------|
| WA-01 | Prefer signup user token for phone / webhooks before System User |
| WA-02 | Store connection before webhook subscribe; subscribe best-effort |
| WA-03 | API/client diagnostics: `step` + `[wa-debug]` |
| WA-04 | Phone list errors include Meta body in server error |
| WA-05 | No `withRetry` on code exchange (failed candidates still retried with **new redirect**, not same success path) |
| WA-06 | 36008/191 hints in exchange errors |
| WA-07 | Clearer missing granular-scope message |
| WA-08 | FB SDK settle/poll (legacy path; popup OAuth less dependent) |
| WA-09 | Docs/architecture aligned to no postMessage WABA ids |

---

## Diagnostics endpoints & logs

### Session: `GET /api/auth/whatsapp/debug-config`

Returns (no secrets):

- `appId`, `configId`, oauth redirect candidates  
- `secretPresent`, `secretFrom`  
- `graphAppLookup` — whether `appId|appSecret` resolves Meta app name  

### Browser console `[wa-debug]`

Popup open / postMessage results.

### Vercel Function logs

| Prefix | Meaning |
|--------|---------|
| `[whatsapp-oauth]` | Start/callback/exchange/subscribe pipeline |
| `[whatsapp] send failed` | Outbound Graph failure **with HTTP status + Meta body** |
| `[whatsapp-config] HARDCODE mode` | Temporary hardcode switch is on |

Audit events (sparse):

- `integration.whatsapp_connected`  
- `whatsapp.outbound_send_failed` (no full Meta JSON in audit metadata today)

---

## Connect vs “message not received”

**Connected ≠ message delivered.**

Initial automated collection message path (high level):

1. Wizard / send now → `sendOutboundMessage` (ai)  
2. Gates: automation activated, not paused, business hours  
3. Template map → e.g. `centro_initial_request` (`he`)  
4. `POST /{whatsappPhoneNumberId}/messages` with **System User** token  

Common reasons “connected but no WhatsApp”:

| Cause | deliveryStatus / behavior |
|-------|---------------------------|
| Template PENDING/REJECTED / not provisioned | Graph `failed` |
| System User cannot message that WABA/phone | Graph `failed` |
| Automation off / outside hours | Held; may look scheduled |
| Bad client phone E.164 | `invalid_phone` |
| Webhook subscribe failed | Usually **inbound** only; not primary for first outbound |

**Exact Meta error for last send** lives in Vercel `[whatsapp] send failed…` or `messages.delivery_status` — not only UI “sent”.

---

## Temporary hardcode config

File: `src/lib/whatsapp/hardcodedConfig.ts`

- `WHATSAPP_HARDCODE_ENABLED = true` forces known production App ID / Config ID / redirect URIs for diagnosis.  
- **Secrets stay empty** → always from Vercel env.  
- **WA-14:** set `ENABLED = false` once env is confirmed correct and leave production on env only.

Production App ID (documented for ops, not a secret): `1043370264820423` (Centro AI Messaging).  
Config ID: `2531621403952088`.

---

## Required Vercel / Meta config

### Vercel Production

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_WHATSAPP_APP_ID` | Meta App ID |
| `NEXT_PUBLIC_WHATSAPP_CONFIG_ID` | Embedded Signup Configuration ID |
| `WHATSAPP_APP_SECRET` | Code exchange + app token probe |
| `WHATSAPP_SYSTEM_USER_TOKEN` | Ongoing send/receive |
| `WHATSAPP_OAUTH_REDIRECT_URI` | Prefer `https://www.centro-ai.co.il/api/auth/whatsapp/oauth` (or site root if only listing that) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Webhook GET + app subscription |

Webhook callback (code constant):  
`https://www.centro-ai.co.il/api/webhooks/whatsapp`

### Meta checklist (App ID above)

1. App Domains: `centro-ai.co.il`, `www.centro-ai.co.il`  
2. Website Site URL: `https://www.centro-ai.co.il/`  
3. Valid OAuth Redirect URIs: include oauth callback + site roots  
4. Client OAuth + Web OAuth + Enforce HTTPS = Yes  
5. System User has WABA / messaging assets for outbound after connect  

---

## How to retest connect (live)

1. Allow popups for `www.centro-ai.co.il`  
2. Click חיבור → Meta dialog popup  
3. Complete Embedded Signup  
4. Popup closes → UI shows connected phone  
5. Optional: `GET /api/auth/whatsapp/debug-config` while logged in  

**Pass:** connected UI + org row populated.  
**Fail codes in return URL (full page mode):** `whatsapp-invalid-state`, `whatsapp-oauth-failed`, `whatsapp-session-lost`, etc.

---

## What did not change (product model)

- Tech Provider: one `WHATSAPP_SYSTEM_USER_TOKEN`  
- No per-org WhatsApp OAuth token storage  
- Webhook route shape (GET verify + POST signatures)  
- Google Drive OAuth isolated  
- Hebrew generic connect error for users; detail in logs/`step`

---

## Progress log

| Date | Action |
|------|--------|
| 2026-08-03 | Issues list created |
| 2026-08-04 | WA-01…WA-09 implemented |
| 2026-08-04 | WA-11–WA-13: dialog/oauth, signed state, popup restore |
| 2026-08-04 | Live: connect OK; WA-10 done; hardcode still for diagnosis |
| 2026-08-04 | Docs refreshed to match controlled OAuth + connect-vs-send |
