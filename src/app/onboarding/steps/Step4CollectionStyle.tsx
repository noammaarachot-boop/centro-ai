import { Layers, RefreshCw, Zap } from "lucide-react";
import { Card } from "@/components/app/Card";
import { HelpTip } from "@/components/app/HelpTip";
import { updateWorkflowType } from "../actions";

// The choice that personalizes the rest of onboarding — three decisive
// buttons, each its own form bound to the value it sets, rather than a
// selection to confirm separately. Product Evolution M9: this no longer
// permanently locks the organization into one mode (see
// updateWorkflowType's comment) — it only determines which setup steps
// come next; both capabilities are available to every organization once
// onboarding is done.
export function Step4CollectionStyle() {
  const chooseRecurring = updateWorkflowType.bind(null, "recurring");
  const chooseOnDemand = updateWorkflowType.bind(null, "on_demand");
  const chooseBoth = updateWorkflowType.bind(null, "both");

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
                  <p className="text-sm font-semibold text-text-primary">איסוף מחזורי</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    אני אוסף באופן קבוע וחוזר את אותם המסמכים מהלקוחות שלי.
                  </p>
                </div>
              </div>
            </Card>
          </button>
        </form>
        <div className="mt-1.5 flex justify-end">
          <HelpTip label="מה ההבדל?">
            מתאים למי שאוסף שוב ושוב, בתדירות קבועה (לדוגמה מדי חודש או מדי רבעון), את אותם
            סוגי מסמכים מאותם לקוחות. Centro פותח את
            המחזור הבא אוטומטית לפי התדירות שתגדירו, וזוכר בהדרגה אילו מסמכים כל לקוח שולח
            בקביעות.
          </HelpTip>
        </div>
      </div>

      <div>
        <form action={chooseOnDemand}>
          <button type="submit" className="block w-full text-start">
            <Card interactive glow="blue" className="cursor-pointer">
              <div className="flex items-start gap-3">
                <span className="centro-icon-blue grid h-10 w-10 shrink-0 place-items-center rounded-xl">
                  <Zap className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">איסוף לפי צורך</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    אני אוסף מסמכים רק כשיש בקשה חד-פעמית או נקודתית.
                  </p>
                </div>
              </div>
            </Card>
          </button>
        </form>
        <div className="mt-1.5 flex justify-end">
          <HelpTip label="מה ההבדל?">
            מתאים כשאוספים מסמכים לבקשה נקודתית — חוזה שכירות, בקשת משכנתא, קליטת עובד חדש
            וכו&apos; — ולא כחלק ממחזור חוזר. תיצרו תבניות לבקשות שחוזרות על עצמן ותשלחו
            אותן ביוזמתכם בכל פעם; איסוף כזה אף פעם לא פותח מחזור נוסף אוטומטית, ו-Centro
            לא לומד כאן דבר על הלקוחות.
          </HelpTip>
        </div>
      </div>

      <div>
        <form action={chooseBoth}>
          <button type="submit" className="block w-full text-start">
            <Card interactive glow="purple" className="cursor-pointer">
              <div className="flex items-start gap-3">
                <span className="centro-icon-purple grid h-10 w-10 shrink-0 place-items-center rounded-xl">
                  <Layers className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">שניהם</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    יש לי גם לקוחות עם איסוף קבוע וגם בקשות חד-פעמיות מדי פעם.
                  </p>
                </div>
              </div>
            </Card>
          </button>
        </form>
        <div className="mt-1.5 flex justify-end">
          <HelpTip label="מה ההבדל?">
            נתחיל בהקמת האיסוף המחזורי — הוא בדרך כלל דורש יותר הגדרות מראש. אפשרות האיסוף
            לפי צורך תהיה זמינה מיד אחר כך מהתפריט, בלי צורך בהקמה נוספת.
          </HelpTip>
        </div>
      </div>
    </div>
  );
}
