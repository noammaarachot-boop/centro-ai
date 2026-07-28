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
import { resolveOnDemandDraft } from "@/lib/data/collectionRequestDrafts";
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

  let draftId = params.draft ?? null;
  // Google OAuth's callback lands on a fixed, allowlisted path with no
  // draft id (see /api/auth/google/start's RETURN_TO_ALLOWLIST comment) —
  // re-resolve the org's one in-progress draft so Connect renders normally
  // right after the redirect back from Google.
  if (!draftId && params.step === "connect") {
    draftId = await resolveOnDemandDraft(session.organizationId);
  }

  if (!draftId) {
    const library = await suggestTemplateLibrary(
      organization.businessCategory,
      organization.businessCategoryCustomLabel
    );
    return (
      <CollectionRequestWizard step="what" suggestedRequirementNames={library[0]?.suggestedRequirements.map((r) => r.name) ?? []} />
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

  const requestedStep = params.step && VALID_STEPS.includes(params.step as WizardStep) ? (params.step as WizardStep) : undefined;
  const step: WizardStep = requestedStep ?? (assignedClients.length === 0 ? "who" : "when");

  return (
    <CollectionRequestWizard
      step={step}
      draftId={draftId}
      definitionName={definition.name}
      requirements={requirements}
      assignedClients={assignedClients}
      unassignedClients={unassignedClients}
      totalOrgClients={allClients.length}
      integrationReady={integrationStatus.whatsappReady && integrationStatus.driveReady}
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
