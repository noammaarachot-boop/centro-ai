import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn((...args: unknown[]) => {
  void args;
  return { sendMail };
});
vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

const { sendSupportRequestEmail } = await import("./supportRequest");

const BASE_INPUT = {
  ticketNumber: 42,
  organizationId: "org-1",
  organizationName: "עסק לדוגמה",
  userId: "user-1",
  userName: "ישראל ישראלי",
  userEmail: "israel@example.com",
  category: "not_working",
  subject: "המערכת לא שולחת תזכורות",
  message: "ניסיתי אתמול ולא קרה כלום.",
  currentPage: "/dashboard",
  timezone: "Asia/Jerusalem",
  createdAt: new Date("2026-01-01T10:00:00Z"),
};

describe("sendSupportRequestEmail", () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: "mock" });
    createTransport.mockClear();
    process.env.GMAIL_USER = "centro.test@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "app-password";
    delete process.env.CONTACT_EMAIL_TO;
  });

  it("sends via Gmail SMTP to CONTACT_EMAIL_TO, including the ticket number and message", async () => {
    process.env.CONTACT_EMAIL_TO = "support-inbox@example.com";

    await sendSupportRequestEmail(BASE_INPUT);

    expect(createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: { user: "centro.test@gmail.com", pass: "app-password" },
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe("support-inbox@example.com");
    expect(call.replyTo).toBe("israel@example.com");
    expect(call.subject).toContain("#42");
    expect(call.html).toContain("#42");
    expect(call.html).toContain("ניסיתי אתמול ולא קרה כלום.");
    expect(call.text).toContain("ניסיתי אתמול ולא קרה כלום.");
  });

  it("falls back to Centro.ai.team@gmail.com when CONTACT_EMAIL_TO is unset", async () => {
    await sendSupportRequestEmail(BASE_INPUT);
    expect(sendMail.mock.calls[0][0].to).toBe("Centro.ai.team@gmail.com");
  });

  it("throws when GMAIL_USER/GMAIL_APP_PASSWORD are not configured — caller must know delivery didn't happen", async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;

    await expect(sendSupportRequestEmail(BASE_INPUT)).rejects.toThrow();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("throws (does not swallow) when the Gmail send fails, even after retries are exhausted", async () => {
    sendMail.mockRejectedValue(new Error("SMTP timeout"));

    await expect(sendSupportRequestEmail(BASE_INPUT)).rejects.toThrow();
  }, 10_000);

  it("HTML-escapes user-supplied subject/message to prevent HTML injection into the email body", async () => {
    await sendSupportRequestEmail({
      ...BASE_INPUT,
      subject: "<img src=x onerror=alert(1)>",
      message: "<script>alert('xss')</script>",
    });

    const html = sendMail.mock.calls[0][0].html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});
