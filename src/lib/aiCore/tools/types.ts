// Built fresh per request from requireSession() — never a module-level
// singleton, so one organization's tools can never leak into another's.
// Mirrors getOrgScopedCollectionRequest's discipline throughout
// src/app/(app)/collections/actions.ts: organizationId always comes from
// the session, never trusted from anywhere the model itself could
// influence.
export interface ToolContext {
  organizationId: string;
  actingUserId: string;
}
