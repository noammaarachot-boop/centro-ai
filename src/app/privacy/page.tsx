import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "מדיניות פרטיות — Centro",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h2 className="mb-2.5 text-lg font-semibold text-text-primary">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-16">
      <div className="w-full max-w-2xl">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לעמוד הבית
        </Link>
        <div className="rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
          <h1 className="mb-1 text-2xl font-semibold text-text-primary">מדיניות פרטיות</h1>
          <p className="mb-8 text-xs text-text-muted">עודכן לאחרונה: יולי 2026</p>

          <div className="space-y-6">
            <Section title="1. מבוא">
              <p>
                Centro (&quot;אנחנו&quot;, &quot;החברה&quot;, &quot;השירות&quot;) מספקת פלטפורמה
                לניהול ואיסוף מסמכים עסקיים מלקוחות, הכוללת חיבור ל-Google Drive ול-WhatsApp
                Business. מדיניות פרטיות זו מסבירה אילו נתונים אנו אוספים, כיצד אנו משתמשים
                בהם, עם מי אנו עשויים לשתף אותם, וכיצד ניתן לממש את הזכויות שלכם ביחס אליהם.
              </p>
              <p>
                השימוש בשירות מהווה הסכמה למדיניות זו. אם אינכם מסכימים לתנאים המפורטים כאן,
                אנא הימנעו משימוש בשירות.
              </p>
            </Section>

            <Section title="2. הגדרות">
              <p>
                <span className="font-medium text-text-primary">&quot;עסק&quot; / &quot;לקוח Centro&quot;</span>{" "}
                — הגורם העסקי שנרשם לשירות ומשתמש בו לניהול הלקוחות שלו (למשל משרד רואי חשבון,
                עורך דין או יועץ).
              </p>
              <p>
                <span className="font-medium text-text-primary">&quot;לקוח הקצה&quot;</span> — לקוח
                של העסק שנתוניו (שם, טלפון, מסמכים) מוזנים או נאספים דרך השירות. Centro פועלת
                כמעבד מידע מטעם העסק ביחס ללקוחות הקצה שלו, והעסק הוא האחראי (controller) על
                המידע הזה מול לקוחותיו.
              </p>
            </Section>

            <Section title="3. מידע שאנו אוספים">
              <p>מידע שנאסף במסגרת השימוש בשירות כולל:</p>
              <ul className="list-inside list-disc space-y-1.5">
                <li>
                  <span className="font-medium text-text-primary">פרטי חשבון:</span> שם מלא,
                  כתובת אימייל, מספר טלפון וסיסמה (מוצפנת) של המשתמש הנרשם מטעם העסק.
                </li>
                <li>
                  <span className="font-medium text-text-primary">פרטי העסק:</span> שם העסק,
                  סוג הפעילות, שעות עבודה ולוגו (אופציונלי).
                </li>
                <li>
                  <span className="font-medium text-text-primary">פרטי לקוחות הקצה:</span> שם,
                  מספר טלפון, כתובת אימייל (אם הוזנה) והערות, כפי שהוזנו על ידי העסק או יובאו
                  מקובץ Excel/CSV.
                </li>
                <li>
                  <span className="font-medium text-text-primary">מסמכים ותוכן הודעות:</span>{" "}
                  קבצים שנשלחים על ידי לקוחות קצה דרך WhatsApp, וכן תוכן ההתכתבות הנדרש לצורך
                  מעקב אחר בקשות איסוף מסמכים.
                </li>
                <li>
                  <span className="font-medium text-text-primary">נתוני שימוש:</span> יומני
                  פעילות במערכת (Activity History), לצורכי אבטחה, תמיכה ושיפור השירות.
                </li>
              </ul>
            </Section>

            <Section title="4. כיצד אנו משתמשים במידע">
              <ul className="list-inside list-disc space-y-1.5">
                <li>הפעלת השירות: פנייה אוטומטית ללקוחות קצה, קליטת מסמכים וסיווגם.</li>
                <li>
                  סיווג וניתוח אוטומטיים של מסמכים ופרטי לקוחות באמצעות כללים ומודלים
                  פנימיים, לצורך התאמת בקשות האיסוף לכל לקוח קצה.
                </li>
                <li>תקשורת עם העסק בנוגע לשירות — עדכונים, התראות ותמיכה טכנית.</li>
                <li>שמירה על אבטחת השירות, מניעת שימוש לרעה ועמידה בדרישות חוק.</li>
                <li>שיפור השירות וניתוח ביצועים באופן מצרפי ולא מזוהה ככל הניתן.</li>
              </ul>
              <p>
                Centro אינה משתמשת בתוכן המסמכים או בפרטי לקוחות הקצה לצורך פרסום, ואינה מוכרת
                מידע אישי לצדדים שלישיים.
              </p>
            </Section>

            <Section title="5. שיתוף מידע עם צדדים שלישיים">
              <p>לצורך הפעלת השירות, מידע מסוים מועבר לספקים הבאים, בהתאם לחיבורים שהעסק בחר להפעיל:</p>
              <ul className="list-inside list-disc space-y-1.5">
                <li>
                  <span className="font-medium text-text-primary">Google Drive:</span> מסמכים
                  שאושרו נשמרים בתיקיית Google Drive של העסק עצמו, בחשבון שהעסק מחבר באופן
                  יזום.
                </li>
                <li>
                  <span className="font-medium text-text-primary">WhatsApp Business (Meta):</span>{" "}
                  הודעות ומסמכים הנשלחים ומתקבלים מלקוחות קצה עוברים דרך תשתית WhatsApp
                  Business, הכפופה למדיניות הפרטיות של Meta.
                </li>
                <li>
                  <span className="font-medium text-text-primary">ספקי תשתית וענן:</span>{" "}
                  אחסון בסיס הנתונים והפעלת השירות מתבצעים אצל ספקי אחסון מוכרים, הכפופים
                  להתחייבויות סודיות ואבטחת מידע.
                </li>
              </ul>
              <p>
                מידע עשוי להיחשף גם כאשר הדבר נדרש על פי דין, צו שיפוטי, או כדי להגן על
                זכויותינו, זכויות משתמשינו או צדדים שלישיים.
              </p>
            </Section>

            <Section title="6. אבטחת מידע">
              <p>
                אנו נוקטים באמצעי אבטחה סבירים ומקובלים בתעשייה, לרבות הצפנת סיסמאות, בקרת
                גישה מבוססת הרשאות, ותקשורת מוצפנת (HTTPS) בין הדפדפן לשרתי השירות. עם זאת, אין
                שיטת אחסון או העברת מידע דרך האינטרנט המובטחת באופן מוחלט, ואיננו יכולים להבטיח
                הגנה מושלמת מפני כל תרחיש.
              </p>
            </Section>

            <Section title="7. שמירת מידע ומחיקתו">
              <p>
                מידע נשמר במערכת כל עוד חשבון העסק פעיל, ובהתאם לצורך התפעולי והחוקי לשמירתו
                (למשל, רשומות ביקורת בלתי ניתנות לשינוי בהתאם לדרישות רגולטוריות רלוונטיות).
                עם סגירת חשבון וסיום ההתקשרות, נמחק המידע האישי מהמערכות הפעילות שלנו בתוך פרק
                זמן סביר, למעט מידע שאנו מחויבים לשמור על פי דין.
              </p>
            </Section>

            <Section title="8. זכויות המשתמש">
              <p>
                בהתאם לחוק הגנת הפרטיות, התשמ&quot;א-1981, כל אדם שמידע אודותיו מעובד במערכת
                (משתמש רשום או לקוח קצה) זכאי לפנות אלינו בבקשה לעיין במידע המוחזק אודותיו,
                לתקן אותו אם אינו נכון, שלם או מעודכן, או לבקש את מחיקתו, בכפוף לחריגים
                הקבועים בדין. פניות כאמור יש להפנות לעסק שאיתו נוצר הקשר הישיר, או אלינו ישירות
                בפרטי הקשר שבהמשך מסמך זה.
              </p>
            </Section>

            <Section title="9. עוגיות (Cookies)">
              <p>
                אתר הבית של Centro עשוי להשתמש בעוגיות ובטכנולוגיות דומות לצורך תפעול בסיסי של
                האתר, זכירת העדפות תצוגה (כגון הגדרות נגישות) וניתוח שימוש מצרפי. ניתן לחסום
                עוגיות דרך הגדרות הדפדפן, אם כי הדבר עלול לפגוע בתפקוד חלק מהאתר.
              </p>
            </Section>

            <Section title="10. פרטיות קטינים">
              <p>
                השירות מיועד לשימוש עסקי על ידי גורמים בגירים, ואינו מיועד לשימוש על ידי
                קטינים. איננו אוספים במודע מידע אישי המזוהה עם קטינים.
              </p>
            </Section>

            <Section title="11. שינויים במדיניות">
              <p>
                אנו עשויים לעדכן מדיניות זו מעת לעת בהתאם לשינויים בשירות או בדרישות הדין.
                שינויים מהותיים יובאו לידיעת העסקים הרשומים, ותאריך העדכון האחרון יופיע בראש
                מסמך זה.
              </p>
            </Section>

            <Section title="12. יצירת קשר">
              <p>
                לשאלות, בקשות או תלונות בנוגע למדיניות פרטיות זו, ניתן לפנות אלינו בכתובת{" "}
                <a
                  href="mailto:hello@centro.example.com"
                  className="text-brand-purple hover:underline"
                >
                  hello@centro.example.com
                </a>
                .
              </p>
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}
