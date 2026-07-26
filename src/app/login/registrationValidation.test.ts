import { describe, expect, it } from "vitest";
import { validateRegistrationFields } from "./registrationValidation";

const VALID_FIELDS = {
  fullName: "דנה כהן",
  phone: "0501234567",
  email: "dana@example.com",
  password: "SecurePass123",
  confirmPassword: "SecurePass123",
  termsAccepted: true,
};

describe("validateRegistrationFields", () => {
  it("accepts fully valid fields with terms accepted", () => {
    expect(validateRegistrationFields(VALID_FIELDS)).toBeUndefined();
  });

  it("rejects when terms are not accepted, even if every other field is valid", () => {
    const errors = validateRegistrationFields({ ...VALID_FIELDS, termsAccepted: false });
    expect(errors?.terms).toBeDefined();
    expect(errors?.fullName).toBeUndefined();
    expect(errors?.phone).toBeUndefined();
    expect(errors?.email).toBeUndefined();
    expect(errors?.password).toBeUndefined();
    expect(errors?.confirmPassword).toBeUndefined();
  });

  it("rejects mismatched passwords without flagging terms", () => {
    const errors = validateRegistrationFields({
      ...VALID_FIELDS,
      confirmPassword: "SomethingElse123",
    });
    expect(errors?.confirmPassword).toBe("הסיסמאות אינן תואמות.");
    expect(errors?.terms).toBeUndefined();
    expect(errors?.fullName).toBeUndefined();
    expect(errors?.phone).toBeUndefined();
    expect(errors?.email).toBeUndefined();
  });

  it("rejects a too-short password", () => {
    const errors = validateRegistrationFields({
      ...VALID_FIELDS,
      password: "short",
      confirmPassword: "short",
    });
    expect(errors?.password).toBeDefined();
  });

  it("rejects an invalid email format", () => {
    const errors = validateRegistrationFields({ ...VALID_FIELDS, email: "not-an-email" });
    expect(errors?.email).toBeDefined();
  });

  it("reports every missing/invalid field at once, not just the first", () => {
    const errors = validateRegistrationFields({
      fullName: "",
      phone: "",
      email: "",
      password: "",
      confirmPassword: "",
      termsAccepted: false,
    });
    expect(Object.keys(errors ?? {}).length).toBeGreaterThan(1);
  });
});
