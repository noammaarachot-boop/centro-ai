// Message catalog for the Owner Dashboard only — the rest of the app
// hardcodes Hebrew strings directly in JSX, but this surface is Hebrew-only
// today by product decision, not by architecture, so every owner-facing
// string is sourced from a catalog like this one instead. Adding another
// locale later means adding a sibling file with the same keys, not
// rewriting components (see ../t.ts).
export const he = {
  "owner.login.pageTitle": "התחברות — מסוף בעלים",
  "owner.login.heading": "מסוף בעלים",
  "owner.login.subheading": "גישה פנימית בלבד",
  "owner.login.emailLabel": "אימייל",
  "owner.login.passwordLabel": "סיסמה",
  "owner.login.submit": "התחברות",
  "owner.login.submitPending": "מתחבר/ת...",
  "owner.login.missingFields": "נא להזין אימייל וסיסמה.",
  "owner.login.invalidCredentials": "פרטי ההתחברות שגויים.",
  "owner.login.rateLimited": "יותר מדי ניסיונות התחברות כושלים. נא לנסות שוב בעוד כמה דקות.",
  "owner.shell.title": "מסוף בעלים",
  "owner.shell.logout": "התנתקות",
  "owner.nav.home": "בית",
  "owner.nav.organizations": "ארגונים",
  "owner.home.placeholderTitle": "מסוף הבעלים פעיל",
  "owner.home.placeholderDescription":
    "שלב הבסיס (התחברות והרשאות) הושלם. לוחות המחוונים, החיפוש הגלובלי ומדדי הבריאות יתווספו בשלבים הבאים.",
  "owner.search.placeholder": "חיפוש ארגון, אימייל או טלפון...",

  "owner.organizations.pageTitle": "ארגונים",
  "owner.organizations.pageDescription": "כל הארגונים הרשומים בפלטפורמה.",
  "owner.organizations.searchResultsFor": 'תוצאות חיפוש עבור "{{query}}"',
  "owner.organizations.emptyTitle": "לא נמצאו ארגונים",
  "owner.organizations.emptyDescription": "נסו מונח חיפוש אחר, או נקו את החיפוש כדי לראות את כל הארגונים.",
  "owner.organizations.columns.name": "ארגון",
  "owner.organizations.columns.contact": "פרטי קשר",
  "owner.organizations.columns.workflowType": "סוג תהליך",
  "owner.organizations.columns.onboarding": "קליטה",
  "owner.organizations.columns.integrations": "חיבורים",
  "owner.organizations.columns.createdAt": "תאריך הרשמה",
  "owner.organizations.workflowType.recurring": "מחזורי",
  "owner.organizations.workflowType.oneTime": "חד פעמי",
  "owner.organizations.onboarding.complete": "הושלמה",
  "owner.organizations.onboarding.incomplete": "לא הושלמה",
  "owner.organizations.unnamed": "ארגון ללא שם",

  "owner.orgDetail.backLink": "כל הארגונים",
  "owner.orgDetail.infoTitle": "פרטי ארגון",
  "owner.orgDetail.field.email": "אימייל",
  "owner.orgDetail.field.phone": "טלפון",
  "owner.orgDetail.field.fullName": "איש קשר",
  "owner.orgDetail.field.createdAt": "תאריך הרשמה",
  "owner.orgDetail.field.workflowType": "סוג תהליך",
  "owner.orgDetail.field.businessCategory": "תחום עסקי",
  "owner.orgDetail.field.onboarding": "סטטוס קליטה",
  "owner.orgDetail.field.notProvided": "לא צוין",
  "owner.orgDetail.integrationsTitle": "חיבורים",
  "owner.orgDetail.integration.whatsapp": "WhatsApp",
  "owner.orgDetail.integration.drive": "Google Drive",
  "owner.orgDetail.integration.connectedAt": "מחובר מאז {{date}}",
  "owner.orgDetail.integration.notConnected": "לא מחובר",
  "owner.orgDetail.statsTitle": "נתוני שימוש",
  "owner.orgDetail.stats.clients": "לקוחות",
  "owner.orgDetail.stats.collectionRequests": "בקשות איסוף",
  "owner.orgDetail.stats.openRequests": "בקשות פתוחות",
  "owner.orgDetail.activityTitle": "פעילות אחרונה",
  "owner.orgDetail.activityEmpty": "אין עדיין פעילות רשומה עבור ארגון זה.",
  "owner.orgDetail.notFound": "הארגון לא נמצא.",
} as const;

export type OwnerMessageKey = keyof typeof he;
