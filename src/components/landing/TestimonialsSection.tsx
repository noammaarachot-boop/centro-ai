"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";

/**
 * Illustrative testimonials — written to be short, modest and believable
 * so the carousel can be reviewed/built against realistic-looking data.
 * These are NOT real customers. Swap every entry for a verified, real
 * customer quote (with their consent) before this section ever ships
 * to real visitors.
 */
type Testimonial = {
  quote: string;
  name: string;
  role: string;
};

const TESTIMONIALS: Testimonial[] = [
  {
    quote: "כבר לא רודפים אחרי לקוחות בוואטסאפ. המסמכים פשוט מגיעים מסודרים.",
    name: "דניאל",
    role: "בעל משרד הנהלת חשבונות",
  },
  {
    quote: "התהליך ברור הרבה יותר. אני יודע בדיוק מה חסר בלי לבדוק ידנית.",
    name: "עידן",
    role: "מנהל קליניקת שיניים",
  },
  {
    quote: "התזכורות האוטומטיות הורידו לצוות שלנו עומס משמעותי.",
    name: "נועה",
    role: "מנהלת משרד",
  },
  {
    quote: "הלקוחות שלי פחות מוצפים בתזכורות ידניות ממני, וזה מורגש.",
    name: "רועי",
    role: "בעל סוכנות ביטוח",
  },
  {
    quote: "קל להבין מה כבר התקבל ומה עדיין בהמתנה בלי לחפש בין תיקיות.",
    name: "ליאור",
    role: "מנהלת תפעול בחברת נדל״ן",
  },
  {
    quote: "יש לנו תמונת מצב ברורה בלי להתעסק בכל מסמך בנפרד.",
    name: "שירן",
    role: "בעלת סטודיו לעיצוב פנים",
  },
  {
    quote: "החיסכון בזמן על איסוף חשבוניות מורגש כבר מהחודש הראשון.",
    name: "מאיה",
    role: "מנהלת משרד",
  },
  {
    quote: "אני פחות מתעסק במעקב אחרי מסמכים ויותר בעבודה המקצועית עצמה.",
    name: "יונתן",
    role: "רואה חשבון",
  },
  {
    quote: "הצוות שלנו כבר לא צריך לזכור להזכיר ללקוחות לשלוח קבצים.",
    name: "אלון",
    role: "מנהל משרד עורכי דין",
  },
  {
    quote: "הכול מגיע מסודר לתיקייה הנכונה בלי שנצטרך להתערב.",
    name: "עומר",
    role: "בעל חברת ייבוא",
  },
];

const ACCENTS = [
  "from-brand-purple to-brand-blue",
  "from-brand-blue to-brand-cyan",
  "from-brand-coral to-brand-pink",
  "from-brand-emerald to-brand-cyan",
];

function StarRating() {
  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label="דירוג 5 מתוך 5 כוכבים"
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          aria-hidden="true"
          className="h-3.5 w-3.5 fill-warning text-warning"
        />
      ))}
    </div>
  );
}

function TestimonialCard({
  item,
  index,
  hidden,
}: {
  item: Testimonial;
  index: number;
  hidden?: boolean;
}) {
  const accent = ACCENTS[index % ACCENTS.length];
  return (
    <div
      dir="rtl"
      role="group"
      aria-roledescription="שקופית"
      aria-label={`${item.name}, ${item.role}`}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : 0}
      className="relative w-[19rem] shrink-0 snap-start overflow-hidden rounded-[1.5rem] border border-white/70 bg-white p-5 text-right shadow-card transition-shadow duration-300 hover:shadow-card-lg sm:w-[21rem] sm:bg-white/90 sm:backdrop-blur-md"
      style={{
        boxShadow:
          "0 1px 2px rgba(22,19,42,0.04), 0 16px 36px -18px color-mix(in oklab, var(--color-brand-purple) 35%, transparent)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br ${accent} text-sm font-bold text-white shadow-sm ring-2 ring-white`}
        >
          {item.name.charAt(0)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">
            {item.name}
          </p>
          <p className="truncate text-xs text-text-muted">{item.role}</p>
        </div>
      </div>

      <div className="mt-3">
        <StarRating />
      </div>

      <div className="mt-3 flex gap-2">
        <Quote
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-brand-purple/35"
        />
        <p className="text-sm leading-relaxed text-text-secondary">
          {item.quote}
        </p>
      </div>
    </div>
  );
}

const MARQUEE_PX_PER_SEC = 40;
const MIN_GROUPS = 2;
// Rendered immediately on first paint (and during SSR) so the section
// is always fully covered by real content, never blank while the real
// measurement below runs. 3 groups already comfortably exceeds a single
// group's width vs. any realistic viewport.
const INITIAL_GROUPS = 3;

/**
 * True marquee, sized from real measurements:
 * - The track renders N identical, back-to-back groups of the full
 *   testimonial list (never just a fixed 2 — see recalc()).
 * - N is chosen so the total track is always >= 3x the visible
 *   viewport width, so there's always real, rendered content on both
 *   sides of what's visible, at any point in the animation.
 * - The animation moves by exactly one measured group's width (in px,
 *   read from the DOM), not a percentage guess or 100vw — so it's
 *   correct regardless of how many groups end up rendered.
 * - The track is forced to `dir="ltr"` for layout purposes only (each
 *   card still renders its own Hebrew content `dir="rtl"`). This is
 *   the actual fix for the "goes blank" bug: under the page's real
 *   `dir="rtl"`, an over-wide flex child is anchored to the RIGHT edge
 *   of its container by default and overflows further content to the
 *   left — so translating the whole track further left was dragging
 *   its only content clean out of view for most of the cycle. Forcing
 *   `ltr` anchors the track's left edge at the viewport's left edge,
 *   which is what the leftward-translating animation actually assumes.
 */
export default function TestimonialsSection() {
  const [focusPaused, setFocusPaused] = useState(false);
  const [groups, setGroups] = useState(INITIAL_GROUPS);
  const [cycleDistancePx, setCycleDistancePx] = useState(0);
  const [durationSec, setDurationSec] = useState(80);
  const viewportRef = useRef<HTMLDivElement>(null);
  const firstGroupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    let cancelled = false;

    function recalc() {
      const viewportEl = viewportRef.current;
      const groupEl = firstGroupRef.current;
      if (!viewportEl || !groupEl) return;

      const viewportWidth = viewportEl.clientWidth;
      const groupWidth = groupEl.getBoundingClientRect().width;
      if (viewportWidth <= 0 || groupWidth <= 0) return;

      // Read the track's actual computed gap rather than assuming 16px,
      // so this stays correct even if the accessibility panel's text-size
      // control has changed the root font size (gap-4 = 1rem).
      const trackEl = groupEl.parentElement;
      const computedGap = trackEl
        ? parseFloat(getComputedStyle(trackEl).columnGap || "16")
        : 16;
      const gapPx = Number.isFinite(computedGap) ? computedGap : 16;

      const cycleDistance = groupWidth + gapPx;
      const neededGroups = Math.max(
        MIN_GROUPS,
        Math.ceil((viewportWidth * 3) / cycleDistance) + 1
      );

      setGroups(neededGroups);
      setCycleDistancePx(Math.round(cycleDistance));
      setDurationSec(cycleDistance / MARQUEE_PX_PER_SEC);
    }

    recalc();

    const ro = new ResizeObserver(() => recalc());
    if (viewportRef.current) ro.observe(viewportRef.current);
    if (firstGroupRef.current) ro.observe(firstGroupRef.current);

    window.addEventListener("orientationchange", recalc);
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(() => {
        if (!cancelled) recalc();
      });
    }

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("orientationchange", recalc);
    };
    // Re-observe whenever the group count changes the DOM (new ref target).
  }, [groups]);

  return (
    <section className="relative py-24 sm:py-32">
      <style>{`
        @keyframes centro-testimonial-marquee {
          from { transform: translateX(0); }
          to { transform: translateX(calc(-1 * var(--centro-cycle-distance, 0px))); }
        }
        .centro-testimonial-track {
          animation: centro-testimonial-marquee var(--centro-marquee-duration, 80s) linear infinite;
        }
        .centro-testimonial-track[data-paused="true"] {
          animation-play-state: paused;
        }
        @media (hover: hover) and (pointer: fine) {
          .centro-testimonial-viewport:hover .centro-testimonial-track {
            animation-play-state: paused;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .centro-testimonial-track {
            animation: none;
            transform: none;
          }
        }
        html[data-a11y-motion="reduced"] .centro-testimonial-track {
          animation: none !important;
          transform: none !important;
        }
      `}</style>

      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          מה אומרים על Centro
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          עסקים מכל התחומים שמפסיקים לרדוף אחרי מסמכים ומתחילים לעבוד
          בצורה מסודרת יותר.
        </motion.p>
      </div>

      <div className="relative mt-10 overflow-hidden">
        <div
          ref={viewportRef}
          dir="ltr"
          role="region"
          aria-label="המלצות לקוחות — גלילה אופקית אוטומטית"
          className="centro-testimonial-viewport overflow-hidden"
          onFocus={() => setFocusPaused(true)}
          onBlur={() => setFocusPaused(false)}
        >
          <div
            // Remounts (fresh animation instance, never a live mutation)
            // whenever a real measurement change occurs — this is what
            // keeps a running `infinite` animation from ever being
            // interrupted by a later re-render.
            key={`${groups}-${cycleDistancePx}`}
            data-paused={focusPaused || undefined}
            className="centro-testimonial-track flex w-max flex-nowrap gap-4 px-4 py-2 sm:px-6"
            style={
              {
                "--centro-cycle-distance": `${cycleDistancePx}px`,
                "--centro-marquee-duration": `${durationSec}s`,
              } as React.CSSProperties
            }
          >
            {/* Each group is its own nested flex row sharing the exact
                same gap-4 as the outer track, so the gap between the
                last card of one group and the first card of the next
                is identical to the gap between any two cards — no
                double spacing, no seam at the loop boundary. */}
            {Array.from({ length: groups }).map((_, g) => (
              <div
                key={g}
                ref={g === 0 ? firstGroupRef : undefined}
                aria-hidden={g > 0 || undefined}
                className="flex shrink-0 flex-nowrap gap-4"
              >
                {TESTIMONIALS.map((item, i) => (
                  <TestimonialCard
                    key={i}
                    item={item}
                    index={i}
                    hidden={g > 0}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
