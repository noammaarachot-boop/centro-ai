"use client";

import { useActionState } from "react";
import { usePathname } from "next/navigation";
import { CheckCircle2, Send } from "lucide-react";
import { Button } from "@/components/app/Button";
import { SelectField, TextAreaField, TextField } from "@/components/app/FormField";
import { submitSupportRequest, type SupportRequestState } from "@/app/(app)/support/actions";

const initialState: SupportRequestState = {};

const CATEGORY_OPTIONS = [
  { value: "not_working", label: "משהו לא עובד" },
  { value: "google_drive", label: "בעיה בחיבור Google Drive" },
  { value: "whatsapp", label: "בעיה ב-WhatsApp" },
  { value: "question", label: "שאלה על המערכת" },
  { value: "feature_request", label: "בקשה / הצעה" },
  { value: "other", label: "אחר" },
];

// One-shot create form (not a persistent settings form like
// BusinessHoursForm) — inputs stay uncontrolled with `defaultValue` so a
// failed submission never loses what the user typed (React never resets
// an uncontrolled input's DOM value on re-render), and a real page
// refresh naturally starts a fresh, empty useActionState — nothing here
// re-submits on mount, so a refresh after success can never re-send the
// same request.
export function SupportRequestForm() {
  const [state, formAction, isPending] = useActionState(submitSupportRequest, initialState);
  const pathname = usePathname();

  if (state.success) {
    return (
      <div className="animate-fade-in-up space-y-2 rounded-xl border border-brand-emerald/30 bg-brand-emerald/5 px-5 py-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-brand-emerald">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          הפנייה נשלחה בהצלחה
        </p>
        <p className="text-sm text-text-secondary">קיבלנו את הפנייה ונחזור אליכם בהקדם.</p>
        <p className="text-sm font-medium text-text-primary">מספר פנייה: #{state.success.ticketNumber}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="currentPage" value={pathname} />
      <input
        type="hidden"
        name="timezone"
        value={typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : ""}
      />

      <SelectField id="category" name="category" label="סוג הפנייה" required defaultValue="">
        <option value="" disabled>
          — בחירה —
        </option>
        {CATEGORY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>

      <TextField id="subject" name="subject" label="נושא" type="text" required maxLength={200} />

      <TextAreaField
        id="message"
        name="message"
        label="תיאור"
        placeholder="ספרו לנו מה קרה וננסה לעזור."
        required
        rows={5}
        maxLength={4000}
      />

      {state.error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        <Send className="h-4 w-4" />
        {isPending ? "שולח…" : "שליחת הפנייה"}
      </Button>
    </form>
  );
}
