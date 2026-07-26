import type { RegisterState } from "./actions";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

export interface RegistrationFields {
  fullName: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
  termsAccepted: boolean;
}

export function validateRegistrationFields(
  fields: RegistrationFields
): RegisterState["fieldErrors"] | undefined {
  const fieldErrors: RegisterState["fieldErrors"] = {};
  if (!fields.fullName) fieldErrors.fullName = "נא להזין שם מלא.";
  if (!fields.phone) fieldErrors.phone = "נא להזין מספר טלפון.";
  if (!fields.email) {
    fieldErrors.email = "נא להזין כתובת אימייל.";
  } else if (!EMAIL_PATTERN.test(fields.email)) {
    fieldErrors.email = "נא להזין כתובת אימייל תקינה.";
  }
  if (!fields.password) {
    fieldErrors.password = "נא להזין סיסמה.";
  } else if (fields.password.length < MIN_PASSWORD_LENGTH) {
    fieldErrors.password = `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים.`;
  }
  if (!fields.confirmPassword) {
    fieldErrors.confirmPassword = "נא לאמת את הסיסמה.";
  } else if (fields.password !== fields.confirmPassword) {
    fieldErrors.confirmPassword = "הסיסמאות אינן תואמות.";
  }
  if (!fields.termsAccepted) {
    fieldErrors.terms = "יש לאשר את תנאי השימוש ואת מדיניות הפרטיות.";
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}
