# Centro

Centro is a full product: a marketing landing page plus a real, authenticated
application. The app is a digital employee that collects documents from a
business's own clients automatically — over WhatsApp, with Google Drive
storage, AI-assisted document classification, and a learning engine that
improves what it asks for over time. Built with Next.js (App Router),
TypeScript, Drizzle ORM, and Tailwind CSS v4.

> The **landing page** (`/`) is marketing-only. The **application**
> (everything behind `/login`) is real: real auth, a real database, a real
> onboarding wizard, and a real dashboard — WhatsApp/Google Drive/AI are
> currently mocked, documented, swappable integrations (see
> `ARCHITECTURE.md`), not simulated UI.

For the product's architectural principles, the two-workflow model, and a
full history of every milestone, see **`ARCHITECTURE.md`** — it is the
single source of truth and takes precedence over this file if the two ever
disagree.

## Installation & running

Requires Node.js 20+.

```bash
npm install
npm run dev
```

The app runs at the address printed in the terminal (usually
`http://localhost:3000` — if that port is busy, Next.js picks another one
and prints it). No local Postgres install is required to get started: with
no `DATABASE_URL` set, the app falls back to an embedded PGlite database
automatically.

Other commands:

```bash
npm run build          # production build + full type-check
npm run start           # run the production build
npm run lint             # ESLint
npm run test              # Vitest unit tests
npm run db:generate  # generate a Drizzle migration from schema changes
npm run db:migrate    # apply migrations
npm run org:create     # seed a real organization + user from the CLI
```

### Environment variables

Copy `.env.example` to `.env.local` and fill in real values for anything
beyond local development:

- `DATABASE_URL` — a real PostgreSQL connection string. Required in
  production; optional in development (falls back to embedded PGlite).
- `CRON_SECRET` — shared secret required by `POST /api/cron/tick`, the
  endpoint an external scheduler (Vercel Cron, GitHub Actions, etc.) calls
  to evaluate idle conversations and send reminders. Required in production;
  optional in development.

## What's in the app

Behind `/login`, a registered organization gets:

- **Onboarding** (`/onboarding`) — a multi-step wizard: business info,
  business type, a permanent choice between the **recurring** workflow
  (Centro learns what to collect from each client over time) and the
  **one-time** workflow (reusable Templates, no learning — see
  `ARCHITECTURE.md` Chapter 9), Google Drive/WhatsApp connection, an
  optional Excel/CSV client import with AI-assisted column detection, a
  Setup Summary, and a completion screen.
- **Dashboard** (`/dashboard`) — a different screen per workflow: the
  recurring dashboard surfaces queues (needs review, waiting on client,
  processing, business-type suggestions, pending confirmations); the
  one-time dashboard surfaces templates, clients, and active/completed
  requests. Both show a small "Centro Active" status indicator and an
  AI-generated briefing summarizing what needs attention right now.
- **Clients** (`/clients`) — client list, detail, manual creation, Excel
  import, business-type assignment, and per-client document-profile history.
- **Templates / Services** (`/templates` or `/services`, depending on
  workflow) — the same underlying entity, labeled per workflow: what
  documents to request, from whom, and (for Templates) when to send.
- **Collection Requests** (`/collections`) — the full lifecycle of one
  document-collection cycle: status, documents received/approved/rejected,
  the WhatsApp conversation, unmatched-document triage, and pending
  client confirmations.
- **Activity History** (`/audit`) — an immutable, day-grouped, filterable
  log of every meaningful event in the system.
- **Settings** (`/settings`) — business info, business hours, automation
  on/off, and (behind a clearly-marked "Developer Tools" disclosure) manual
  triggers for pilot-stage stand-ins like the scheduler tick.
- **Privacy Policy / Terms of Service** (`/privacy`, `/terms`) — real,
  complete Hebrew legal content, linked from login, registration, and every
  onboarding step.

## Project structure

```
src/
  app/
    page.tsx, layout.tsx, globals.css   the landing page + its RTL/design-token shell
    (app)/                               the authenticated application (dashboard, clients, …)
    login/, register/, forgot-password/, reset-password/   auth screens
    onboarding/                          the onboarding wizard (steps/ + shared actions.ts)
    privacy/, terms/                     real legal pages
    api/                                 route handlers (health check, cron tick)
  components/
    landing/                             marketing-page-only components (never used by the app)
    app/                                 the app's shared UI library (Card, KpiCard, Table,
                                          FormField, ConfirmDialog, AnimatedCheckBadge, …)
  db/                                    Drizzle schema + connection (schema.ts, index.ts)
  lib/                                   business logic: auth, AI classification stubs,
                                          import/column-detection, scheduling, audit, etc.
scripts/                                 CLI utilities (migrate, create-organization)
```

## Design system — "Centro Glow"

The authenticated app and the landing page share one design-token source
(`src/app/globals.css`'s `@theme inline` block — colors, radii, shadows,
motion easing/duration). The app's own visual language ("Centro Glow"):
an almost-white background with very soft ambient blue/purple/teal
gradients, glass/translucent elevated surfaces, gradient icon badges, and a
shared hover mechanic where a card's glow appears *behind* it (never
inside), colored to match its own icon — extremely subtle, never bright.
Motion is restrained by default (one-time entrance animations, hover/click
micro-interactions) with a few deliberate exceptions for genuine moments:
a progressive reveal on the AI-analysis onboarding step, an animated
circle-to-checkmark for connection/completion states, and a real canvas
confetti burst (blue/purple/teal/white/gold) the first time onboarding
completes. The official Centro "C" brand mark (`src/components/landing/icons/CentroMark.tsx`)
appears throughout the app — sidebar, login, every onboarding step — and
is never redrawn, simplified, or reinterpreted; only a soft glow/breathing
wrapper varies around it.

The landing page's own visual language (busier animated aurora
background, Framer Motion scroll choreography) is deliberately distinct
and out of scope for the app's design system — the two are visually
related (same color tokens) but not identical, and the app's Sidebar is
the only place the "C" mark ever needs to coexist with the landing page's
own header usage.

## Two-workflow model, in one sentence

**Recurring:** Centro learns what documents to request from each client
over time. **One-time:** the user manages reusable Templates instead;
Centro never learns. See `ARCHITECTURE.md` Chapter 9 for the full model.

## Accessibility & responsiveness

- `<html lang="he" dir="rtl">` throughout; full keyboard navigation and
  visible `:focus-visible` states everywhere.
- `prefers-reduced-motion` is respected globally and per-animation (every
  custom keyframe in `globals.css` has a corresponding reduced-motion
  override).
- The landing page and the entire application are responsive down to small
  phone widths (iPhone SE and narrower) with no horizontal scrolling —
  `body { overflow-x: clip }` is a deliberate global safeguard against
  decorative full-bleed elements, on top of per-component responsive
  layout.

## Testing

- `npm run test` — Vitest unit tests (business logic: classification,
  scheduling, import/column-detection, state machines).
- Live end-to-end verification of user-facing flows is done ad hoc with
  Playwright during development (not checked into the repo as a
  dependency — installed temporarily with `npm install --no-save
  playwright` when needed, then removed) rather than as a committed test
  suite; see `ARCHITECTURE.md`'s Document History for what each round's
  live verification actually covered.
