import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ChevronDown, ScrollText, Search } from "lucide-react";
import { clsx } from "clsx";
import { requireSession } from "@/lib/auth/session";
import {
  ACTIVITY_CATEGORIES,
  CATEGORY_LABELS,
  groupActivityItems,
  listActivityHistory,
  type ActivityCategory,
  type ActivityEmphasis,
  type ActivityGroup,
  type ActivityItem,
} from "@/lib/data/activityHistory";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Badge, type BadgeTone } from "@/components/app/Badge";

const ACTOR_LABELS: Record<string, string> = {
  employee: "עובד",
  ai: "Centro",
  client: "לקוח",
  system: "מערכת",
};

const CATEGORY_BADGE_TONE: Record<Exclude<ActivityCategory, "all">, BadgeTone> = {
  request: "purple",
  document: "blue",
  whatsapp: "info",
  template: "neutral",
  failure: "danger",
};

type Range = "today" | "7d" | "30d" | "custom";

const RANGE_LABELS: Record<Range, string> = {
  today: "היום",
  "7d": "7 ימים אחרונים",
  "30d": "30 יום אחרונים",
  custom: "טווח מותאם אישית",
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function toDateInputValue(date: Date): string {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// Every boundary is computed in server-local time — this codebase has no
// timezone infrastructure anywhere else to do otherwise (see e.g.
// relativeTime()/toLocaleString("he-IL") usage throughout the dashboards).
function resolveRange(
  range: Range,
  fromParam?: string,
  untilParam?: string
): { from: Date; to: Date } {
  const now = new Date();
  if (range === "7d") return { from: startOfDay(new Date(now.getTime() - 6 * 86400000)), to: endOfDay(now) };
  if (range === "30d") return { from: startOfDay(new Date(now.getTime() - 29 * 86400000)), to: endOfDay(now) };
  if (range === "custom") {
    const parsedFrom = fromParam ? new Date(fromParam) : null;
    const parsedUntil = untilParam ? new Date(untilParam) : null;
    if (parsedFrom && !Number.isNaN(parsedFrom.getTime()) && parsedUntil && !Number.isNaN(parsedUntil.getTime())) {
      return { from: startOfDay(parsedFrom), to: endOfDay(parsedUntil) };
    }
    // Invalid/incomplete custom range - fall back to today rather than an
    // unbounded or broken query.
    return { from: startOfDay(now), to: endOfDay(now) };
  }
  return { from: startOfDay(now), to: endOfDay(now) };
}

function dayLabel(date: Date): string {
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  if (day.getTime() === today.getTime()) return "היום";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.getTime() === yesterday.getTime()) return "אתמול";
  return day.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
}

function timeLabel(date: Date): string {
  return new Date(date).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

// The client/template/request an item is about — each a real link when the
// id is known. A deleted/retired entity (a template that's since been
// removed) still shows its historical name — never a broken link, per
// "history must stay readable forever" (services.retiredAt is a soft-
// delete, so this resolves correctly even then; only a genuinely missing
// id skips the link).
function ActivityContext({ item }: { item: ActivityItem }) {
  const parts: ReactNode[] = [];
  if (item.clientName) {
    parts.push(
      item.clientId ? (
        <Link key="client" href={`/clients/${item.clientId}`} className="font-medium text-text-secondary hover:text-brand-purple hover:underline">
          {item.clientName}
        </Link>
      ) : (
        <span key="client">{item.clientName}</span>
      )
    );
  }
  const requestOrTemplateLabel = item.requestLabel ?? item.templateName;
  if (requestOrTemplateLabel) {
    const href = item.collectionRequestId
      ? `/collections/${item.collectionRequestId}`
      : item.templateId
        ? `/collections/manage/${item.templateId}`
        : null;
    parts.push(
      href ? (
        <Link key="request" href={href} className="hover:text-brand-purple hover:underline">
          {requestOrTemplateLabel}
        </Link>
      ) : (
        <span key="request">{requestOrTemplateLabel}</span>
      )
    );
  }
  if (parts.length === 0) return null;
  return (
    <>
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`}> · </span>, part]))}
      {" · "}
    </>
  );
}

const EMPHASIS_TITLE_CLASS: Record<ActivityEmphasis, string> = {
  routine: "text-text-secondary",
  significant: "font-semibold text-text-primary",
  critical: "font-semibold text-danger",
};

// One compact row per event — title + a single muted meta line (context ·
// actor · time), a small category badge at the end. No per-item card
// chrome, no multi-line whitespace: a routine event and a significant one
// take the same minimal height, differing only in the title's own weight/
// color (EMPHASIS_TITLE_CLASS) and, for a genuine failure, a left accent +
// icon — never a full card competing for attention with what actually
// matters.
function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <li
      className={clsx(
        "flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-surface-muted",
        item.emphasis === "critical" && "border-s-2 border-s-danger bg-danger/5"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={clsx("flex items-center gap-1.5 truncate text-sm", EMPHASIS_TITLE_CLASS[item.emphasis])}>
          {item.emphasis === "critical" && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">{item.title}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-text-muted">
          <ActivityContext item={item} />
          {ACTOR_LABELS[item.actorType] ?? item.actorType}
          {item.actorName ? ` (${item.actorName})` : ""}
          {" · "}
          {timeLabel(item.occurredAt)}
        </p>
        {item.detail && <p className="mt-0.5 truncate text-xs text-text-secondary">{item.detail}</p>}
        {item.technicalDetail && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-brand-purple">הצג פרטים</summary>
            <p className="mt-1 rounded-lg bg-surface-muted p-2 text-xs text-text-muted" dir="auto">
              {item.technicalDetail}
            </p>
          </details>
        )}
      </div>
      <Badge tone={CATEGORY_BADGE_TONE[item.category]} className="shrink-0">
        {CATEGORY_LABELS[item.category]}
      </Badge>
    </li>
  );
}

// A burst of identical events (same title, same category, within a few
// minutes of each other — see groupActivityItems' own doc comment)
// collapses to one row: the newest occurrence's own title/context, a
// count badge, and a native <details> that reveals every real underlying
// item on demand. Never a dedup — every item in `group.items` is still a
// real, distinct row from listActivityHistory, unedited and undeleted.
function ActivityGroupRow({ group }: { group: ActivityGroup }) {
  if (group.items.length === 1) return <ActivityRow item={group.item} />;
  return (
    <li>
      <details className="group/activity">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted transition-transform group-open/activity:rotate-180" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className={clsx("flex items-center gap-1.5 truncate text-sm", EMPHASIS_TITLE_CLASS[group.item.emphasis])}>
              <span className="truncate">{group.item.title}</span>
              <span className="shrink-0 text-xs font-normal text-text-muted">— הצג {group.items.length} פעולות</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              <ActivityContext item={group.item} />
              {timeLabel(group.items[group.items.length - 1].occurredAt)} – {timeLabel(group.item.occurredAt)}
            </p>
          </div>
          <Badge tone={CATEGORY_BADGE_TONE[group.item.category]} className="shrink-0">
            {CATEGORY_LABELS[group.item.category]} · {group.items.length}
          </Badge>
        </summary>
        <ul className="mt-1 me-3 space-y-0.5 border-e-2 border-border pe-3">
          {group.items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; until?: string; category?: string; q?: string }>;
}) {
  const session = await requireSession();
  const { range: rangeParam, from: fromParam, until: untilParam, category: categoryParam, q } = await searchParams;
  const range: Range =
    rangeParam === "7d" || rangeParam === "30d" || rangeParam === "custom" ? rangeParam : "today";
  const { from, to } = resolveRange(range, fromParam, untilParam);
  const category: ActivityCategory = ACTIVITY_CATEGORIES.includes(categoryParam as ActivityCategory)
    ? (categoryParam as ActivityCategory)
    : "all";
  const search = q?.trim() || undefined;

  const items = await listActivityHistory(session.organizationId, { from, to, category, search });

  // Group first (a burst can span the last minute of one day into the
  // first of the next — negligible in practice, but grouping before
  // splitting by day keeps the logic simple and correct either way), then
  // bucket the resulting groups by the representative item's own day.
  const activityGroups = groupActivityItems(items);
  const dayGroups: { key: string; label: string; groups: ActivityGroup[] }[] = [];
  for (const activityGroup of activityGroups) {
    const occurredAt = new Date(activityGroup.item.occurredAt);
    const key = startOfDay(occurredAt).toISOString();
    const lastDayGroup = dayGroups[dayGroups.length - 1];
    if (lastDayGroup && lastDayGroup.key === key) {
      lastDayGroup.groups.push(activityGroup);
    } else {
      dayGroups.push({ key, label: dayLabel(occurredAt), groups: [activityGroup] });
    }
  }

  // Every filter link preserves the other active filters (range/category/
  // search) — a real navigation (<Link>/native GET <form>), zero client JS,
  // fully bookmarkable URLs, matching this page's existing convention.
  const baseParams = new URLSearchParams();
  baseParams.set("range", range);
  if (range === "custom") {
    baseParams.set("from", toDateInputValue(from));
    baseParams.set("until", toDateInputValue(to));
  }
  if (search) baseParams.set("q", search);

  function hrefWithCategory(c: ActivityCategory) {
    const params = new URLSearchParams(baseParams);
    if (c !== "all") params.set("category", c);
    return `/audit?${params.toString()}`;
  }
  function hrefWithRange(r: Range) {
    const params = new URLSearchParams();
    params.set("range", r);
    if (category !== "all") params.set("category", category);
    if (search) params.set("q", search);
    return `/audit?${params.toString()}`;
  }

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="היסטוריית פעילות"
        description="כל מה שקרה במערכת, במקום אחד. בקשות, מסמכים, הודעות ופעולות שבוצעו על ידי הצוות והמערכת."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["today", "7d", "30d"] as const).map((r) => (
          <Link
            key={r}
            href={hrefWithRange(r)}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ease-[var(--ease-standard)] ${
              range === r
                ? "border-brand-purple bg-brand-purple/10 text-brand-purple"
                : "border-border text-text-secondary hover:border-brand-purple hover:text-brand-purple"
            }`}
          >
            {RANGE_LABELS[r]}
          </Link>
        ))}
        <form action="/audit" method="GET" className="flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="range" value="custom" />
          {category !== "all" && <input type="hidden" name="category" value={category} />}
          {search && <input type="hidden" name="q" value={search} />}
          <input
            type="date"
            name="from"
            defaultValue={range === "custom" ? toDateInputValue(from) : undefined}
            dir="ltr"
            className={`rounded-full border px-3 py-1.5 text-xs outline-none transition-all duration-200 ease-[var(--ease-standard)] focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10 ${
              range === "custom" ? "border-brand-purple text-brand-purple" : "border-border text-text-secondary"
            }`}
          />
          <span className="text-xs text-text-muted">—</span>
          <input
            type="date"
            name="until"
            defaultValue={range === "custom" ? toDateInputValue(to) : undefined}
            dir="ltr"
            className={`rounded-full border px-3 py-1.5 text-xs outline-none transition-all duration-200 ease-[var(--ease-standard)] focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10 ${
              range === "custom" ? "border-brand-purple text-brand-purple" : "border-border text-text-secondary"
            }`}
          />
          <button
            type="submit"
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-text-secondary transition-colors ease-[var(--ease-standard)] hover:border-brand-purple hover:text-brand-purple"
          >
            {RANGE_LABELS.custom}
          </button>
        </form>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {ACTIVITY_CATEGORIES.map((c) => (
          <Link
            key={c}
            href={hrefWithCategory(c)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ease-[var(--ease-standard)] ${
              category === c
                ? "border-brand-purple bg-brand-purple/10 text-brand-purple"
                : "border-border text-text-secondary hover:border-brand-purple hover:text-brand-purple"
            }`}
          >
            {CATEGORY_LABELS[c]}
          </Link>
        ))}
      </div>

      <form action="/audit" method="GET" className="mb-6 flex items-center gap-2">
        <input type="hidden" name="range" value={range} />
        {range === "custom" && (
          <>
            <input type="hidden" name="from" value={toDateInputValue(from)} />
            <input type="hidden" name="until" value={toDateInputValue(to)} />
          </>
        )}
        {category !== "all" && <input type="hidden" name="category" value={category} />}
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            name="q"
            type="text"
            defaultValue={search ?? ""}
            placeholder="חיפוש לפי שם לקוח, תבנית, בקשה או מזהה..."
            className="centro-glass w-full rounded-xl border border-border ps-10 pe-4 py-2.5 text-sm text-text-primary shadow-card outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="אין רשומות פעילות בטווח הזה"
          description="נסו טווח תאריכים, קטגוריה או חיפוש אחר, או חזרו לכאן אחרי שתתבצע פעולה כלשהי במערכת."
        />
      ) : (
        <div className="space-y-5">
          {dayGroups.map((dayGroup) => (
            <div key={dayGroup.key}>
              <h2 className="mb-1.5 text-xs font-semibold text-text-muted">{dayGroup.label}</h2>
              <ul className="divide-y divide-border/60 rounded-xl border border-border bg-surface">
                {dayGroup.groups.map((activityGroup) => (
                  <ActivityGroupRow key={activityGroup.item.id} group={activityGroup} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה ללוח הבקרה
        </Link>
      </p>
    </div>
  );
}
