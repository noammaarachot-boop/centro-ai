/**
 * Runtime responsive/RTL smoke test.
 *
 * Registers a real account through the real registration flow against an
 * isolated throwaway database — no auth bypass, no faked production
 * behaviour, no production data. Then measures real layout in a real
 * browser at each viewport.
 *
 * Deliberately does NOT send a message to a client: the composer is checked
 * for layout only.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { startEnvironment, stopEnvironment, BASE_URL, DATABASE_URL } from "./responsive-env.mjs";
import { seedConversation } from "./seed-conversation.mjs";

const SHOTS = path.join(process.cwd(), "e2e", "screenshots");

const VIEWPORTS = [
  { name: "320", width: 320, height: 720 },
  { name: "375", width: 375, height: 812 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];

const results = [];
const record = (viewport, screen, check, status, detail = "") => {
  results.push({ viewport, screen, check, status, detail });
  if (status !== "PASS") console.log(`   ${status}  [${viewport}] ${screen} — ${check}${detail ? `: ${detail}` : ""}`);
};

/** Page-level horizontal overflow. */
async function checkOverflow(page, viewport, screen) {
  const r = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  const overflow = r.scrollWidth - r.clientWidth;
  record(viewport, screen, "no horizontal page overflow", overflow <= 1 ? "PASS" : "FAIL",
    overflow > 1 ? `scrollWidth ${r.scrollWidth} > clientWidth ${r.clientWidth} (+${overflow}px)` : "");
  return overflow <= 1;
}

/**
 * Any element whose box escapes the viewport horizontally.
 *
 * Two exclusions, both because the element genuinely cannot reach the user
 * as horizontal scroll — NOT to make the numbers look better:
 *
 *  • Inside a scroll container. A wide table deliberately placed in
 *    `overflow-x-auto` is the design working: it scrolls within its own
 *    box and the page does not move. This suite reported exactly that as a
 *    page-level failure on /clients at four viewports. The container
 *    itself is still checked — if IT escapes, that is a real bug.
 *  • Inside a `position: fixed` subtree. A fixed element is laid out
 *    against the viewport, so it contributes nothing to the document's
 *    scrollable width; only the fixed root's own box matters, and that is
 *    still measured because the walk starts at it.
 *
 * Neither exclusion can hide a real page overflow: checkOverflow() above
 * measures document scrollWidth directly and is not filtered at all.
 */
async function checkEscapingElements(page, viewport, screen) {
  const escaping = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.position === "fixed") continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.right <= vw + 1 && b.left >= -1) continue;

      let contained = null;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX !== "visible") { contained = `scroll container <${p.tagName.toLowerCase()} class="${String(p.className || "").slice(0, 40)}">`; break; }
        if (ps.position === "fixed") { contained = "fixed-position subtree"; break; }
      }
      if (contained) continue;

      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 60),
        left: Math.round(b.left), right: Math.round(b.right), vw,
      });
    }
    return out.slice(0, 5);
  });
  record(viewport, screen, "no element escapes the viewport", escaping.length === 0 ? "PASS" : "FAIL",
    escaping.length ? JSON.stringify(escaping[0]) : "");
  return escaping;
}

/**
 * A horizontal scroll container must not itself overflow the viewport, and
 * must actually be scrollable when its content is wider than it is.
 *
 * This is the assertion that replaces what the false positive above was
 * accidentally covering: the point was never "no element is ever wider than
 * the screen", it was "wide content is reachable without moving the page".
 */
async function checkScrollContainers(page, viewport, screen) {
  const bad = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      if (s.overflowX !== "auto" && s.overflowX !== "scroll") continue;
      // Only containers that actually scroll horizontally. Setting either
      // axis to something other than `visible` computes the OTHER axis to
      // `auto`, so `overflow-y-auto` alone matched here — which flagged
      // every vertically-scrolling panel in the app, starting with the
      // sidebar's own nav list.
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      // Fixed subtrees are positioned against the viewport, not the page,
      // and the off-canvas sidebar is deliberately parked outside it while
      // closed. Same exclusion as checkEscapingElements, same reason.
      let fixed = s.position === "fixed";
      for (let p = el.parentElement; p && !fixed && p !== document.documentElement; p = p.parentElement) {
        if (getComputedStyle(p).position === "fixed") fixed = true;
      }
      if (fixed) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.right > vw + 1 || b.left < -1) {
        out.push({ why: "container escapes viewport", cls: String(el.className || "").slice(0, 60), left: Math.round(b.left), right: Math.round(b.right), vw });
      }
    }
    return out;
  });
  record(viewport, screen, "scroll containers stay inside the viewport", bad.length === 0 ? "PASS" : "FAIL",
    bad.length ? JSON.stringify(bad[0]) : "");
}

/** Interactive controls large enough to tap. */
async function checkTouchTargets(page, viewport, screen) {
  if (Number(viewport) > 500) return;
  // Classified rather than counted: an inline link inside a sentence is not
  // the same problem as a real control that is hard to hit, and inflating
  // body text to 44px would damage the typography to fix a non-issue.
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll("button, a[href], input[type=submit], [role=button]"))) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height >= 32) continue;

      const text = (el.textContent || "").trim();
      // Inline text link: an <a> sitting inside a paragraph/sentence.
      const parentTag = el.parentElement?.tagName.toLowerCase() ?? "";
      const inlineParent = ["p", "span", "label", "li", "small"].includes(parentTag);
      const kind =
        el.tagName === "A" && inlineParent ? "inline-text-link"
        : el.tagName === "A" ? "link"
        : el.querySelector("svg") && !text ? "icon-button"
        : text ? "control" : "unlabelled";
      out.push({ kind, h: Math.round(b.height), w: Math.round(b.width), text: text.slice(0, 24) });
    }
    return out;
  });
  const real = small.filter((s) => s.kind === "control" || s.kind === "icon-button");
  const byKind = small.reduce((a, s) => ((a[s.kind] = (a[s.kind] || 0) + 1), a), {});
  record(viewport, screen, "no real control below 32px", real.length === 0 ? "PASS" : "WARN",
    small.length ? `${JSON.stringify(byKind)}${real.length ? ` first-real=${JSON.stringify(real[0])}` : ""}` : "");
}

/**
 * Exactly one <main> landmark per page.
 *
 * Regression: the collection-request wizard rendered its own <main> while
 * already inside (app)/layout.tsx's, so /collections/new shipped two "main"
 * landmarks — invalid HTML, and an ambiguous destination for a screen
 * reader's jump-to-main. Cheap to check, and it holds for every screen,
 * so it runs on all of them rather than only the one that broke.
 */
async function checkSingleMain(page, viewport, screen) {
  const mains = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main")).map((m) => String(m.className || "").slice(0, 50))
  );
  record(viewport, screen, "exactly one <main> landmark", mains.length === 1 ? "PASS" : "FAIL",
    mains.length === 1 ? "" : `${mains.length} found: ${JSON.stringify(mains)}`);
}

/**
 * The conversation must be ONE continuous scroll unit.
 *
 * It used to be two: the history lived in a `max-h-64 overflow-y-auto` box
 * and the three newest messages sat in a separate list outside it. Scrolling
 * the inner box moved the history while those three stayed put, so the
 * newest messages looked pinned to the page.
 *
 * Measured in the browser rather than asserted against the source, because
 * what matters is the computed style of the real ancestor chain — a nested
 * scroller can reappear from any utility class, not just the one removed.
 */
async function checkConversationScroll(page, viewport, screen) {
  const result = await page.evaluate(() => {
    const anchor = document.getElementById("conversation");
    if (!anchor) return { skipped: true };
    const bubbles = [...anchor.querySelectorAll("li")];
    if (bubbles.length === 0) return { skipped: true };

    // The nearest scrollable ancestor of each bubble. Every message must
    // resolve to the SAME one — the split that put the newest three outside
    // the scroller showed up here as two distinct answers (and as `null`,
    // meaning "the page itself", for those three).
    const owners = [];
    const pinned = [];
    let box = null;
    for (const bubble of bubbles) {
      const own = getComputedStyle(bubble).position;
      if (own === "sticky" || own === "fixed") pinned.push(`li[position:${own}]`);
      let owner = "page";
      for (let el = bubble.parentElement; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.position === "sticky" || s.position === "fixed") pinned.push(`<${el.tagName.toLowerCase()} position:${s.position}>`);
        if (owner === "page" && (s.overflowY === "auto" || s.overflowY === "scroll")) {
          owner = `<${el.tagName.toLowerCase()} class="${String(el.className || "").slice(0, 40)}">`;
          box = { h: el.clientHeight, scrollH: el.scrollHeight, top: el.scrollTop };
        }
      }
      owners.push(owner);
    }
    return {
      skipped: false,
      count: bubbles.length,
      owners: [...new Set(owners)],
      pinned: [...new Set(pinned)],
      box,
      pageHeight: document.documentElement.scrollHeight,
    };
  });

  if (result.skipped) {
    record(viewport, screen, "conversation is one scroll container", "NOT TESTED", "no messages rendered");
    return;
  }

  // Exactly one owner, and it must not be the page: that is what "bounded
  // region with internal scrolling" means, and "page" would mean the whole
  // history is stretching the request page again.
  const single = result.owners.length === 1 && result.owners[0] !== "page";
  record(viewport, screen, "conversation is one scroll container", single ? "PASS" : "FAIL",
    single ? "" : `message scroll owners: ${result.owners.join(" | ")}`);

  record(viewport, screen, "no message is pinned while the rest scrolls",
    result.pinned.length === 0 ? "PASS" : "FAIL",
    result.pinned.length ? `pinned: ${result.pinned.join(", ")}` : "");

  // The whole point of restoring the box: the thread must not set the page's
  // height. Allow generous headroom — this only has to catch "unbounded".
  const bounded = result.box && result.box.h <= Math.max(560, Math.round(window_innerHeightFallback(viewport)));
  record(viewport, screen, "conversation height is bounded", bounded ? "PASS" : "FAIL",
    result.box ? `container ${result.box.h}px, content ${result.box.scrollH}px` : "no scroll container found");
}

/** Viewport heights used by the harness are not exposed here; 900 is the tallest. */
function window_innerHeightFallback() { return 900; }

/**
 * Opening the conversation must show the NEWEST messages, not the oldest.
 */
async function checkConversationStartsAtLatest(page, viewport, screen) {
  const r = await page.evaluate(() => {
    const anchor = document.getElementById("conversation");
    const bubble = anchor?.querySelector("li");
    if (!bubble) return { skipped: true };
    for (let el = bubble.parentElement; el && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflowY === "auto" || s.overflowY === "scroll") {
        return { skipped: false, scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
      }
    }
    return { skipped: true };
  });
  if (r.skipped) {
    record(viewport, screen, "conversation opens at the latest message", "NOT TESTED", "no scroll container");
    return;
  }
  // Nothing to scroll is also "already at the latest".
  const atBottom = r.max <= 1 || r.scrollTop >= r.max - 4;
  record(viewport, screen, "conversation opens at the latest message", atBottom ? "PASS" : "FAIL",
    atBottom ? "" : `scrollTop ${r.scrollTop} of ${r.max}`);
}

async function checkConversationContrast(page, viewport, screen) {
  const result = await page.evaluate(() => {
    const anchor = document.getElementById("conversation");
    if (!anchor) return { skipped: true };
    const bubbles = [...anchor.querySelectorAll("li")];
    // Outbound bubbles are pushed to the inline end, inbound to the start.
    const groups = { start: null, end: null };
    for (const b of bubbles) {
      const s = getComputedStyle(b);
      const side = s.marginInlineStart === "0px" ? "start" : "end";
      groups[side] = groups[side] ?? s.backgroundColor;
    }
    if (!groups.start || !groups.end) return { skipped: true };
    return { skipped: false, ...groups };
  });

  if (result.skipped) {
    record(viewport, screen, "client and office messages look different", "NOT TESTED", "only one side present");
    return;
  }
  record(
    viewport,
    screen,
    "client and office messages look different",
    result.start !== result.end ? "PASS" : "FAIL",
    result.start === result.end ? `both sides are ${result.start}` : `${result.start} vs ${result.end}`
  );
}

async function shoot(page, viewport, screen) {
  await fs.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${screen}-${viewport}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function visit(page, url, viewport, screen, { shots = true, expectPath = url } = {}) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(250);

  // Assert we are on the page we asked for. Twice this suite scored a
  // redirect target (/login, then /onboarding) under the requested screen's
  // name: overflow and RTL pass on any page, so the wrong screen looked
  // green. `expectPath` is for the one route that is SUPPOSED to land
  // somewhere else — /register is a redirect to /login?mode=register, which
  // is the register surface, so measuring it there is measuring the right
  // screen, not accepting a wrong one.
  const landedPath = new URL(page.url()).pathname;
  if (landedPath !== expectPath) {
    record(viewport, screen, "reached the requested screen", "FAIL", `landed on ${landedPath}, expected ${expectPath}`);
    return false;
  }
  record(viewport, screen, "reached the requested screen", "PASS");
  await checkOverflow(page, viewport, screen);
  await checkEscapingElements(page, viewport, screen);
  await checkScrollContainers(page, viewport, screen);
  await checkSingleMain(page, viewport, screen);
  await checkTouchTargets(page, viewport, screen);
  const dir = await page.evaluate(() => document.documentElement.dir || getComputedStyle(document.documentElement).direction);
  record(viewport, screen, "RTL direction is applied", dir === "rtl" ? "PASS" : "FAIL", dir);
  if (shots) await shoot(page, viewport, screen);
  return true;
}

const shots = [];

/** Registers one real account through the real /register flow. */
async function registerAccount(browser, label) {
  const setup = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "he-IL" });
  const account = {
    email: `qa-${label}-${Date.now()}@example.com`,
    password: "QaPassword!2026",
    name: "בודק אוטומטי",
  };
  await setup.goto(`${BASE_URL}/register`, { waitUntil: "networkidle" });
  const fill = async (sel, val) => { const el = setup.locator(sel).first(); if (await el.count()) await el.fill(val); };
  await fill('input[name="fullName"]', account.name);
  await fill('input[name="phone"]', "0501234567");
  await fill('input[name="email"]', account.email);
  await fill('input[name="password"]', account.password);
  await fill('input[name="confirmPassword"]', account.password);
  const terms = setup.locator('input[name="termsAccepted"]').first();
  if (await terms.count()) await terms.check().catch(() => {});

  // Scoped to the form that actually holds the registration fields. The
  // page renders login and register as tabs, so a bare
  // button[type=submit] matched the login tab's button and navigated away
  // — which is what silently produced a session-less run whose every
  // "authenticated" screen was really the login page.
  const form = setup.locator('form:has(input[name="confirmPassword"])').first();
  await form.locator('button[type="submit"]').first().click();
  await setup.waitForLoadState("networkidle").catch(() => {});
  await setup.waitForTimeout(2000);

  const landed = new URL(setup.url()).pathname;
  const storage = await setup.context().storageState();
  // Surface whatever the form is complaining about, instead of guessing.
  const formError = (await setup.locator('[role="alert"], .text-danger').allTextContents().catch(() => []))
    .filter(Boolean);
  console.log(`   [${label}] after register: ${landed} | cookies: ${storage.cookies.length}`);
  if (formError.length) console.log("   form errors:", formError.join(" | ").slice(0, 200));
  await setup.close();

  // Fail loudly. A session-less run measures the login page eleven times
  // and reports it as eleven different screens — the failure mode that
  // produced 70 meaningless failures and hid the real coverage gap.
  if (storage.cookies.length === 0) {
    throw new Error(
      `Registration did not establish a session (landed on ${landed}). ` +
        `Refusing to run: every authenticated screen would silently be the login page. ` +
        `Form errors: ${formError.join(" | ") || "(none reported)"}`
    );
  }
  return { account, storage, landed };
}

/**
 * Asserts a route redirects where it is supposed to.
 *
 * A redirect used to be scored NOT TESTED and left there, which turned
 * correct, deliberate behaviour ("a signed-in user asking for /login is sent
 * to the dashboard") into a permanent hole in the report. The redirect IS
 * the product behaviour, so it gets asserted like any other.
 */
async function expectRedirect(page, from, to, viewport, screen) {
  await page.goto(`${BASE_URL}${from}`, { waitUntil: "networkidle", timeout: 45_000 });
  const landed = new URL(page.url()).pathname;
  record(viewport, screen, `${from} redirects to ${to}`, landed === to ? "PASS" : "FAIL",
    landed === to ? "" : `landed on ${landed}`);
}

async function main() {
  await startEnvironment();
  const browser = await chromium.launch();

  try {
    // ── register real accounts through the real flow (isolated DB) ──
    console.log("\nRegistering test accounts through the real /register flow…");
    // The main account: seeded below, which also completes its onboarding.
    const { storage } = await registerAccount(browser, "main");

    // Seed a request with a conversation: long unbroken URLs and long
    // messages are the two things that break a chat layout, and neither can
    // be produced by clicking through the UI. seedConversation() attaches to
    // the most recently created organization, so it must run before the
    // second account exists.
    let seeded = null;
    try {
      seeded = await seedConversation(DATABASE_URL);
      console.log("   seeded collection request:", seeded.requestId);
    } catch (e) {
      console.log("   SEED FAILED:", e.message);
    }

    // A second account, deliberately left mid-onboarding. The seeding above
    // marks the first org's onboarding complete (as finishing the wizard
    // would), so /onboarding correctly bounces it to /dashboard — which is
    // why that screen went untested at all seven viewports. This account is
    // never seeded and never clicked through, so it stays a real, honest
    // fixture for the onboarding layout.
    const { storage: onboardingStorage } = await registerAccount(browser, "onboarding");

    // ── per-viewport sweep ──
    for (const vp of VIEWPORTS) {
      console.log(`\n── viewport ${vp.name}px`);
      const contextOptions = {
        viewport: { width: vp.width, height: vp.height },
        locale: "he-IL",
        hasTouch: vp.width < 500,
        isMobile: vp.width < 500,
      };
      const ctx = await browser.newContext({ ...contextOptions, storageState: storage });
      const page = await ctx.newPage();

      // Public screens, measured signed OUT — which is the only state in
      // which a real visitor ever sees them. Measuring them from the
      // signed-in context scored seven redirects to /dashboard as NOT
      // TESTED and left /login, /register and /forgot-password with no
      // layout coverage at any viewport.
      const anon = await browser.newContext(contextOptions);
      const anonPage = await anon.newPage();
      // The marketing site, which had no coverage here at all. That gap cost
      // a real one: the landing page's contact card carried a decorative
      // wash overhanging its own padding by 8px, and the first thing to
      // notice was a production smoke test after the deploy.
      await visit(anonPage, "/", vp.name, "landing");
      await visit(anonPage, "/privacy", vp.name, "privacy");
      await visit(anonPage, "/terms", vp.name, "terms");
      await visit(anonPage, "/login", vp.name, "login");
      // /register is a real bookmarkable URL that redirects to AuthTabs'
      // Register tab rather than duplicating the markup, so /login is where
      // the register form genuinely lives.
      await visit(anonPage, "/register", vp.name, "register", { expectPath: "/login" });
      record(vp.name, "register", "opens on the Register tab",
        (await anonPage.locator('input[name="confirmPassword"]').first().isVisible().catch(() => false))
          ? "PASS" : "FAIL", new URL(anonPage.url()).search);
      await visit(anonPage, "/forgot-password", vp.name, "forgot-password");
      await anon.close();

      // The other half of that behaviour: signed in, those routes must send
      // the user on to the dashboard rather than show a login form again.
      await expectRedirect(page, "/login", "/dashboard", vp.name, "login");
      await expectRedirect(page, "/register", "/dashboard", vp.name, "register");

      // Onboarding, measured with the account that genuinely still needs it.
      const onboardingCtx = await browser.newContext({ ...contextOptions, storageState: onboardingStorage });
      const onboardingPage = await onboardingCtx.newPage();
      await visit(onboardingPage, "/onboarding", vp.name, "onboarding");
      await onboardingCtx.close();

      // Authenticated screens.
      for (const [url, screen] of [
        ["/dashboard", "dashboard"],
        ["/collections", "collections"],
        ["/clients", "clients"],
        ["/services", "services"],
        ["/settings", "settings"],
        ["/audit", "activity-history"],
        ["/support", "support"],
        // The collection-request wizard's first step. Included because it
        // is a whole screen the suite never measured — and the one that
        // shipped a duplicate <main> landmark. Rendering it creates
        // nothing; the draft is only written when the step is submitted.
        ["/collections/new", "collection-request-wizard"],
      ]) {
        await page.goto(`${BASE_URL}${url}`, { waitUntil: "networkidle", timeout: 45_000 });
        const landed = new URL(page.url()).pathname;
        if (landed.startsWith("/login")) {
          record(vp.name, screen, "reachable", "NOT TESTED", "redirected to /login (no session)");
          continue;
        }
        await visit(page, url, vp.name, screen);
      }

      // And the gate in the other direction: an organization that HAS
      // finished onboarding must not be sent back into the wizard.
      await expectRedirect(page, "/onboarding", "/dashboard", vp.name, "onboarding");

      // ── collection detail: conversation, composer, activity ──
      if (seeded) {
        const url = `/collections/${seeded.requestId}`;
        await page.goto(`${BASE_URL}${url}`, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
        if (new URL(page.url()).pathname.startsWith("/login")) {
          record(vp.name, "collection-detail", "reachable", "NOT TESTED", "redirected to /login");
        } else {
          await visit(page, url, vp.name, "collection-detail");
          await checkConversationScroll(page, vp.name, "conversation");
          await checkConversationContrast(page, vp.name, "conversation");
          await checkConversationStartsAtLatest(page, vp.name, "conversation");
          const composer = page.locator('input[name="body"]').first();
          if (await composer.count()) {
            const box = await composer.boundingBox();
            const within = box && box.x >= -1 && box.x + box.width <= vp.width + 1;
            record(vp.name, "composer", "input stays inside the viewport", within ? "PASS" : "FAIL", within ? "" : JSON.stringify(box));
            const h = box ? Math.round(box.height) : 0;
            record(vp.name, "composer", "input is a usable height (>=40px)", h >= 40 ? "PASS" : "WARN", String(h));
            const send = page.locator('form:has(input[name="body"]) button[type="submit"]').first();
            const sBox = await send.boundingBox().catch(() => null);
            const sWithin = sBox && sBox.x >= -1 && sBox.x + sBox.width <= vp.width + 1;
            record(vp.name, "composer", "send button not clipped", sWithin ? "PASS" : "FAIL", sWithin ? "" : JSON.stringify(sBox));
          } else {
            record(vp.name, "composer", "present", "NOT TESTED", "composer not rendered");
          }
          shots.push(await shoot(page, vp.name, "collection-detail"));
        }
      }

      // ── Sidebar (mobile only) ──
      if (vp.width < 1024) {
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" }).catch(() => {});
        if (!new URL(page.url()).pathname.startsWith("/login")) {
          const toggle = page.locator("button[aria-label], button:has(svg)").first();
          if (await toggle.count()) {
            await toggle.click().catch(() => {});
            await page.waitForTimeout(400);
            const ok = await checkOverflow(page, vp.name, "sidebar-open");
            record(vp.name, "sidebar", "opening does not cause page overflow", ok ? "PASS" : "FAIL");
            shots.push(await shoot(page, vp.name, "sidebar-open"));

            // Measured by geometry, not isVisible(): the drawer is parked
            // off-screen with a transform, which Playwright still reports as
            // visible, so an isVisible() check here would pass in both
            // states and prove nothing.
            const drawerX = async () => {
              const box = await page.locator("aside").first().boundingBox().catch(() => null);
              return box ? box.x : null;
            };
            const openX = await drawerX();
            const onScreen = (x) => x !== null && x + 1 < vp.width && x > -vp.width;
            record(vp.name, "sidebar", "opens into the viewport", onScreen(openX) ? "PASS" : "FAIL", `x=${openX}`);

            // Regression: this drawer is a modal-shaped panel over a
            // dimming scrim, and Escape did not close it — a keyboard user
            // had no way out at all. Found by end-to-end QA.
            await page.keyboard.press("Escape");
            await page.waitForTimeout(400);
            const closedX = await drawerX();
            record(vp.name, "sidebar", "Escape closes it", onScreen(closedX) ? "FAIL" : "PASS", `x=${closedX}`);
          } else {
            record(vp.name, "sidebar", "toggle found", "NOT TESTED", "no toggle located");
          }
        }
      }

      // ── HelpTip / Popover: open a real one and measure it ──
      // /settings carries a real HelpTip and /dashboard the status pill;
      // both are Popover, which is the primitive under test. The previous
      // version led with /onboarding and, when no tip was on step 1, clicked
      // "המשך" up to six times to hunt for one — which walked the account
      // through the wizard and changed the state every later screen was
      // measured in. A layout test must not mutate the fixture it shares.
      let tipTested = false;
      for (const route of ["/settings", "/services", "/dashboard"]) {
        if (tipTested) break;
        await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
        if (new URL(page.url()).pathname.startsWith("/login")) continue;

        const tip = page.locator("[data-popover-trigger]").first();
        if (!(await tip.count())) continue;

        // Keyboard reachability: it must be a real focusable button.
        await tip.focus();
        const focused = await page.evaluate(() =>
          document.activeElement?.hasAttribute("data-popover-trigger") ?? false);
        record(vp.name, "helptip", "trigger is keyboard-focusable", focused ? "PASS" : "FAIL", route);

        // Tap on touch viewports, click otherwise.
        await tip.click();
        await page.waitForTimeout(450);

        // Resolve the panel from THIS trigger's popovertarget. `[popover]`
        // .first() matched whichever popover came first in the DOM —
        // ConfirmDialog and Drawer also use popover="auto" — so the test was
        // opening the HelpTip and then measuring a ConfirmDialog, which is
        // why edits to Popover.tsx changed the numbers by exactly nothing.
        const panelId = await tip.getAttribute("popovertarget");
        if (!panelId) {
          record(vp.name, "helptip", "trigger exposes its panel id", "FAIL", "no popovertarget attribute");
          tipTested = true;
          continue;
        }
        // Attribute selector, not `#id`: React's useId produces ids
        // containing colons, which are invalid in a bare CSS id selector.
        const panel = page.locator(`[id="${panelId}"]`);
        const visible = await panel.isVisible().catch(() => false);
        record(vp.name, "helptip", "opens on click/tap", visible ? "PASS" : "FAIL", route);

        const box = await panel.boundingBox().catch(() => null);
        if (box) {
          const withinX = box.x >= -1 && box.x + box.width <= vp.width + 1;
          const withinY = box.y >= -1 && box.y + box.height <= vp.height + 1;
          record(vp.name, "helptip", "not clipped horizontally (RTL-safe)", withinX ? "PASS" : "FAIL",
            withinX ? "" : `x=${Math.round(box.x)} w=${Math.round(box.width)} vw=${vp.width}`);
          record(vp.name, "helptip", "not clipped vertically", withinY ? "PASS" : "FAIL",
            withinY ? "" : `y=${Math.round(box.y)} h=${Math.round(box.height)} vh=${vp.height}`);
          // Top layer means it must paint above everything, never behind.
          const onTop = await page.evaluate(() => {
            const p = document.querySelector("[popover]:popover-open");
            if (!p) return false;
            const r = p.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(12, r.height / 2));
            return !!hit && (p === hit || p.contains(hit));
          });
          record(vp.name, "helptip", "renders above other content (top layer)", onTop ? "PASS" : "FAIL");
          shots.push(await shoot(page, vp.name, "helptip-open"));
        } else {
          record(vp.name, "helptip", "panel measurable", "FAIL", "no bounding box after open");
        }

        await checkOverflow(page, vp.name, "helptip-open");

        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        const stillOpen = await panel.isVisible().catch(() => false);
        record(vp.name, "helptip", "Escape closes it", stillOpen ? "FAIL" : "PASS");
        tipTested = true;
      }
      if (!tipTested) record(vp.name, "helptip", "reachable", "FAIL", "no [data-popover-trigger] on any candidate route");

      await ctx.close();
    }
  } finally {
    await browser.close();
    await stopEnvironment();
  }

  // ── report ──
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.writeFile(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2), "utf-8");

  const fails = results.filter((r) => r.status === "FAIL");
  const notTested = results.filter((r) => r.status === "NOT TESTED");
  const warns = results.filter((r) => r.status === "WARN");
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS ${results.filter(r=>r.status==="PASS").length} · FAIL ${fails.length} · WARN ${warns.length} · NOT TESTED ${notTested.length}`);
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(`  [${f.viewport}] ${f.screen} — ${f.check}: ${f.detail}`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("HARNESS ERROR:", e.message);
  await stopEnvironment().catch(() => {});
  process.exit(1);
});
