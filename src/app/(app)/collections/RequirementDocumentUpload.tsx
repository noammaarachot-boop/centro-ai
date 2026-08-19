"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { addManualDocument } from "./actions";

// Collections UX simplification — replaces the old always-visible form
// (a typed "שם קובץ" field the employee had to fill in, plus an upfront
// approved/needs_review/rejected picker) with a single collapsed action
// that expands to just a file picker. addManualDocument itself already
// falls back to the attached file's own name when no fileName is
// submitted, and to "needs_review" when no status is submitted — this
// component simply stops sending those two fields at all, so every
// manually-added document goes through the exact same employee review
// (the existing approve/reject buttons on its row) that an automatically-
// received document already does, rather than being silently marked
// approved sight-unseen.
export function RequirementDocumentUpload({
  collectionRequestId,
  requirementId,
  hasExistingDocuments,
  acceptExtensions,
}: {
  collectionRequestId: string;
  requirementId: string;
  hasExistingDocuments: boolean;
  acceptExtensions: string;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const boundAction = addManualDocument.bind(null, collectionRequestId, requirementId);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        <Upload className="h-3.5 w-3.5" />
        {hasExistingDocuments ? "העלאת מסמך נוסף" : "העלאת מסמך"}
      </button>
    );
  }

  return (
    <form action={boundAction} onSubmit={() => setIsSubmitting(true)} className="flex flex-wrap items-center gap-2">
      <input
        name="file"
        type="file"
        required
        accept={acceptExtensions}
        className="max-w-[220px] text-xs text-text-secondary file:me-2 file:rounded-full file:border file:border-border file:bg-white file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-text-secondary"
      />
      <button
        type="submit"
        disabled={isSubmitting}
        className={buttonVariants({ variant: "primary", size: "sm" })}
      >
        {isSubmitting ? "מעלה…" : "העלאה"}
      </button>
      {!isSubmitting && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-text-muted transition-colors hover:text-text-primary"
        >
          סגירה
        </button>
      )}
    </form>
  );
}
