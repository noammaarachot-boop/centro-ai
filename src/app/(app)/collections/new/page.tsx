import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import {
  getService,
  listServiceClients,
  listServiceRequirements,
  listUnassignedClientsForService,
} from "@/lib/data/services";
import { listClients } from "@/lib/data/clients";
import { suggestTemplateLibrary } from "@/lib/ai/businessCategorySuggestions";
import { checkIntegrationStatus } from "@/lib/integrationRequirements";
import { hasSentAnyOnDemandRequest, resolveOnDemandDraft } from "@/lib/data/collectionRequestDrafts";
import { CollectionRequestWizard, type WizardStep } from "./CollectionRequestWizard";

const VALID_STEPS: WizardStep[] = ["what", "who", "when", "connect", "review", "success"];

// The Collection Requests wizard — the on-demand journey's actual
// workspace (see docs/design/first-send-final-source-of-truth.html §C).
// One route, driven entirely by `?draft=` (which definition — a bare
// `services` row with collectionMode "on_demand", same row a Template
// always was) and `?step=`. No draft yet means "What will be sent?"; every
// later step needs the draft's real data, refetched on every step change
// since this is a Server Component page navigated via plain links/GETs,
// never client-only state — so a step can never render stale data after an
// action mutates the draft.
export default async function NewCollectionRequestPage({
  searchParams,
}: {
  searchParams: Promise<{
    draft?: string;
    step?: string;
    sendMode?: string;
    scheduledFor?: string;
    sent?: string;
    scheduled?: string;
    error?: string;
  }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  const isFirstRequest = !(await hasSentAnyOnDemandRequest(session.organizationId));

  let draftId = params.draft ?? null;
  // Deliberately NOT auto-resolved for every plain "/collections/new" hit
  // — investigated during the repeat-use rework's production-readiness
  // audit and reverted. resolveOnDemandDraft can't distinguish a
  // genuinely abandoned wizard draft from a deliberately-built, not-yet-
  // sent Template (duplicateTemplate, reachable from /collections/manage,
  // creates exactly that shape: on_demand, zero collection_requests, no
  // wizard involved at all) — auto-resuming here risked silently steering
  // a brand-new request into editing someone else's unrelated template.
  // Kept scoped to its one original, unambiguous case: the Google OAuth
  // callback lands on a fixed, allowlisted path with no draft id (see
  // /api/auth/google/start's RETURN_TO_ALLOWLIST comment) — re-resolving
  // here only re-attaches to the SAME draft the user was already actively
  // connecting integrations for, seconds earlier in the same session, not
  // a blind guess off stale DB state.
  if (!draftId && params.step === "connect") {
    draftId = await resolveOnDemandDraft(session.organizationId);
  }

  if (!draftId) {
    const library = await suggestTemplateLibrary(
      organization.businessCategory,
      organization.businessCategoryCustomLabel
    );
    return (
      <CollectionRequestWizard
        step="what"
        isFirstRequest={isFirstRequest}
        suggestedRequirementNames={library[0]?.suggestedRequirements.map((r) => r.name) ?? []}
      />
    );
  }

  const definition = await getService(session.organizationId, draftId);
  if (!definition || definition.collectionMode !== "on_demand") {
    redirect("/collections/new");
  }

  const [requirements, assignedClients, unassignedClients, allClients, integrationStatus] = await Promise.all([
    listServiceRequirements(draftId),
    listServiceClients(session.organizationId, draftId),
    listUnassignedClientsForService(session.organizationId, draftId),
    listClients(session.organizationId),
    checkIntegrationStatus(session.organizationId),
  ]);

  const integrationReady = integrationStatus.whatsappReady && integrationStatus.driveReady;

  const requestedStep = params.step && VALID_STEPS.includes(params.step as WizardStep) ? (params.step as WizardStep) : undefined;

  // Point 5 of the repeat-use rework: connections are onboarding/setup, not
  // a step that repeats on every request. Enforced here, server-side, off
  // the same live-verified integrationReady the Review step's own send
  // guard checks (sendTemplateRequest) — never a client-side flag alone —
  // so a stale link or a WhenStep click that still points at ?step=connect
  // (e.g. cached in a bookmark from before both were connected) skips
  // straight to Review instead of showing an unnecessary connect screen.
  if (requestedStep === "connect" && integrationReady) {
    const qs = new URLSearchParams({ draft: draftId, step: "review" });
    if (params.sendMode) qs.set("sendMode", params.sendMode);
    if (params.scheduledFor) qs.set("scheduledFor", params.scheduledFor);
    redirect(`/collections/new?${qs.toString()}`);
  }

  const step: WizardStep = requestedStep ?? (assignedClients.length === 0 ? "who" : "when");

  return (
    <CollectionRequestWizard
      step={step}
      draftId={draftId}
      isFirstRequest={isFirstRequest}
      definitionName={definition.name}
      requirements={requirements}
      assignedClients={assignedClients}
      unassignedClients={unassignedClients}
      totalOrgClients={allClients.length}
      integrationReady={integrationReady}
      googleConnectedAt={organization.googleConnectedAt}
      googleDriveFolderId={organization.googleDriveFolderId}
      googleDriveFolderName={organization.googleDriveFolderName}
      whatsappConnectedAt={organization.whatsappConnectedAt}
      whatsappDisplayPhoneNumber={organization.whatsappDisplayPhoneNumber}
      sendMode={params.sendMode}
      scheduledFor={params.scheduledFor}
      sentCount={params.sent ? Number(params.sent) : undefined}
      scheduledCount={params.scheduled ? Number(params.scheduled) : undefined}
      error={params.error}
    />
  );
}
