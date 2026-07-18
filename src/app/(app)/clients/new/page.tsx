import { requireSession } from "@/lib/auth/session";
import { createClient } from "../actions";
import { ClientForm } from "../ClientForm";

export default async function NewClientPage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">
        לקוח חדש
      </h1>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <ClientForm action={createClient} submitLabel="שמירת לקוח" />
      </div>
    </div>
  );
}
