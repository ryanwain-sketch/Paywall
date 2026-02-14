const express = require("express");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
const path = require("path");
const { chromium } = require("playwright-core");

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_DAILY_LIMIT = 3;

// --- Stripe setup ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");

let stripe;
if (STRIPE_SECRET_KEY) {
  stripe = require("stripe")(STRIPE_SECRET_KEY);
} else {
  console.warn("STRIPE_SECRET_KEY not set — payment endpoints disabled");
}

// Pro users: Set of Stripe customer IDs with active subscriptions
const proCustomers = new Set();

// Trust proxy for correct IP behind reverse proxies
app.set("trust proxy", 1);

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Payments not configured" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.customer) {
        proCustomers.add(session.customer);
        console.log(`Pro activated: ${session.customer}`);
      }
      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.paused": {
      const sub = event.data.object;
      if (sub.customer) {
        proCustomers.delete(sub.customer);
        console.log(`Pro deactivated: ${sub.customer}`);
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      if (sub.customer) {
        if (sub.status === "active") {
          proCustomers.add(sub.customer);
        } else {
          proCustomers.delete(sub.customer);
        }
      }
      break;
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- Paywall detection ---
const PAYWALL_SIGNALS = [
  "subscribe to unlock",
  "subscribe to read",
  "subscription required",
  "sign in to read",
  "register to read",
  "for subscribers only",
  "start your free trial",
  "create a free account",
  "already a subscriber",
  "continue reading with",
  "paywall",
  "premium content",
];

function looksPaywalled(text) {
  if (!text || text.length < 500) return true;
  const lower = text.toLowerCase();
  return PAYWALL_SIGNALS.some((s) => lower.includes(s));
}

// --- HTML to clean text (preserves paragraph breaks) ---
function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6]|tr|section|article)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Boilerplate stripping ---
const BOILERPLATE_RE = [
  /^unlock the editor'?s digest for free[^\n]*(?:\n[^\n]+){0,3}\n\n/i,
  /^sign up to [^\n]+ newsletter[^\n]*(?:\n[^\n]+){0,3}\n\n/i,
  /^this article is part of the ft'?s [^\n]*\n\n/i,
];

function stripBoilerplate(text) {
  let cleaned = text;
  for (const re of BOILERPLATE_RE) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned;
}

// --- Archive fallback via plain HTTP (works through proxies) ---
const ARCHIVE_SOURCES = [
  (url) => `https://archive.ph/newest/${url}`,
  (url) => `https://archive.today/newest/${url}`,
];

async function fetchViaArchive(url) {
  for (const buildUrl of ARCHIVE_SOURCES) {
    const archiveUrl = buildUrl(url);

    // Retry up to 2 times with backoff when rate-limited (429)
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        if (attempt > 0) console.log(`Archive retry #${attempt}: ${archiveUrl}`);
        else console.log(`Trying archive: ${archiveUrl}`);
        const resp = await fetch(archiveUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html",
            Referer: "https://www.google.com/",
          },
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        console.log(`Archive responded: ${resp.status} → ${resp.url}`);

        if (resp.status === 429) {
          const delay = (attempt + 1) * 3000;
          console.log(`Archive rate-limited (429), waiting ${delay}ms before retry…`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (!resp.ok) break; // non-429 error → try next archive source

        const html = await resp.text();
        const dom = new JSDOM(html, { url: resp.url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article && article.textContent && article.textContent.length > 500) {
          console.log(`Archive returned article: ${article.textContent.length} chars`);
          return article;
        }
        console.log(
          `Archive returned insufficient content (${article?.textContent?.length || 0} chars)`
        );
        break; // got a response but content was bad → try next source
      } catch (err) {
        clearTimeout(timeout);
        console.error(`Archive fetch failed: ${err.message}`);
        break;
      }
    }
  }
  return null;
}

// --- Headless browser helpers (optional, for environments with Chromium) ---
let _browser = null;
let _browserFailed = false;

function findChromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  // Scan the Playwright cache for any installed Chromium version
  const fs = require("fs");
  const cacheDir = path.join(
    process.env.HOME || "/root",
    ".cache",
    "ms-playwright"
  );
  try {
    const entries = fs.readdirSync(cacheDir).filter((e) => e.startsWith("chromium"));
    entries.sort().reverse(); // prefer newest version
    for (const entry of entries) {
      const candidate = path.join(cacheDir, entry, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir doesn't exist */ }

  return null;
}

async function getBrowser() {
  if (_browserFailed) return null;
  if (_browser && _browser.isConnected()) return _browser;
  try {
    const executablePath = findChromiumPath();
    if (!executablePath) {
      console.warn(
        "Chromium not found. Run: npx playwright install chromium"
      );
      _browserFailed = true;
      return null;
    }
    _browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    return _browser;
  } catch (err) {
    console.warn("Chromium unavailable, skipping browser fetch:", err.message);
    _browserFailed = true;
    return null;
  }
}

async function fetchWithBrowser(targetUrl) {
  const browser = await getBrowser();
  if (!browser) return null;

  let page;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ Referer: "https://www.google.com/" });
    console.log(`Browser fetch: ${targetUrl}`);
    const resp = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!resp || resp.status() >= 400) {
      console.log(`Browser fetch responded: ${resp?.status() || "no response"}`);
      return null;
    }
    await page.waitForTimeout(2000);
    const html = await page.content();
    console.log(`Browser fetch loaded: ${page.url()} (${html.length} bytes)`);
    const dom = new JSDOM(html, { url: page.url() });
    const reader = new Readability(dom.window.document);
    return reader.parse();
  } catch (err) {
    console.error(`Browser fetch failed: ${err.message}`);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// --- Pro cookie helpers ---
function signCookie(customerId) {
  const hmac = crypto.createHmac("sha256", COOKIE_SECRET);
  hmac.update(customerId);
  return `${customerId}.${hmac.digest("hex")}`;
}

function verifyCookie(value) {
  if (!value || !value.includes(".")) return null;
  const [customerId, sig] = value.split(".");
  const hmac = crypto.createHmac("sha256", COOKIE_SECRET);
  hmac.update(customerId);
  const expected = hmac.digest("hex");
  if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return customerId;
  }
  return null;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function isProUser(req) {
  const cookies = parseCookies(req);
  const customerId = verifyCookie(cookies.cage_pro);
  return customerId && proCustomers.has(customerId);
}

// --- Rate limiting (in-memory, per-IP, daily reset) ---
const rateLimits = new Map();

function getRateLimitBucket(ip) {
  const now = Date.now();
  let bucket = rateLimits.get(ip);

  // Reset at midnight UTC
  const resetAt = new Date();
  resetAt.setUTCHours(24, 0, 0, 0);
  const resetMs = resetAt.getTime();

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: resetMs };
    rateLimits.set(ip, bucket);
  }

  return bucket;
}

// Clean up stale entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimits) {
    if (now >= bucket.resetAt) rateLimits.delete(ip);
  }
}, 60 * 60 * 1000);

function setRateLimitHeaders(res, bucket, isPro) {
  if (isPro) {
    res.set("X-RateLimit-Limit", "unlimited");
    res.set("X-RateLimit-Remaining", "unlimited");
  } else {
    res.set("X-RateLimit-Limit", String(FREE_DAILY_LIMIT));
    res.set("X-RateLimit-Remaining", String(Math.max(0, FREE_DAILY_LIMIT - bucket.count)));
    res.set("X-RateLimit-Reset", String(Math.floor(bucket.resetAt / 1000)));
  }
}

// Expose remaining cages without consuming one
app.get("/api/usage", (req, res) => {
  const pro = isProUser(req);
  if (pro) {
    return res.json({ pro: true, limit: null, used: 0, remaining: null });
  }
  const ip = req.ip;
  const bucket = getRateLimitBucket(ip);
  setRateLimitHeaders(res, bucket, false);
  res.json({
    pro: false,
    limit: FREE_DAILY_LIMIT,
    used: bucket.count,
    remaining: Math.max(0, FREE_DAILY_LIMIT - bucket.count),
    resetAt: bucket.resetAt,
  });
});

// --- Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Payments not configured yet." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: "Cage that Page Pro",
            description: "Unlimited cages, cloud history, and batch export",
          },
          unit_amount: 500,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

// Success: verify Stripe session and set Pro cookie
app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!stripe || !sessionId) {
    return res.redirect("/");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === "paid" && session.customer) {
      proCustomers.add(session.customer);
      const signed = signCookie(session.customer);
      res.setHeader(
        "Set-Cookie",
        `cage_pro=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}`
      );
    }
  } catch (err) {
    console.error("Session verify error:", err.message);
  }

  res.redirect("/?pro=1");
});

// Archive: fetch article and extract readable content
app.post("/api/archive", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    // Validate URL
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Rate limit check — Pro users bypass
  const pro = isProUser(req);
  const ip = req.ip;
  const bucket = getRateLimitBucket(ip);
  setRateLimitHeaders(res, bucket, pro);

  if (!pro) {
    if (bucket.count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: "You've used all 3 free cages for today.",
        upgrade: true,
        remaining: 0,
        resetAt: bucket.resetAt,
      });
    }
    bucket.count++;
    res.set("X-RateLimit-Remaining", String(Math.max(0, FREE_DAILY_LIMIT - bucket.count)));
  }

  try {
    let article = null;

    // Step 1: Plain HTTP fetch (fast, works for most sites)
    console.log(`Step 1 — plain fetch: ${url}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Referer: "https://www.google.com/",
      },
      redirect: "follow",
    });

    if (response.ok) {
      const html = await response.text();
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      article = reader.parse();
    }

    // Step 1b: Retry with Googlebot UA (many sites serve full content for SEO)
    if (!article || looksPaywalled(article.textContent)) {
      console.log("Step 1b — Googlebot UA fetch");
      try {
        const gbResp = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            Accept: "text/html",
          },
          redirect: "follow",
        });
        if (gbResp.ok) {
          const gbHtml = await gbResp.text();
          const gbDom = new JSDOM(gbHtml, { url });
          const gbArticle = new Readability(gbDom.window.document).parse();
          if (
            gbArticle &&
            gbArticle.textContent &&
            (!article || gbArticle.textContent.length > article.textContent.length)
          ) {
            article = gbArticle;
          }
        }
      } catch (err) {
        console.error("Googlebot fetch failed:", err.message);
      }
    }

    // Step 2: Archive.ph via plain HTTP fetch
    if (!article || looksPaywalled(article.textContent)) {
      console.log("Step 2 — archive.ph fallback");
      const archived = await fetchViaArchive(url);
      if (
        archived &&
        archived.textContent &&
        (!article || archived.textContent.length > article.textContent.length)
      ) {
        article = archived;
      }
    }

    // Step 3: Headless browser direct fetch (optional, needs Chromium)
    if (!article || looksPaywalled(article.textContent)) {
      console.log("Step 3 — browser direct fetch");
      const browserArticle = await fetchWithBrowser(url);
      if (
        browserArticle &&
        browserArticle.textContent &&
        (!article || browserArticle.textContent.length > article.textContent.length)
      ) {
        article = browserArticle;
      }
    }

    if (!article) {
      return res.status(422).json({
        error:
          "Could not extract article content. The site may require a login or block automated access.",
      });
    }

    // Derive text from HTML to preserve paragraph breaks, then strip boilerplate
    const cleanedText = stripBoilerplate(
      htmlToText(article.content) || article.textContent
    );

    res.json({
      title: article.title,
      byline: article.byline,
      siteName: article.siteName,
      content: article.content,
      textContent: cleanedText,
      excerpt: article.excerpt,
      length: cleanedText.length,
    });
  } catch (err) {
    console.error("Archive error:", err.message);
    res.status(500).json({ error: `Failed to archive: ${err.message}` });
  }
});

// PDF: generate a PDF from the extracted article text
app.post("/api/pdf", async (req, res) => {
  const { title, byline, siteName, textContent, sourceUrl } = req.body;
  if (!textContent) {
    return res.status(400).json({ error: "Article content is required" });
  }

  try {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 72, bottom: 72, left: 64, right: 64 },
      info: {
        Title: title || "Archived Article",
        Author: byline || "",
        Subject: `Archived from ${sourceUrl || "web"}`,
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);

      const filename = (title || "article")
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .substring(0, 80)
        .toLowerCase();

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}.pdf"`,
        "Content-Length": pdfBuffer.length,
      });
      res.send(pdfBuffer);
    });

    // --- Render the PDF ---

    // Title
    doc.font("Helvetica-Bold").fontSize(22).text(title || "Untitled Article", {
      lineGap: 4,
    });

    doc.moveDown(0.3);

    // Byline & source
    const metaParts = [];
    if (byline) metaParts.push(byline);
    if (siteName) metaParts.push(siteName);
    if (metaParts.length > 0) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#666666")
        .text(metaParts.join(" — "));
    }
    if (sourceUrl) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#999999")
        .text(sourceUrl, { link: sourceUrl });
    }

    // Divider line
    doc.moveDown(0.8);
    const lineY = doc.y;
    doc
      .strokeColor("#cccccc")
      .lineWidth(1.5)
      .moveTo(doc.page.margins.left, lineY)
      .lineTo(doc.page.width - doc.page.margins.right, lineY)
      .stroke();
    doc.moveDown(0.8);

    // Article body
    doc.fillColor("#1a1a1a").font("Helvetica").fontSize(11);

    const paragraphs = textContent
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    for (const para of paragraphs) {
      // Clean up whitespace within paragraph
      const cleaned = para.replace(/\s+/g, " ");
      doc.text(cleaned, {
        lineGap: 3,
        paragraphGap: 4,
        align: "left",
      });
      doc.moveDown(0.5);
    }

    // Footer
    doc.moveDown(1);
    const footerY = doc.y;
    doc
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .moveTo(doc.page.margins.left, footerY)
      .lineTo(doc.page.width - doc.page.margins.right, footerY)
      .stroke();
    doc.moveDown(0.3);

    const dateStr = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#aaaaaa")
      .text(`Caged by Cage that Page — PDF generated ${dateStr}`, {
        align: "center",
      });

    doc.end();
  } catch (err) {
    console.error("PDF error:", err.message);
    res.status(500).json({ error: `Failed to generate PDF: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Cage that Page running at http://localhost:${PORT}`);
});
