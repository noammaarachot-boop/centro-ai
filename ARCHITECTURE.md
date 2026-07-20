# Centro Architecture & Philosophy

This document is the single source of truth for Centro's architectural principles and
product philosophy. Every design and implementation decision in this codebase is
expected to follow it. It is version-controlled alongside the code it governs, updated
at the end of every roadmap milestone, and rendered to
`reports/Centro-Architecture-and-Philosophy.pdf` for distribution outside the repo.

When an implementation decision conflicts with this document, the document wins unless
the conflict is explicitly raised, discussed, and resolved here first — never resolved
silently in code.

---

## Chapter 1 — Learning First

Every client begins in Learning Mode.

Centro does not require a perfect setup before work begins. Onboarding exists to
provide enough information to start working safely, not to perfectly configure every
client.

Excel imports, onboarding choices, and existing records create only an Initial Client
Profile. From the very first collection cycle, Centro observes reality, learns from
recurring behaviour, and continuously improves the profile.

Centro does not guess. It observes, suggests, confirms, and only then learns.

**Core principles:**
- Start working immediately.
- Learn continuously.
- Never guess when confidence is low.
- Improve from real behaviour, not assumptions.

---

## Chapter 2 — The First Collection Cycle

Every client enters the first month in Learning Mode.

Centro requests the client's documents, waits until the client confirms that the
submission is complete, and then treats the collection as one business event to learn
from.

The first cycle is not a validation phase. It is a learning phase designed to
understand how the client actually works — specifically, which documents that client
actually sends, nothing broader.

---

## Chapter 3 — Observe → Suggest → Confirm → Learn

Every meaningful change to a client's document collection profile follows the same
lifecycle:

1. **Observe.**
2. **Suggest.**
3. **Confirm** with the client whenever appropriate, through WhatsApp.
4. **Learn.**

Centro never changes a client's profile because of a single event or assumption. A
pattern must repeat before Centro treats it as worth asking about, and even then, only
the client's explicit confirmation — never the pattern alone — changes the profile.

---

## Chapter 4 — Learning Without Becoming a Burden

Learning must never create unnecessary work.

Centro should quietly observe whenever possible. It asks questions only if the answer
has long-term value and the benefit outweighs the interruption.

Questions must be short, natural, and asked only once — if a client has already
declined a suggestion, Centro does not ask about the same thing again.

The accountant reviews exceptions — not routine learning.

**Core principle:** Centro becomes smarter while becoming quieter.

---

## Chapter 5 — The Living Client Profile

Client profiles are living profiles.

Knowledge comes from Excel, onboarding, collected documents, recurring patterns, and
confirmed client responses.

No single source is absolute truth.

Businesses evolve, so the client's document collection profile evolves with them — see
Chapter 8 for the exact, permanent boundary of what "evolves" is allowed to mean.

---

## Chapter 6 — Decision Hierarchy

Every decision follows the same hierarchy, most specific and most certain signal
first:

1. **Learned Knowledge** — a specific fact this organization has already confirmed
   about its own clients or data. Checked first because it is the most reliable signal
   available: it was explicitly confirmed, not inferred, and it is scoped to exactly
   this organization.
2. **Business Rules** — deterministic, universal rules that apply the same way across
   every organization (e.g. recognizing standard terminology, hard confidence floors,
   required-confirmation gates). Used whenever no more specific learned fact exists for
   this organization yet.
3. **Artificial Intelligence** — a supporting tool, reached only once the above two
   layers find nothing with sufficient confidence. AI is never the foundation of a
   decision in Centro.
4. **Human Review** — whenever confidence remains insufficient after all three layers
   above, a person decides. Centro never guesses.

A previously confirmed, organization-specific fact always outranks a generic rule. This
is a deliberate refinement of "business rules first": a rule that is merely generic is
less trustworthy than a fact Centro was explicitly told and is now honoring. Business
Rules remain the universal floor beneath Learned Knowledge — every organization gets at
least this level of correctness even before it has taught Centro anything of its own —
but never above a fact that organization has already confirmed.

---

## Chapter 7 — Invisible Automation

The best automation is the one users barely notice.

Routine work happens automatically.

Learning happens continuously.

Notifications are meaningful.

Every interruption must have value.

Success is measured by how much work Centro completes without demanding attention.

---

## Chapter 8 — The Boundary of Learning

Centro learns exactly one thing: **which documents should be requested from each
client.**

This is refined only through observed recurrence and explicit client confirmation,
following the Chapter 3 lifecycle exactly — never inferred, never assumed, and never
applied from a single occurrence.

Centro does not learn, infer, or adapt:
- The client's underlying business, workflow, or operations.
- The accounting firm's own office policies — including business hours, working days,
  reminder cadence, or the day a collection period begins.

These remain office policy: configured explicitly by the accountant, once, and changed
only by the accountant. Centro never modifies them automatically, regardless of what it
observes.

This boundary is permanent. It applies to every learning mechanism in Centro — present
and future — not only document collection. A future milestone that would cause Centro
to learn or adapt timing, scheduling, or any office policy is out of scope by
definition, not a case-by-case judgment call.

---

## Document History

| Date | Change |
|---|---|
| Pilot Edition | Original 7 chapters established as the architectural source of truth. |
| Milestone 1 | Migrated to a version-controlled Markdown source in-repo. Chapter 6 revised to state the Decision Hierarchy as actually implemented (Learned Knowledge checked before generic Business Rules) — see the Centro Implementation Report's Milestone 1 addendum for the full rationale. Added Chapter 8 (The Boundary of Learning) as a permanent constraint, in response to an early roadmap draft that would have violated it. |
| Milestone 2 | Chapter 1/2's "every client begins in Learning Mode" implemented as a real, visible flag (`clients.learningMode`), ending the first time a client's first Collection Request reaches `completed`. No timing or duration data is captured — see Chapter 8; this milestone exists solely to gate Milestone 6's "document appears to no longer be needed" detection, which must never fire before a client has completed even one full cycle. |
| Milestone 3 | Chapter 6's Decision Hierarchy generalized to document classification, its second real implementation (after Epic 4's business-type classifier). A client's own manually-corrected document-naming history (`document_learned_patterns`, scoped per client) is now checked before the generic deterministic heuristic, which now sits ahead of a documented AI-fallback stub — full parity with the 4-layer pattern. |
| Milestone 4 | Chapter 4/7's "the accountant reviews exceptions, not routine learning" given a real, unified surface: the dashboard's existing per-feature queue pattern extended with a "suggested classification" view (clients auto-classified in the 70-94% band), sitting alongside the pre-existing document-review queue rather than a separate, undiscoverable screen. |
| Milestone 5 | Chapter 3's "Confirm with the client, through WhatsApp" — the one lifecycle step that didn't exist anywhere yet — built as reusable, domain-agnostic infrastructure (`pending_confirmations`), with a real (not throwaway) manual trigger: an employee can ask a client to confirm a document becomes a standing part of their collection at the exact moment of manual assignment. A real bug was found and fixed during this milestone's own verification — see the Implementation Report's Milestone 5 addendum. |
| Milestone 6 | Chapter 8's one permitted kind of learning, made real end to end: `client_document_requirements` tracks per-client additions and removals, confirmed only through Milestone 5's WhatsApp loop, applied only to that one client's future snapshots — the service template itself is never touched. Additions require a genuine second occurrence (never a single event); removals require two consecutive completed cycles missing the same document. A structural constraint (a cycle can never complete while a requirement is unsatisfied) required a new, independently useful capability — waiving a requirement for one cycle — to make recurring-absence detection possible at all; documented in the Implementation Report's Milestone 6 addendum along with a second bug (ambiguous reply resolution when two confirmations are open at once) found and fixed during verification. |
| Milestone 7 | Pilot Hardening — no new product behaviour; a dedicated pass over everything M1–M6 built, with an emphasis on the organization-isolation boundary this document has assumed throughout but never itself audited end to end. Two real cross-tenant authorization gaps were found and fixed (a pending-confirmation resolution action, and a document-requirement-assignment action, both trusting a caller-supplied id without confirming it belonged to the caller's own organization) — see the Implementation Report's Milestone 7 addendum for the full detail, including a two-tenant Playwright test added specifically to keep this boundary verified going forward, not just asserted in prose. The Milestone 3-deferred `isFuzzyDuplicate` doc-comment discrepancy was also resolved (the comment's own example didn't clear its own threshold — corrected to a real, passing example; the function's deliberately strict behavior was left unchanged). |
| Product Evolution M1 | The start of a separate roadmap generalizing Centro from an accounting-only platform into a document-collection platform for any business (see the Product Evolution milestone roadmap). This milestone captures two new, purely onboarding-time facts and changes no existing behaviour: which kind of business the office itself is (`organizations.businessCategory` — distinct from `business_types`/`clients.businessTypeId`, which classify this office's *clients* and remain exactly as Chapters 6 and 8 describe), and which of two permanent workflows it operates in (`organizations.workflowType`: `recurring`, today's exact learning-driven experience, or `one_time`, a template-driven experience with deliberately no learning at all, built out in later milestones). Every existing organization defaults to `accountant`/`recurring`, so nothing in Chapters 1–8 changes for any organization that existed before this milestone. The one-time workflow's own governing chapter will be added once it's real (the Product Evolution roadmap's final hardening milestone). |
| Product Evolution M2 | Generalizes Workflow A's onboarding *starting point* — never the recurring learning engine itself — per the office's declared business category. For `accountant`/`tax_advisor`, the starter client-types and suggested documents are byte-identical to before this milestone. For every other declared category, a new mocked-AI module (`src/lib/ai/businessCategorySuggestions.ts`, same documented "real interface, no live provider configured" pattern as every other AI module in this codebase) supplies curated, category-specific starter types — and, for a genuinely novel free-text "Other" category, a broad keyword-matching layer covering ~20 common business domains before falling back to a starting point named after the office's own words, never a generic or empty placeholder. Once seeded, a business type behaves identically regardless of which tier produced it: Chapter 3's Observe → Suggest → Confirm → Learn lifecycle, Chapter 6's Decision Hierarchy, and the entire recurring learning engine apply exactly as before — this milestone only ever changes what a client-type's document checklist starts as, never how Centro learns from that point on. |
