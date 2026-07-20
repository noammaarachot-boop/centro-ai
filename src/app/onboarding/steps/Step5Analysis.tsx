"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  FileUp,
  Layers,
  RefreshCcw,
  Sparkles,
  UserRoundX,
} from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { buttonVariants, Button } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { fieldClass } from "@/components/app/FormField";
import {
  advanceOnboardingStep,
  assignBusinessTypeAction,
  reassignClientBusinessType,
  type ImportAnalysisSummary,
} from "../actions";
import { ImportUploader } from "./ImportUploader";

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
  importSummary,
}: {
  businessTypes: BusinessTypeRow[];
  clientsByType: ClientRow[][];
  unclassifiedClients: ClientRow[];
  importSummary?: ImportAnalysisSummary;
}) {
  const [expandedTypeId, setExpandedTypeId] = useState<string | null>(null);
  const [showAssignPanel, setShowAssignPanel] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingNewType, setCreatingNewType] = useState(false);
  const [activeUploader, setActiveUploader] = useState<"replace" | "add" | null>(null);

  const totalClassified = businessTypes.reduce((sum, t) => sum + t.clientCount, 0);
  const total = totalClassified + unclassifiedClients.length;
  const goToStep6 = advanceOnboardingStep.bind(null, 8);

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
        <ImportUploader mode="add" submitLabel="ייבוא Excel / CSV" />
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
      {importSummary ? (
        <div className="animate-fade-in-up rounded-2xl border border-brand-emerald/25 bg-brand-emerald/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-8 w-8 shrink-0 text-brand-emerald" />
            <div>
              <p className="text-base font-bold text-text-primary">Centro הבין את הקובץ שלכם</p>
              <p className="text-xs text-text-secondary">
                {importSummary.confidence === "high"
                  ? "הזיהוי בוצע אוטומטית, בביטחון גבוה"
                  : "הזיהוי אושר על ידכם לפני הייבוא"}
              </p>
            </div>
          </div>

          <ul className="mt-4 space-y-1.5 text-sm text-text-secondary">
            <li>✅ {importSummary.imported} לקוחות זוהו בקובץ</li>
            {importSummary.autoClassified > 0 && (
              <li>✅ {importSummary.autoClassified} סוגי עסק סווגו אוטומטית (ביטחון גבוה)</li>
            )}
            {importSummary.suggested > 0 && (
              <li>💡 {importSummary.suggested} סוגי עסק סווגו כהצעה — כדאי לוודא</li>
            )}
            {importSummary.needsReview > 0 && (
              <li>⚠️ {importSummary.needsReview} לקוחות דורשים סקירה ידנית — וזה בסדר גמור</li>
            )}
          </ul>

          {(importSummary.sheetsFound?.length ?? 0) > 1 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
              <Layers className="h-3.5 w-3.5" />
              נמצאו {importSummary.sheetsFound?.length} גיליונות בקובץ — נעשה שימוש בגיליון
              &quot;{importSummary.sheetUsed}&quot;
            </p>
          )}
          {(importSummary.skippedLeadingRows ?? 0) + (importSummary.skippedTrailingRows ?? 0) > 0 && (
            <p className="mt-1 text-xs text-text-muted">
              דילגנו על שורות שלא היו חלק מטבלת הלקוחות (כותרת/סיכום) כדי לא לפגוע בדיוק הזיהוי.
            </p>
          )}

          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-bold tabular-nums text-text-primary">{total}</p>
              <p className="text-[11px] text-text-muted">לקוחות יובאו</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-brand-emerald">{totalClassified}</p>
              <p className="text-[11px] text-text-muted">סווגו (ודאי + הצעה)</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-warning">
                {unclassifiedClients.length}
              </p>
              <p className="text-[11px] text-text-muted">דורשים סיווג ידני</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="animate-fade-in-up rounded-2xl border border-brand-emerald/25 bg-brand-emerald/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-8 w-8 shrink-0 text-brand-emerald" />
            <div>
              <p className="text-base font-bold text-text-primary">הייבוא הושלם בהצלחה!</p>
              <p className="text-xs text-text-secondary">Centro ניתח וסיווג את הלקוחות אוטומטית</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-bold tabular-nums text-text-primary">{total}</p>
              <p className="text-[11px] text-text-muted">לקוחות יובאו</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-brand-emerald">{totalClassified}</p>
              <p className="text-[11px] text-text-muted">סווגו אוטומטית</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-warning">
                {unclassifiedClients.length}
              </p>
              <p className="text-[11px] text-text-muted">דורשים סיווג ידני</p>
            </div>
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-text-secondary">
        זו רק נקודת התחלה — Centro ימשיך ללמוד אילו מסמכים כל לקוח שולח בפועל ולשפר את
        הסיווג וההתאמה האישית עם הזמן. לא צריך להגיע לדיוק מושלם עכשיו.
      </p>

      {/* Feature: Replace / Add another Excel file — for when the wrong file
          was uploaded, or the right file was uploaded but is incomplete.
          Reuses the exact same ImportUploader as Step 4; the mode
          ("replace" vs "add") is all that differs. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setActiveUploader(activeUploader === "replace" ? null : "replace")}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          החלפת קובץ Excel
        </button>
        <button
          type="button"
          onClick={() => setActiveUploader(activeUploader === "add" ? null : "add")}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <FileUp className="h-3.5 w-3.5" />
          הוספת קובץ Excel נוסף
        </button>
      </div>

      {activeUploader && (
        <Card className="animate-fade-in-up border-brand-purple/25 bg-brand-purple/5">
          <p className="mb-3 text-xs font-medium text-text-secondary">
            {activeUploader === "replace"
              ? "העלו קובץ Excel / CSV חדש. הלקוחות שיובאו בטעות מהקובץ הקודם יוסרו — לקוחות קיימים או שנוספו ידנית לא ייפגעו — ו-Centro ינתח את הקובץ החדש מהתחלה."
              : "העלו קובץ Excel / CSV נוסף. הלקוחות בו יתווספו לרשימה הקיימת."}
          </p>
          <ImportUploader
            mode={activeUploader}
            submitLabel={activeUploader === "replace" ? "החלפת הקובץ" : "הוספת הקובץ"}
            onCancel={() => setActiveUploader(null)}
          />
        </Card>
      )}

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
                <ul
                  className="animate-fade-in-up mt-2 space-y-1.5 rounded-xl border border-border bg-surface-muted/40 p-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  {clients.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-text-secondary">
                        {c.name} <span dir="ltr" className="text-text-muted">({c.phone})</span>
                      </span>
                      <form action={reassignClientBusinessType} className="shrink-0">
                        <input type="hidden" name="clientId" value={c.id} />
                        <select
                          name="businessTypeId"
                          defaultValue={type.id}
                          onChange={(e) => e.currentTarget.form?.requestSubmit()}
                          aria-label={`שינוי סוג עסק עבור ${c.name}`}
                          className="rounded-lg border border-border bg-white px-1.5 py-1 text-[11px] text-text-primary outline-none focus:border-brand-purple"
                        >
                          {businessTypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </form>
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
                לא צריך לערוך שום קובץ. וגם אם חלק יישארו לא מסווגים, זה לגמרי בסדר: Centro
                יכול להתחיל לעבוד גם כך, וימשיך ללמוד אילו מסמכים כל לקוח שולח באופן קבוע
                וישפר את איסוף המסמכים העתידי אוטומטית.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {!showAssignPanel ? (
                  <button
                    type="button"
                    onClick={() => setShowAssignPanel(true)}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    שיוך סוג עסק
                  </button>
                ) : null}
                <form action={goToStep6}>
                  <button
                    type="submit"
                    className="text-xs font-medium text-text-muted underline-offset-2 transition-colors hover:text-brand-purple hover:underline"
                  >
                    דילוג — אני סומך/ת על Centro שילמד עם הזמן
                  </button>
                </form>
              </div>
              {showAssignPanel && (
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
                        className={fieldClass("sm", "flex-1")}
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
                      className={fieldClass("sm")}
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
