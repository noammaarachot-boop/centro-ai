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
