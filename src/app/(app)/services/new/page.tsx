import { requireSession } from "@/lib/auth/session";
import { createService } from "../actions";
import { ServiceForm } from "../ServiceForm";

export default async function NewServicePage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">
        שירות חדש
      </h1>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <ServiceForm action={createService} submitLabel="שמירת שירות" />
      </div>
    </div>
  );
}
