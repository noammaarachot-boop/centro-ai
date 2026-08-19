// Split out of src/lib/integrationRequirements.ts so this exact,
// product-approved copy can be imported from a Client Component (the
// Collection Requests wizard's Review step) without dragging that file's
// server-only dependencies (DB access, Google token refresh) into the
// browser bundle. integrationRequirements.ts re-exports these two for
// every existing server-side caller, so nothing else needs to change.
export const WHATSAPP_NOT_READY_MESSAGE =
  "לא ניתן להתחיל את האיסוף. חיבור ה-WhatsApp אינו פעיל. יש לחבר מחדש את WhatsApp כדי להתחיל.";
export const DRIVE_NOT_READY_MESSAGE =
  "לא ניתן להתחיל את האיסוף. חיבור ה-Google Drive אינו פעיל. יש לחבר מחדש את Google Drive כדי להתחיל.";
