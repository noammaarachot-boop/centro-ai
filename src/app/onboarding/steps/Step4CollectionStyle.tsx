import { RefreshCw, Zap } from "lucide-react";
import { Card } from "@/components/app/Card";
import { HelpTip } from "@/components/app/HelpTip";
import { updateWorkflowType } from "../actions";

// The choice that "determines the entire product experience" — two
// decisive buttons, each its own form bound to the value it sets, rather
// than a selection to confirm separately. Permanent for the pilot (see
// updateWorkflowType's comment).
export function Step4CollectionStyle() {
  const chooseRecurring = updateWorkflowType.bind(null, "recurring");
  const chooseOneTime = updateWorkflowType.bind(null, "one_time");

  return (
    <div className="space-y-5">
      <div>
        <form action={chooseRecurring}>
          <button type="submit" className="block w-full text-start">
            <Card interactive glow="purple" className="cursor-pointer">
              <div className="flex items-start gap-3">
                <span className="centro-icon-purple grid h-10 w-10 shrink-0 place-items-center rounded-xl">
                  <RefreshCw className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    אני אוסף באופן קבוע את אותם המסמכים מהלקוחות שלי
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">לדוגמה מדי חודש.</p>
                </div>
              </div>
            </Card>
          </button>
        </form>
        <div className="mt-1.5 flex justify-end">
          <HelpTip label="מה ההבדל?">
            מתאים למי שאוסף חודש אחר חודש את אותם מסמכים (חשבוניות, דפי בנק,
            תלושי שכר וכו&apos;) מאותם לקוחות — לדוגמה רואי חשבון ויועצי מס.
            Centro זוכר בהדרגה אילו מסמכים כל לקוח שולח בקביעות ומשתפר עם
            הזמן.
          </HelpTip>
        </div>
      </div>

      <div>
        <form action={chooseOneTime}>
          <button type="submit" className="block w-full text-start">
            <Card interactive glow="blue" className="cursor-pointer">
              <div className="flex items-start gap-3">
                <span className="centro-icon-blue grid h-10 w-10 shrink-0 place-items-center rounded-xl">
                  <Zap className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    אני אוסף מסמכים רק עבור בקשות חד-פעמיות
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    לא כחלק ממחזור חודשי קבוע.
                  </p>
                </div>
              </div>
            </Card>
          </button>
        </form>
        <div className="mt-1.5 flex justify-end">
          <HelpTip label="מה ההבדל?">
            מתאים כשאוספים מסמכים לבקשה נקודתית — חוזה שכירות, בקשת
            משכנתא, קליטת עובד חדש וכו&apos; — ולא כחלק ממחזור חודשי חוזר.
            תיצרו תבניות לבקשות שחוזרות על עצמן ותשלחו אותן לפי הצורך; Centro
            לא לומד כאן דבר על הלקוחות, אתם שולטים בתבניות באופן מלא.
          </HelpTip>
        </div>
      </div>
    </div>
  );
}
