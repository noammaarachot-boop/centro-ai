import { PRODUCTION_ORIGIN } from "@/lib/whatsapp/webhookUrls";

// The "everything is ready" email an office owner gets once Meta approves
// their WhatsApp templates.
//
// The call to action goes to the REAL flow for starting a collection
// request (/collections/new, the wizard). That page is guarded by
// requireSession(), which already redirects to /login and back — so no
// separate auth flow is invented here.
//
// The origin is the project's single existing constant rather than a
// second hardcoded copy; there is no APP_URL env in this project.
export const START_COLLECTING_URL = `${PRODUCTION_ORIGIN}/collections/new`;

export const TEMPLATES_APPROVED_SUBJECT = "🎉 מזל טוב! התבניות שלך אושרו";

// Table-based layout with inline styles: the only thing that renders
// reliably across Gmail, Outlook and mobile clients, none of which support
// modern CSS. dir="rtl" is set on the elements themselves for the same
// reason — a <style> block would be stripped by several clients.
export function renderTemplatesApprovedEmail(): { html: string; text: string } {
  const html = `<!doctype html>
<html dir="rtl" lang="he">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${TEMPLATES_APPROVED_SUBJECT}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f3f7;">
    <!-- Preview text: what the inbox shows next to the subject. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      תבניות ה-WhatsApp שלך אושרו ב-Meta — אפשר להתחיל לאסוף מסמכים.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background-color:#f4f3f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 dir="rtl"
                 style="max-width:560px;background-color:#ffffff;border-radius:16px;overflow:hidden;
                        font-family:'Segoe UI',Arial,Helvetica,sans-serif;">

            <!-- Celebratory header, kept to one restrained band of colour. -->
            <tr>
              <td align="center" style="background-color:#6b4ce6;padding:36px 24px 30px;">
                <div style="font-size:44px;line-height:1;">🎉</div>
                <h1 style="margin:14px 0 0;color:#ffffff;font-size:24px;font-weight:700;">
                  מזל טוב! התבניות שלך אושרו
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:32px 32px 8px;" dir="rtl">
                <p style="margin:0 0 18px;color:#16151c;font-size:18px;font-weight:700;line-height:1.6;">
                  מזל טוב! 🎉
                </p>
                <p style="margin:0 0 16px;color:#423e4f;font-size:16px;line-height:1.75;">
                  תבניות ה-WhatsApp שלך אושרו ב-Meta.
                </p>
                <p style="margin:0 0 16px;color:#423e4f;font-size:16px;line-height:1.75;">
                  הכול מוכן — עכשיו אפשר להתחיל לאסוף מסמכים עם Centro.
                </p>
                <p style="margin:0 0 16px;color:#423e4f;font-size:16px;line-height:1.75;">
                  מהרגע הזה Centro יכולה לנהל עבורך את תהליך איסוף המסמכים, לשלוח תזכורות
                  ולעקוב אחר המסמכים החסרים באופן אוטומטי.
                </p>
                <p style="margin:0 0 28px;color:#423e4f;font-size:16px;line-height:1.75;">
                  נשאר רק להתחיל 🚀
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:0 32px 32px;">
                <!-- Bulletproof-ish button: a padded anchor, which every
                     major client renders correctly. -->
                <a href="${START_COLLECTING_URL}"
                   style="display:inline-block;background-color:#6b4ce6;color:#ffffff;
                          text-decoration:none;font-size:16px;font-weight:700;
                          padding:14px 34px;border-radius:999px;">
                  התחילו לאסוף מסמכים
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px 32px;" dir="rtl">
                <p style="margin:0;color:#423e4f;font-size:16px;line-height:1.75;">
                  בהצלחה,<br />
                  צוות Centro
                </p>
              </td>
            </tr>

            <tr>
              <td style="background-color:#faf9fc;padding:18px 32px;border-top:1px solid #e4e1ea;" dir="rtl">
                <p style="margin:0;color:#6e6a7a;font-size:12px;line-height:1.6;">
                  הודעה זו נשלחה אוטומטית מ-Centro.
                  אם הכפתור אינו עובד, אפשר להעתיק את הקישור:
                  <br />
                  <span style="color:#6b4ce6;" dir="ltr">${START_COLLECTING_URL}</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "מזל טוב! 🎉",
    "",
    "תבניות ה-WhatsApp שלך אושרו ב-Meta.",
    "",
    "הכול מוכן — עכשיו אפשר להתחיל לאסוף מסמכים עם Centro.",
    "",
    "מהרגע הזה Centro יכולה לנהל עבורך את תהליך איסוף המסמכים, לשלוח תזכורות ולעקוב אחר המסמכים החסרים באופן אוטומטי.",
    "",
    "נשאר רק להתחיל 🚀",
    "",
    `התחילו לאסוף מסמכים: ${START_COLLECTING_URL}`,
    "",
    "בהצלחה,",
    "צוות Centro",
  ].join("\n");

  return { html, text };
}
