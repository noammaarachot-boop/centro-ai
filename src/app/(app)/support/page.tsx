import { Mail, MessageCircle } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { SupportRequestForm } from "@/components/app/SupportRequestForm";
import { WHATSAPP_NUMBER } from "@/components/landing/FloatingWhatsAppButton";

const SUPPORT_WHATSAPP_MESSAGE = "היי! אני צריך/ה עזרה עם Centro.";
const SUPPORT_WHATSAPP_HREF = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(SUPPORT_WHATSAPP_MESSAGE)}`;

// Same existing inbox the marketing contact form and password-reset email
// already send through (src/app/api/contact/route.ts, src/lib/email/
// passwordReset.ts) — there is no separate "support@" address configured
// anywhere in this codebase, so this reuses it rather than inventing one.
const SUPPORT_EMAIL = process.env.CONTACT_EMAIL_TO || "Centro.ai.team@gmail.com";

export default async function SupportPage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up space-y-6 px-4 py-10 sm:px-6 lg:px-10">
      <PageHeader title="תמיכה" description="נתקלתם בבעיה או צריכים עזרה? אנחנו כאן בשבילכם." />

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">שליחת פנייה לתמיכה</h2>
        <SupportRequestForm />
      </Card>

      <div>
        <p className="mb-2 px-1 text-xs font-medium text-text-muted">דרכים נוספות ליצור איתנו קשר</p>
        <Card padding="sm" className="space-y-1">
          <a
            href={SUPPORT_WHATSAPP_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <MessageCircle className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            דברו איתנו ב-WhatsApp
          </a>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <Mail className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            שלחו לנו אימייל
          </a>
        </Card>
      </div>
    </div>
  );
}
