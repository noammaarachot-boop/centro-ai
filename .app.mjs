import fs from "node:fs";
const ENV_LINE = /^([A-Z0-9_]+)=(.*)$/;
for (const raw of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = ENV_LINE.exec(raw.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']/, "").replace(/["']$/, "");
}
const APP_ID = "1043370264820423";
const APP_TOKEN = `${APP_ID}|${process.env.WHATSAPP_APP_SECRET}`;
const BASE = "https://graph.facebook.com/v21.0";

async function get(label, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", APP_TOKEN);
  const res = await fetch(url);
  const body = await res.json();
  console.log(`\n--- ${label}  HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));
  return body;
}

await get("app subscriptions", `/${APP_ID}/subscriptions`);
await get("WABA subscribed_apps (נועם מערכות)", "/424832370712462/subscribed_apps");
await get("phone webhook_configuration (נועם מערכות)", "/436563892876866", {
  fields: "id,display_phone_number,webhook_configuration",
});
