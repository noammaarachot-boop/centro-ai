import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert, LogOut } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { logout } from "@/app/(app)/actions";
import { AuthCard } from "@/components/app/AuthCard";
import { Button } from "@/components/app/Button";
import { WHATSAPP_NUMBER } from "@/components/landing/FloatingWhatsAppButton";

export const metadata: Metadata = { title: "הארגון מושהה — Centro" };

const SUPPORT_MESSAGE = "היי, הארגון שלי מושהה ואני צריך/ה עזרה.";
const SUPPORT_HREF = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;

// Reads getSession() directly, never requireSession() — that guard is
// exactly what redirects a suspended organization's session here, so
// calling it again on this page would loop. Reachable only by a session
// whose organization is actually suspended, or not signed in at all; an
// active organization has no reason to land here and is sent to /login.
export default async function SuspendedPage() {
  const session = await getSession();
  if (!session || !session.organizationSuspendedAt) {
    redirect("/login");
  }

  return (
    <AuthCard>
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="centro-icon-danger grid h-14 w-14 place-items-center rounded-2xl">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-lg font-bold text-text-primary">הארגון שלכם הושהה</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            הגישה למערכת עבור {session.organizationName} הושהתה זמנית על ידי מפעילי הפלטפורמה. לבירור
            הסיבה או להסרת ההשעיה, צרו קשר עם התמיכה.
          </p>
        </div>
        <a href={SUPPORT_HREF} target="_blank" rel="noopener noreferrer" className="w-full">
          <Button variant="primary" className="w-full">
            פנייה לתמיכה בוואטסאפ
          </Button>
        </a>
        <form action={logout} className="w-full">
          <Button type="submit" variant="secondary" className="w-full">
            התנתקות
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </Button>
        </form>
      </div>
    </AuthCard>
  );
}
