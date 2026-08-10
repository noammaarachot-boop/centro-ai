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

  it("never throws when GMAIL_USER/GMAIL_APP_PASSWORD are not configured — logs and returns", async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;

    await expect(sendPasswordResetEmail("employee@example.com", "https://example.com/reset")).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("never throws when the Gmail send itself fails, even after retries are exhausted", async () => {
    sendMail.mockRejectedValue(new Error("SMTP timeout"));

    await expect(sendPasswordResetEmail("employee@example.com", "https://example.com/reset")).resolves.toBeUndefined();
  }, 10_000);

  it("never includes the reset URL in the function's own return value", async () => {
    const result = await sendPasswordResetEmail("employee@example.com", "https://example.com/reset");
    expect(result).toBeUndefined();
  });
});
