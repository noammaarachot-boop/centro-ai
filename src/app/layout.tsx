import type { Metadata } from "next";
import { Rubik } from "next/font/google";
import MotionProvider from "@/components/landing/MotionProvider";
import { AccessibilityProvider } from "@/components/landing/AccessibilityProvider";
import AccessibilityWidget from "@/components/landing/AccessibilityWidget";
import "./globals.css";

const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Centro — העובד הדיגיטלי שאוסף לכם מסמכים",
  description:
    "Centro הוא העובד הדיגיטלי של העסק שלכם: פונה ללקוחות, אוסף מסמכים, מנתח אותם עם AI ומסדר הכול לבד — בוואטסאפ ובגוגל דרייב.",
  metadataBase: new URL("https://centro.example.com"),
  openGraph: {
    title: "Centro — העובד הדיגיטלי שאוסף לכם מסמכים",
    description:
      "פונה ללקוחות, אוסף מסמכים, מנתח אותם עם AI ומסדר הכול לבד.",
    locale: "he_IL",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" className={`${rubik.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-background text-text-primary antialiased">
        <AccessibilityProvider>
          <MotionProvider>
            {children}
            <AccessibilityWidget />
          </MotionProvider>
        </AccessibilityProvider>
      </body>
    </html>
  );
}
