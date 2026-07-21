"use client";

import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Loader2, Send } from "lucide-react";

export const SUBMITTED_STORAGE_KEY = "centro-demo-submitted";

type FieldErrors = {
  name?: string;
  phone?: string;
  email?: string;
};

type Status = "idle" | "submitting" | "success" | "error";

const PHONE_PATTERN = /^[\d\s\-+()]{7,16}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_ERROR = "משהו השתבש בשליחה. נסו שוב בעוד רגע.";

function markSubmitted() {
  try {
    window.localStorage.setItem(SUBMITTED_STORAGE_KEY, "true");
  } catch {
    // localStorage unavailable — non-critical, ignore.
  }
}

/**
 * Reused by both ContactSection (inline, end of page) and
 * DemoRequestModal (timed popup) — idPrefix keeps field ids unique
 * when both instances happen to be mounted at once.
 */
export default function ContactForm({
  idPrefix,
  onSuccess,
  ctaLabel = "בקשו הדגמה",
  source = "טופס יצירת קשר",
}: {
  idPrefix: string;
  onSuccess?: () => void;
  ctaLabel?: string;
  /** Where this instance of the form lives — included in the email so a
   * submission from the inline section and the popup modal can be told
   * apart. */
  source?: string;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [message, setMessage] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // When this instance first rendered — sent back to the server so it can
  // reject submissions that arrive implausibly fast (a bot filling every
  // field programmatically), invisible to a real visitor. useState's lazy
  // initializer (not useRef) is the correct way to compute this once —
  // calling Date.now() directly during render is impure.
  const [renderedAt] = useState(() => Date.now());

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!name.trim()) {
      next.name = "נא להזין שם מלא";
    }
    if (!phone.trim()) {
      next.phone = "נא להזין מספר טלפון";
    } else if (!PHONE_PATTERN.test(phone.trim())) {
      next.phone = "נא להזין מספר טלפון תקין";
    }
    if (email.trim() && !EMAIL_PATTERN.test(email.trim())) {
      next.email = "נא להזין כתובת אימייל תקינה";
    }
    return next;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;

    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setStatus("submitting");
    setSubmitError(null);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          email: email || undefined,
          businessName: businessName || undefined,
          message: message || undefined,
          source,
          honeypot,
          renderedAt,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setSubmitError(data?.error || GENERIC_ERROR);
        setStatus("error");
        return;
      }

      markSubmitted();
      setStatus("success");
      onSuccess?.();
    } catch {
      setSubmitError(GENERIC_ERROR);
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        role="status"
        className="flex flex-col items-center gap-3 rounded-2xl border border-brand-emerald/30 bg-brand-emerald/5 px-6 py-8 text-center"
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-emerald/15 text-brand-emerald">
          <CheckCircle2 className="h-6 w-6" />
        </span>
        <p className="text-base font-semibold text-text-primary">
          תודה! קיבלנו את הפרטים שלכם וניצור קשר בהקדם.
        </p>
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* Honeypot — invisible to a real visitor, often auto-filled by
          simple bots. sr-only is applied to the input itself (not just a
          wrapper) so its own layout box is genuinely zero-size, not only
          clipped by an ancestor. Never rendered as a normal field, never
          required, checked server-side only. */}
      <div aria-hidden="true">
        <label htmlFor={`${idPrefix}-website`} className="sr-only">
          אתר החברה
        </label>
        <input
          id={`${idPrefix}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          className="sr-only"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <div>
        <label
          htmlFor={`${idPrefix}-name`}
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          שם מלא <span aria-hidden="true">*</span>
        </label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-required="true"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? `${idPrefix}-name-error` : undefined}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="לדוגמה: דנה כהן"
        />
        {errors.name && (
          <p
            id={`${idPrefix}-name-error`}
            role="alert"
            className="mt-1.5 text-xs font-medium text-danger"
          >
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={`${idPrefix}-phone`}
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          מספר טלפון <span aria-hidden="true">*</span>
        </label>
        <input
          id={`${idPrefix}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-required="true"
          aria-invalid={!!errors.phone}
          aria-describedby={errors.phone ? `${idPrefix}-phone-error` : undefined}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="050-1234567"
        />
        {errors.phone && (
          <p
            id={`${idPrefix}-phone-error`}
            role="alert"
            className="mt-1.5 text-xs font-medium text-danger"
          >
            {errors.phone}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={`${idPrefix}-email`}
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          אימייל <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <input
          id={`${idPrefix}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? `${idPrefix}-email-error` : undefined}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="name@example.com"
        />
        {errors.email && (
          <p
            id={`${idPrefix}-email-error`}
            role="alert"
            className="mt-1.5 text-xs font-medium text-danger"
          >
            {errors.email}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={`${idPrefix}-business-name`}
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          שם העסק <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <input
          id={`${idPrefix}-business-name`}
          name="businessName"
          type="text"
          autoComplete="organization"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="לדוגמה: משרד רואי חשבון כהן ושות׳"
        />
      </div>

      <div>
        <label
          htmlFor={`${idPrefix}-message`}
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          הודעה <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <textarea
          id={`${idPrefix}-message`}
          name="message"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full resize-none rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="ספרו לנו קצת על מה שאתם מחפשים"
        />
      </div>

      {status === "error" && submitError && (
        <p role="alert" className="text-center text-xs font-medium text-danger">
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-3.5 text-base font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:opacity-70"
      >
        {status === "submitting" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            שולח...
          </>
        ) : (
          <>
            {ctaLabel}
            <Send className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}
