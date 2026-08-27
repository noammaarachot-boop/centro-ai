/**
 * Seeds one collection request with a conversation, for the responsive
 * smoke test to exercise /collections/[id].
 *
 * Deliberately adversarial about text: a very long unbroken URL and a long
 * message are the two things that break a chat layout, and neither can be
 * produced by clicking around the UI. Everything is written to the
 * throwaway E2E database only — never production.
 */
import postgres from "postgres";

const LONG_URL =
  "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz9876543210/view?usp=sharing&authuser=0&resourcekey=0-AbCdEfGhIjKlMnOpQrStUv";

const LONG_TEXT =
  "שלום, רציתי לעדכן שאספתי את כל המסמכים שביקשתם אבל חלק מהם נמצאים אצל רואה החשבון הקודם ואני מנסה להשיג אותם כבר שבועיים, " +
  "בנוסף יש לי שאלה לגבי הדוח השנתי — האם צריך גם את הנספחים או שמספיק הדוח עצמו? " +
  "אשמח לתשובה כי אני רוצה לסגור את זה השבוע ולא להתעכב יותר. תודה רבה על הסבלנות.";

export async function seedConversation(databaseUrl) {
  if (/neon\.tech/i.test(databaseUrl)) throw new Error("refusing: production host");
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Attach to whatever organization the registered test account created,
    // so the seeded request is visible to that session.
    const [org] = await sql`select id from organizations order by created_at desc limit 1`;
    if (!org) throw new Error("no organization found — register step must run first");

    // Put the org in the post-onboarding state. This does not bypass the
    // redirect — the guard still runs and still enforces the rule; the
    // fixture just satisfies it, which is what a real account would do by
    // finishing the wizard.
    await sql`update organizations set onboarding_completed_at = now(),
              document_collection_enabled = true where id = ${org.id}`;

    const [client] = await sql`
      insert into clients (organization_id, name, phone)
      values (${org.id}, ${"לקוח בדיקה עם שם ארוך במיוחד לבדיקת גלישה"}, ${"+972500000999"})
      returning id`;

    const [service] = await sql`
      insert into services (organization_id, name)
      values (${org.id}, ${"שירות בדיקה"}) returning id`;

    const [request] = await sql`
      insert into collection_requests (organization_id, client_id, service_id, period_label, status)
      values (${org.id}, ${client.id}, ${service.id}, ${"2026-Q1"}, ${"active"})
      returning id`;

    await sql`
      insert into collection_request_requirements (collection_request_id, name)
      values (${request.id}, ${"תעודת זהות"}), (${request.id}, ${"אישור ניהול ספרים"})`;

    const [conversation] = await sql`
      insert into conversations (organization_id, client_id, collection_request_id, status)
      values (${org.id}, ${client.id}, ${request.id}, ${"open"})
      returning id`;

    const messages = [
      ["outbound", "system", "שלום, נשמח לקבל את המסמכים לרבעון הראשון."],
      ["inbound", "client", LONG_TEXT],
      ["outbound", "ai", `אפשר להעלות כאן: ${LONG_URL}`],
      ["inbound", "client", LONG_URL],
      // A long thread, so the conversation area has something to scroll.
      // With only a handful of messages the container never overflows and
      // "scrolling works" / "opens at the latest message" would both pass
      // without ever exercising a scroll.
      ...Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? ["outbound", "ai", `תזכורת ${i / 2 + 1}: עדיין ממתינים למסמכים.`]
          : ["inbound", "client", `בסדר, אשלח בקרוב (${(i + 1) / 2}).`]
      ),
      // Must end up visible without scrolling: the container opens at the
      // bottom, and this is the newest message.
      ["outbound", "employee", "תודה, בדקנו ונחזור אליך."],
    ];
    for (const [direction, senderType, body] of messages) {
      await sql`
        insert into messages (organization_id, conversation_id, direction, sender_type, body, delivery_status)
        values (${org.id}, ${conversation.id}, ${direction}, ${senderType}, ${body}, ${"sent"})`;
    }

    // A few activity rows so the timeline is not empty, including one with a
    // long description.
    for (const [eventType, description] of [
      ["collection_request.created", "בקשת האיסוף נוצרה"],
      ["document.received", "התקבל מסמך חדש מהלקוח והועבר לסיווג אוטומטי לפי סוג המסמך והתאמה לדרישות הבקשה"],
      ["conversation.human_takeover", "השיחה הועברה לטיפול אנושי"],
    ]) {
      await sql`
        insert into audit_logs (organization_id, collection_request_id, event_type, actor_type, description)
        values (${org.id}, ${request.id}, ${eventType}, ${"system"}, ${description})`;
    }

    return { requestId: request.id, conversationId: conversation.id, organizationId: org.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
