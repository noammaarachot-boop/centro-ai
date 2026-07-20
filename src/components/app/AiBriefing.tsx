import { Sparkles } from "lucide-react";

// A small, rule-based headline computed from data the dashboard already
// queries (see buildBriefing() in each dashboard's page component) — no
// live AI/LLM call. Manifesto Part 9: "know the business in 5 seconds."
export function AiBriefing({ text }: { text: string }) {
  return (
    <div className="mb-8 flex animate-fade-in-up items-start gap-3 rounded-2xl border border-brand-purple/20 bg-gradient-to-l from-brand-purple/5 to-brand-blue/5 px-5 py-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-l from-brand-purple to-brand-blue text-white shadow-glow-purple">
        <Sparkles className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-xs font-semibold text-brand-purple">תדרוך Centro</p>
        <p className="mt-0.5 text-sm leading-relaxed text-text-primary">{text}</p>
      </div>
    </div>
  );
}
