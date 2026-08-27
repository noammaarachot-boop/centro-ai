import fs from "node:fs";
const ENV_LINE = /^([A-Z0-9_]+)=(.*)$/;
for (const raw of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = ENV_LINE.exec(raw.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']/, "").replace(/["']$/, "");
}
const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`SELECT name, whatsapp_phone_number_id AS phone, whatsapp_business_account_id AS waba,
  whatsapp_webhook_override_at AS override_at,
  (whatsapp_webhook_verify_token IS NOT NULL) AS has_verify_token,
  whatsapp_connected_at, whatsapp_health_ok, whatsapp_health_reason
  FROM organizations WHERE whatsapp_phone_number_id IS NOT NULL ORDER BY name`;
for (const r of rows) {
  console.log(`\n${r.name}`);
  console.log(`  phone=${r.phone} waba=${r.waba}`);

  console.log(`  override set at     : ${r.override_at?.toISOString() ?? "never"}`);
  console.log(`  own verify token    : ${r.has_verify_token}`);
  console.log(`  connected_at=${r.whatsapp_connected_at?.toISOString()} health_ok=${r.whatsapp_health_ok} reason=${r.whatsapp_health_reason ?? "-"}`);
}
await sql.end();
