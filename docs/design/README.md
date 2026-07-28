# First-Send Journey — Design Reference

`first-send-final-source-of-truth.html` is the frozen, approved design for the
Advertisement → Landing → Registration → Business Type → Dashboard →
Collection Requests → Send → Success journey. Open it directly in a browser
to view all screens, tokens, and states.

This is the only design reference for that journey. It replaces all earlier
design drafts, which were not checked into the repo and are no longer
referenced anywhere.

Locked product decisions (do not relitigate without a real reason):
- "Collection Request" is the only new user-facing noun. "Templates",
  "Customer Classification", "Workflow", "One-Time", and "Recurring" must
  never appear in user-facing copy.
- The Dashboard stays a control center; it never becomes the creation wizard.
  A dedicated Collection Requests page is the actual workspace.
- WhatsApp and Google Drive are connected together, in-context, immediately
  before the first send — a reliability decision, not a UX preference.
- Dashboard progress persists — the prompt card resumes at the exact step
  a user left off.
