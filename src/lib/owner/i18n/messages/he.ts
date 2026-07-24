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
  "owner.home.title": "בית",
  "owner.home.placeholderTitle": "מסוף הבעלים פעיל",
  "owner.home.placeholderDescription":
    "שלב הבסיס (התחברות והרשאות) הושלם. לוחות המחוונים, החיפוש הגלובלי ומדדי הבריאות יתווספו בשלבים הבאים.",
} as const;

export type OwnerMessageKey = keyof typeof he;
