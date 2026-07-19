"use client";

import { useActionState, useRef, useState } from "react";
import { ImagePlus, Save } from "lucide-react";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";
import { updateOfficeInfo, type OfficeInfoState } from "@/app/onboarding/actions";

const MAX_DIMENSION = 256;
const JPEG_QUALITY = 0.82;

const initialState: OfficeInfoState = {};

function resizeToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("failed to load image"));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Shared by the onboarding wizard's Office Information step and Settings —
// office name/logo must "remain editable later from Settings" per Epic 3,
// so both surfaces submit through the same updateOfficeInfo action; only
// `returnTo` and the submit label differ.
export function OfficeInfoForm({
  name,
  logoUrl,
  returnTo,
  submitLabel = "המשך",
}: {
  name: string;
  logoUrl: string | null;
  returnTo?: string;
  submitLabel?: string;
}) {
  const [state, formAction, isPending] = useActionState(updateOfficeInfo, initialState);
  const [preview, setPreview] = useState<string | null>(logoUrl);
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setLogoError("נא לבחור קובץ תמונה.");
      return;
    }
    try {
      const dataUrl = await resizeToDataUrl(file);
      setPreview(dataUrl);
      setLogoDataUrl(dataUrl);
      setLogoError(null);
    } catch {
      setLogoError("לא ניתן היה לעבד את התמונה.");
    }
  }

  return (
    <form action={formAction} className="space-y-5">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="group relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-dashed border-border bg-surface-muted transition-colors hover:border-brand-purple/40"
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-6 w-6 text-text-muted transition-colors group-hover:text-brand-purple" />
          )}
        </button>
        <div>
          <p className="text-sm font-medium text-text-primary">לוגו המשרד</p>
          <p className="text-xs text-text-muted">אופציונלי — ניתן להוסיף גם מאוחר יותר.</p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-1 text-xs font-medium text-brand-purple hover:underline"
          >
            {preview ? "החלפת תמונה" : "העלאת תמונה"}
          </button>
          {logoError && <p className="mt-1 text-xs font-medium text-danger">{logoError}</p>}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <input type="hidden" name="logoDataUrl" value={logoDataUrl} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      </div>

      <TextField
        id="name"
        name="name"
        label="שם המשרד"
        type="text"
        required
        defaultValue={name}
        placeholder="לדוגמה: משרד רואי חשבון כהן ושות׳"
        error={state.fieldErrors?.name}
      />

      <Button type="submit" variant="primary" loading={isPending} className="w-full">
        <Save className="h-4 w-4" />
        {submitLabel}
      </Button>
    </form>
  );
}
