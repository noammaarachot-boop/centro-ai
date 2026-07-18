# Centro — עמוד נחיתה

עמוד נחיתה שיווקי בעברית (RTL) עבור Centro, העובד הדיגיטלי שאוסף מסמכים
עבור משרדי ראיית חשבון. נבנה עם Next.js (App Router), TypeScript,
Tailwind CSS v4 ו־Framer Motion.

> העמוד הזה הוא **שיווקי בלבד**. אין כאן התחברות, דאשבורד אמיתי, בסיס
> נתונים או אינטגרציות אמיתיות ל־WhatsApp / Gmail / Google Drive — כל מה
> שמוצג הוא הדגמה ויזואלית.

## התקנה והרצה

דרוש Node.js 20+.

```bash
npm install
npm run dev
```

האתר יעלה בכתובת שתודפס בטרמינל (בדרך כלל http://localhost:3000 — אם
התפוסה תפוסה, Next.js יבחר פורט פנוי אחר ויציג אותו בטרמינל).

פקודות נוספות:

```bash
npm run build   # בנייה לפרודקשן + type-check
npm run start   # הרצת הבנייה שנוצרה
npm run lint    # ESLint
```

## מבנה הפרויקט

```
src/
  app/
    layout.tsx        עטיפת RTL, טעינת הפונט, metadata
    page.tsx           מרכיב את כל הסקשנים של העמוד לפי הסדר
    globals.css         טוקני עיצוב (צבעים, גרדיאנטים, צללים, מרווחי אנימציה)
  components/landing/
    Header.tsx                   ניווט צף עם התנהגות גלילה
    Hero.tsx / HeroVisual.tsx     הירו + הכרטיס המרכזי + parallax
    OrbitingIntegrations.tsx      אייקוני האינטגרציות שמקיפים את הכרטיס
    DocumentFlowAnimation.tsx     הלולאה: הודעה → PDF → סריקה → סיווג → דרייב → הושלם
    ProblemSection.tsx            "כאוס" שמתארגן תוך כדי גלילה
    HowItWorksSection.tsx         סיפור מבוסס גלילה (sticky) על 4 השלבים
    AISection.tsx                 הדמיית ניתוח מסמך ע"י AI
    AutomationSection.tsx         ציר זמן אוטומציה
    DashboardPreviewSection.tsx   תצוגה חלקית של לוח הבקרה
    InteractiveDemoSection.tsx    הזמנה להדגמה חיה בתוך העמוד
    TrustSection.tsx              אבטחה, הרשאות ושקיפות + הזמנה לפיילוט
    FAQSection.tsx                שאלות נפוצות
    FinalCTASection.tsx           קריאה לפעולה מסכמת
    Footer.tsx
    icons/IntegrationIcons.tsx    גלייפים ניטרליים ל-WhatsApp / Gmail / Drive / PDF / Excel / AI
  lib/motion.ts          קבועי אנימציה משותפים (easing, duration, variants)
```

## איפה לשנות מה

### טקסטים בעברית
כל טקסט מוגדר ישירות בתוך קומפוננטת ה-TSX הרלוונטית (למשל הכותרת
הראשית ב-`Hero.tsx`, שאלות ב-`FAQSection.tsx`). אין קובץ תרגומים נפרד —
חפשו את המחרוזת הרצויה בקומפוננטה המתאימה מהרשימה למעלה ושנו ישירות.

### צבעים וגרדיאנטים
כל טוקני העיצוב מרוכזים ב-`src/app/globals.css`, בתוך בלוק `@theme
inline`. שינוי ערך שם (למשל `--color-brand-purple`) ישפיע על כל
הקומפוננטות שמשתמשות ב-`bg-brand-purple` / `text-brand-purple` וכו'.
גרדיאנט ההירו/ה-CTA מוגדר תחת `--gradient-hero`.

### תזמוני אנימציה
- אנימציית מסע המסמך בהירו: `STAGE_DURATIONS` בתחילת
  `DocumentFlowAnimation.tsx` (במילישניות).
- מהירות/רדיוס/זווית ההקפה של אייקוני האינטגרציה: `DEFAULT_ITEMS` ב-
  `OrbitingIntegrations.tsx`.
- קבועי easing/duration משותפים לכל שאר הסקשנים: `src/lib/motion.ts`.
- העמוד מכבד `prefers-reduced-motion` באופן גלובלי (`MotionProvider.tsx`
  + `globals.css`) וגם באנימציות המורכבות יותר (הקפה, parallax, סריקה)
  יש נפילה חזרה (fallback) ידנית למצב סטטי/מפושט.

### לוגו
הלוגו הנוכחי הוא Wordmark זמני — אות "C" בריבוע גרדיאנט
(`bg-gradient-to-br from-brand-purple to-brand-blue`), מופיע ב-
`Header.tsx` וב-`Footer.tsx`. להחלפה בלוגו אמיתי: הכניסו קובץ SVG/PNG ל-
`public/` והחליפו את ה-`<span>` עם ה-`C` ברכיב `<Image>` של Next.js.
כדאי גם להחליף את `src/app/favicon.ico`.

### אייקוני אינטגרציה
האייקונים ל-WhatsApp / Gmail / Google Drive / PDF / Excel הם גלייפים
ניטרליים-מבחינה-מותגית (לא לוגואים רשמיים) שנבנו כ-SVG פשוט ב-
`src/components/landing/icons/IntegrationIcons.tsx`. להחלפה בנכסי מותג
רשמיים: הוסיפו את קובצי ה-SVG/PNG הרשמיים ל-`public/integrations/`
ועדכנו את `INTEGRATION_META` באותו קובץ כך שיצביע אליהם (למשל דרך
`next/image`) במקום ל-glyph המצויר.

### חיבור טפסי ה-CTA
בשלב זה כל כפתורי ה-CTA ("בקשו הדגמה", "דברו איתנו" וכו׳) הם קישורי
`<a href="#final-cta">` / `<a href="mailto:...">` — אין טופס אמיתי
ואין שליחה לשרת. כדי לחבר טופס אמיתי בהמשך: הפכו את הכפתור הרלוונטי
(לרוב ב-`FinalCTASection.tsx` או ב-`InteractiveDemoSection.tsx`) לקישור
לטופס חיצוני (Typeform / HubSpot וכו׳), או הוסיפו Route Handler תחת
`src/app/api/` שמקבל את הבקשה ומעבירה למערכת ה-CRM/מייל שלכם.

## נגישות ותנועה מופחתת

- `<html lang="he" dir="rtl">` מוגדר ב-`layout.tsx`.
- ניווט מקלדת מלא, `:focus-visible` גלוי בכל האתר, וקישור "דלגו לתוכן
  הראשי" בראש `page.tsx`.
- `@media (prefers-reduced-motion: reduce)` מטופל הן ב-CSS גלובלי והן
  ברמת קומפוננטה (ראו סעיף "תזמוני אנימציה" למעלה).

## הערות

- לא נעשה שימוש בנתונים/סטטיסטיקות/לקוחות בדויים. כל מספר או ציטוט
  שיוצג בעתיד כ"הוכחה חברתית" אמיתית (`TrustSection.tsx`) צריך להיות
  אמיתי ומאומת.
- בדיקת חוויית משתמש ויזואלית מלאה בדפדפן לא בוצעה בסביבת הפיתוח הזו
  (אין כלי דפדפן/צילום מסך זמין) — האימות שבוצע הוא: `next build`
  (כולל type-check מלא), `eslint`, ו-`next dev` עם בדיקת ה-HTML
  שמוחזר מהשרת. מומלץ לפתוח את האתר בדפדפן ולעבור על הנקודות
  בדרישות המקוריות (breakpoints, אנימציות, RTL) לפני שילוח לפרודקשן.
