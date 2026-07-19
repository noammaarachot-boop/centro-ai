"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, Sparkles, UserRoundX } from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { buttonVariants, Button } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { advanceOnboardingStep, assignBusinessTypeAction } from "../actions";

interface ClientRow {
  id: string;
  name: string;
  phone: string;
}

interface BusinessTypeRow {
  id: string;
  name: string;
  clientCount: number;
}

export function Step5Analysis({
  businessTypes,
  clientsByType,
  unclassifiedClients,
}: {
  businessTypes: BusinessTypeRow[];
  clientsByType: ClientRow[][];
  unclassifiedClients: ClientRow[];
}) {
  const [expandedTypeId, setExpandedTypeId] = useState<string | null>(null);
  const [showAssignPanel, setShowAssignPanel] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingNewType, setCreatingNewType] = useState(false);

  const totalClassified = businessTypes.reduce((sum, t) => sum + t.clientCount, 0);
  const total = totalClassified + unclassifiedClients.length;
  const goToStep6 = advanceOnboardingStep.bind(null, 6);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (total === 0) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={Sparkles}
          title="עדיין אין לקוחות לנתח"
          description="דילגתם על ייבוא לקוחות בשלב הקודם. תמיד תוכלו לייבא ולסווג לקוחות מאוחר יותר מעמוד הלקוחות."
        />
        <form action={goToStep6}>
          <button
            type="submit"
            className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
          >
            המשך
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="animate-fade-in-up flex items-center gap-3 rounded-2xl border border-brand-emerald/25 bg-brand-emerald/5 px-5 py-4">
        <CheckCircle2 className="h-8 w-8 shrink-0 text-brand-emerald" />
        <div>
          <p className="text-2xl font-bold tabular-nums text-text-primary">
            {total} לקוחות נמצאו
          </p>
          <p className="text-xs text-text-secondary">Centro ניתח וסיווג אותם אוטומטית</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {businessTypes.map((type, index) => {
          const isExpanded = expandedTypeId === type.id;
          const clients = clientsByType[index] ?? [];
          return (
            <div key={type.id}>
              <Card
                interactive
                glow="purple"
                padding="sm"
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onClick={() => setExpandedTypeId(isExpanded ? null : type.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpandedTypeId(isExpanded ? null : type.id);
                  }
                }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{type.name}</p>
                    <p className="text-xs text-text-muted">{type.clientCount} לקוחות</p>
                  </div>
                  <ChevronDown
                    className={clsx(
                      "h-4 w-4 text-text-muted transition-transform",
                      isExpanded && "rotate-180"
                    )}
                  />
                </div>
              </Card>
              {isExpanded && clients.length > 0 && (
                <ul className="animate-fade-in-up mt-2 space-y-1 rounded-xl border border-border bg-surface-muted/40 p-3">
                  {clients.map((c) => (
                    <li key={c.id} className="text-xs text-text-secondary">
                      {c.name} <span dir="ltr" className="text-text-muted">({c.phone})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {unclassifiedClients.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <div className="flex items-start gap-3">
            <UserRoundX className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-text-primary">
                לא הצלחנו לזהות את סוג העסק עבור {unclassifiedClients.length} לקוחות
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                זה קורה כשלא ניתן לקבוע את סוג העסק משם החברה בלבד. אפשר לשייך אותם ידנית —
                לא צריך לערוך שום קובץ.
              </p>
              {!showAssignPanel ? (
                <button
                  type="button"
                  onClick={() => setShowAssignPanel(true)}
                  className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3" })}
                >
                  שיוך סוג עסק
                </button>
              ) : (
                <form
                  action={assignBusinessTypeAction}
                  className="animate-fade-in-up mt-3 space-y-3 rounded-xl border border-border bg-surface p-3"
                >
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                    {unclassifiedClients.map((c) => (
                      <li key={c.id}>
                        <label className="flex items-center gap-2 text-xs text-text-primary">
                          <input
                            type="checkbox"
                            name="clientId"
                            value={c.id}
                            checked={selectedIds.has(c.id)}
                            onChange={() => toggleSelected(c.id)}
                            className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
                          />
                          {c.name}{" "}
                          <span dir="ltr" className="text-text-muted">
                            ({c.phone})
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>

                  {!creatingNewType ? (
                    <div className="flex items-center gap-2">
                      <select
                        name="businessTypeId"
                        required
                        className="flex-1 rounded-lg border border-border bg-white px-2 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                      >
                        <option value="">— בחירת סוג עסק —</option>
                        {businessTypes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setCreatingNewType(true)}
                        className="whitespace-nowrap text-xs font-medium text-brand-purple hover:underline"
                      >
                        + סוג חדש
                      </button>
                    </div>
                  ) : (
                    <input
                      name="newTypeName"
                      type="text"
                      required
                      placeholder="שם סוג העסק החדש"
                      className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                    />
                  )}

                  <Button type="submit" variant="primary" size="sm" disabled={selectedIds.size === 0}>
                    שיוך {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
                  </Button>
                </form>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-text-muted">
        {businessTypes.map((t) => (
          <Badge key={t.id} tone="purple">
            {t.name}: {t.clientCount}
          </Badge>
        ))}
        {unclassifiedClients.length > 0 && (
          <Badge tone="warning">לא סווגו: {unclassifiedClients.length}</Badge>
        )}
      </div>

      <form action={goToStep6}>
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </button>
      </form>
    </div>
  );
}
