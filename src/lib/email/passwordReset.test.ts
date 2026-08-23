import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn((...args: unknown[]) => {
  void args;
  return { sendMail };
});
vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

const { sendPasswordResetEmail } = await import("./passwordReset");

describe("sendPasswordResetEmail", () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: "mock" });
    createTransport.mockClear();
    process.env.GMAIL_USER = "centro.test@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "app-password";
  });

  it("sends the reset link to the given email via Gmail SMTP", async () => {
    await sendPasswordResetEmail("employee@example.com", "https://www.centro-ai.co.il/reset-password?token=abc123");

    expect(createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: { user: "centro.test@gmail.com", pass: "app-password" },
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe("employee@example.com");
    expect(call.html).toContain("https://www.centro-ai.co.il/reset-password?token=abc123");
    expect(call.text).toContain("https://www.centro-ai.co.il/reset-password?token=abc123");
  });

  // These two previously asserted the opposite — that failures are swallowed
  // and the function resolves normally. That was the bug: the forgot-password
  // action then told a locked-out user "check your inbox" while nothing had
  // been sent, and they had no other way back into the account. Reporting the
  // truth here is what lets the action decide what the user is told; the
  // anti-enumeration property it was protecting now lives there instead
  // (see forgotPassword.test.ts).
  it("THROWS when GMAIL_USER/GMAIL_APP_PASSWORD are not configured", async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;

    await expect(
      sendPasswordResetEmail("employee@example.com", "https://example.com/reset")
    ).rejects.toThrow(/not configured/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("THROWS when the Gmail send itself fails, even after retries are exhausted", async () => {
    sendMail.mockRejectedValue(new Error("SMTP timeout"));

    await expect(
      sendPasswordResetEmail("employee@example.com", "https://example.com/reset")
    ).rejects.toThrow();
  }, 10_000);

  it("never includes the reset URL in the function's own return value", async () => {
    const result = await sendPasswordResetEmail("employee@example.com", "https://example.com/reset");
    expect(result).toBeUndefined();
  });
});
