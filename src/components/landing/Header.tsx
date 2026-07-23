"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { CentroMark } from "./icons/CentroMark";

const NAV_LINKS = [
  { href: "#how-it-works", label: "איך זה עובד" },
  { href: "#capabilities", label: "יכולות" },
  { href: "#demo", label: "הדגמה" },
  { href: "#faq", label: "שאלות נפוצות" },
];

function scrollToDemo(event: React.MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      <div
        className={`flex w-full max-w-5xl items-center justify-between rounded-2xl px-4 py-2.5 transition-all duration-300 ${
          scrolled
            ? "border border-border bg-white/80 shadow-card backdrop-blur-lg"
            : "border border-transparent bg-transparent"
        }`}
      >
        <a href="#top" className="flex items-center gap-2 rounded-lg" aria-label="Centro, לעמוד הבית">
          <CentroMark
            className="h-8 w-8 drop-shadow-[0_2px_10px_rgba(124,58,237,0.35)]"
            title="Centro"
          />
          <span className="text-lg font-bold tracking-tight" dir="ltr">
            Centro
          </span>
        </a>

        <nav
          className="hidden items-center gap-1 md:flex"
          aria-label="ניווט ראשי"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href="#demo"
            className="rounded-full px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            צפו איך זה עובד
          </a>
          <a
            href="/login"
            className="rounded-full px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            התחבר
          </a>
          <a
            href="#final-cta"
            className="rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-5 py-2.5 text-sm font-semibold text-white shadow-card transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            בקשו הדגמה
          </a>
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="grid h-11 w-11 place-items-center rounded-xl border border-border text-text-primary md:hidden"
          aria-label={mobileOpen ? "סגירת התפריט" : "פתיחת התפריט"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-x-4 top-[4.5rem] rounded-2xl border border-border bg-white p-4 shadow-card-lg md:hidden"
        >
          <nav
            className="flex flex-col gap-2"
            aria-label="ניווט לנייד"
          >
            <a
              href="#faq"
              onClick={() => setMobileOpen(false)}
              className="rounded-full border border-border px-4 py-3 text-center text-sm font-medium text-text-primary"
            >
              שאלות נפוצות
            </a>
            <a
              href="#demo"
              onClick={() => setMobileOpen(false)}
              className="rounded-full border border-border px-4 py-3 text-center text-sm font-medium text-text-primary"
            >
              צפו איך זה עובד
            </a>
            <a
              href="#demo"
              onClick={(e) => {
                scrollToDemo(e);
                setMobileOpen(false);
              }}
              className="rounded-full border border-border px-4 py-3 text-center text-sm font-medium text-text-primary"
            >
              צור קשר
            </a>
            <a
              href="/login"
              onClick={() => setMobileOpen(false)}
              className="rounded-full border border-border px-4 py-2.5 text-center text-sm font-medium text-text-secondary"
            >
              התחבר
            </a>
          </nav>
          <div className="mt-3 border-t border-border pt-3">
            <a
              href="#demo"
              onClick={(e) => {
                scrollToDemo(e);
                setMobileOpen(false);
              }}
              className="block rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-4 py-3 text-center text-sm font-semibold text-white shadow-card"
            >
              בקשו הדגמה
            </a>
          </div>
        </motion.div>
      )}
    </motion.header>
  );
}
