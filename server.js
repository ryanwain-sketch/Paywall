require("dotenv").config();
const express = require("express");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
const path = require("path");
const { Resend } = require("resend");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_DAILY_LIMIT = 3;
const UNAUTH_DAILY_LIMIT = 1;

// --- Stripe setup ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");

// --- Email setup (Resend) ---
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Cage that Page <onboarding@resend.dev>";

let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log("Email configured via Resend");
} else {
  console.warn("RESEND_API_KEY not set — magic links will be logged to console");
}

// --- Rate limit for magic link sends (per-email, in-memory) ---
const sendLinkLimits = new Map();
const SEND_LINK_MAX = 5;       // max sends per email per window
const SEND_LINK_WINDOW = 15 * 60 * 1000; // 15 minutes

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
  "register to unlock",
  "for subscribers only",
  "start your free trial",
  "create a free account",
  "already a subscriber",
  "continue reading with",
  "paywall",
  "premium content",
  "full range of subscriptions",
  "explore more offers",
  "for your first year",
  "complete digital access",
  "become a member",
  "members-only",
  "log in to read",
  "digital access for organisations",
  "reuse this content",
  "this content is only available to",
  "this article is only available to",
];

function looksPaywalled(text) {
  if (!text || text.length < 1200) return true;
  const lower = text.toLowerCase();
  return PAYWALL_SIGNALS.some((s) => lower.includes(s));
}

// Pick the best article: non-paywalled always beats paywalled, then prefer longer
function pickBestArticle(current, candidate) {
  if (!current || !current.textContent) return candidate;
  const curPaywalled = looksPaywalled(current.textContent);
  const candPaywalled = looksPaywalled(candidate.textContent);

  // Non-paywalled always wins over paywalled
  if (curPaywalled && !candPaywalled) return candidate;
  if (!curPaywalled && candPaywalled) return current;

  // Same paywall status — prefer longer content
  return candidate.textContent.length > current.textContent.length ? candidate : current;
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

// --- Smart article text cleaning for pasted content ---

const ARTICLE_DATE_PATTERNS = [
  /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/i,
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/i,
  /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i,
  /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\b/i,
];

const PUBLICATION_MAP = {
  "economist.com": "The Economist",
  "ft.com": "Financial Times",
  "nytimes.com": "The New York Times",
  "wsj.com": "The Wall Street Journal",
  "washingtonpost.com": "The Washington Post",
  "theguardian.com": "The Guardian",
  "telegraph.co.uk": "The Telegraph",
  "thetimes.co.uk": "The Times",
  "thetimes.com": "The Times",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "bloomberg.com": "Bloomberg",
  "theatlantic.com": "The Atlantic",
  "newyorker.com": "The New Yorker",
  "wired.com": "Wired",
  "spectator.co.uk": "The Spectator",
  "newstatesman.com": "New Statesman",
  "independent.co.uk": "The Independent",
};

function extractSiteNameFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (PUBLICATION_MAP[host]) return PUBLICATION_MAP[host];
    const name = host.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return null;
  }
}

function extractTitleFromUrl(url) {
  if (!url) return null;
  try {
    const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.length > 5 && !/^\d+$/.test(seg) && seg.includes("-")) {
        const minor = new Set([
          "a","an","the","and","but","or","for","nor","on","at","to","by","in","of","up","as","is","it",
        ]);
        return seg
          .replace(/[-_]/g, " ")
          .split(/\s+/)
          .map((w, idx) =>
            idx === 0 || !minor.has(w.toLowerCase())
              ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
              : w.toLowerCase()
          )
          .join(" ");
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cleanArticleText(raw, sourceUrl) {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // --- 1. Extract metadata before modifying text ---
  // Only search the header area (~800 chars) for the publication date,
  // not the full body — articles often mention historical dates that
  // would incorrectly match (e.g. "November 1st 1990" about Thatcher).
  let articleDate = null;
  const headerArea = text.substring(0, 800);
  for (const re of ARTICLE_DATE_PATTERNS) {
    const m = headerArea.match(re);
    if (m) {
      articleDate = m[1];
      break;
    }
  }

  let byline = null;
  const bylineMatch = headerArea.match(
    /\b[Bb]y\s+([A-Z][a-zA-Z'\u2019-]+(?:\s+[A-Z][a-zA-Z'\u2019-]+){0,4})/
  );
  if (bylineMatch) byline = bylineMatch[1];

  const siteName = extractSiteNameFromUrl(sourceUrl);
  const title = extractTitleFromUrl(sourceUrl);

  // --- 2. Strip noise ---
  // Preserve real paragraph breaks as markers, join soft wraps
  text = text.replace(/\n\s*\n/g, "\u2029");
  text = text.replace(/\n/g, " ");

  // Strip noise phrases
  const noisePatterns = [
    // UI elements
    /\bShare\b/g,
    /\bSave\b(?=\s|$)/g,
    /\bCopy link\b/gi,
    /\bPrint this page\b/gi,
    /\bSee more\b/gi,
    /\bFollow\b(?:\s+us)?(?=\s|$)/g,
    /\bComments?\s*(?:\(\d+\))?(?=\s|$)/g,
    /\bGift this article\b[^.\u2029]*/gi,
    /\bAdd us as preferred source\b/gi,
    // Audio/video
    /\bListen to this story\b/gi,
    /\bai[\s-]?narrated\b/gi,
    /\baudio narration\b/gi,
    // Reading time & timestamps
    /\|\s*\d+\s*min\s*read/gi,
    /\b\d+\s*min(?:ute)?s?\s*read\b/gi,
    /\b\d{1,2}:\d{2}\s*(?:am|pm)\s*(?:GMT|BST|EST|PST|UTC|ET|PT|CT|CET|CEST)\b/gi,
    /\bUpdated\s*:\s*[^.\u2029]{5,60}/gi,
    /\bPublished\s*:\s*[^.\u2029]{5,60}/gi,
    // Image credits & captions
    /\b(?:photograph|photo|image|picture|illustration)\s*:\s*[^.\u2029]{3,100}/gi,
    /\bCredit\s*:\s*[^.\u2029]{3,150}/gi,
    /\b(?:Getty Images?|Reuters|AP Photo|AFP|Alamy|Shutterstock|iStock)\b(?:\s*\/\s*\w+)*/gi,
    /[-\u2013\u2014]\s*seen here\b[^.\u2013\u2014]*[-\u2013\u2014]/gi,
    // Newsletter/subscription prompts
    /\bSign up (?:to|for)\s+[^.\u2029]+(?:\.|(?=\u2029))/gi,
    /\bThis article appeared in[^.\u2029]+\./gi,
    /\bReuse this content\b/gi,
    /\bAll rights reserved\b/gi,
    /\bUnlock the editor'?s digest[^.\u2029]+\./gi,
    /\bMore from\s+[^.\u2029]+(?:\.|(?=\u2029))/gi,
    /\bExplore more offers\b/gi,
    /\bRelated\s+(?:articles?|stories|topics?)\b/gi,
    // Author role lines (e.g. "Sunday Political Editor")
    /\b(?:Chief|Senior|Deputy|Assistant|Associate)?\s*(?:Political|Foreign|Business|Science|Health|Technology|Economics?|Environment)\s+(?:Editor|Reporter|Correspondent|Writer|Columnist)\b/gi,
  ];

  for (const re of noisePatterns) {
    text = text.replace(re, " ");
  }

  // Strip image/illustration descriptions: "illustration of [long description]"
  text = text.replace(
    /\b(?:illustration|photograph|picture|photo|image) of\b[^.\u2029]{10,500}/gi,
    " "
  );

  // Remove extracted date and byline from body
  if (articleDate) text = text.replace(articleDate, " ");
  if (byline) {
    const escaped = byline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp("\\b[Bb]y\\s+" + escaped), " ");
  }

  // Restore paragraph markers
  text = text.replace(/\u2029/g, "\n\n");

  // --- 3. Clean up whitespace and format ---
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/ \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  text = smartParagraphFormat(text);

  const excerpt = text.split("\n\n")[0]?.substring(0, 300) || "";

  return { title, byline, siteName, articleDate, textContent: text, excerpt };
}

function smartParagraphFormat(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return text;

  // If we already have multiple reasonably-sized paragraphs, keep them
  if (paragraphs.length > 3) {
    const avgLen =
      paragraphs.reduce((s, p) => s + p.length, 0) / paragraphs.length;
    if (avgLen < 1200) return paragraphs.join("\n\n");
  }

  // Otherwise, split long blocks on sentence boundaries
  const result = [];
  for (const para of paragraphs) {
    if (para.length < 800) {
      result.push(para);
      continue;
    }

    const sentences = splitSentences(para);
    let current = "";
    let count = 0;

    for (const s of sentences) {
      current += (current ? " " : "") + s;
      count++;
      if (count >= 4 || (count >= 3 && current.length > 500)) {
        result.push(current);
        current = "";
        count = 0;
      }
    }
    if (current) result.push(current);
  }

  return result.join("\n\n");
}

function splitSentences(text) {
  const sentences = [];
  const abbrevs =
    /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Lt|Gen|Gov|vs|etc|Inc|Ltd|Corp|Vol|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.\s*$/i;

  let current = "";
  const tokens = text.split(/(\.\s+|\?\s+|!\s+)/);

  for (let i = 0; i < tokens.length; i++) {
    current += tokens[i];
    if (/^[.!?]\s+$/.test(tokens[i])) {
      if (
        !abbrevs.test(current) &&
        i + 1 < tokens.length &&
        /^[A-Z"\u201c]/.test(tokens[i + 1])
      ) {
        sentences.push(current.trim());
        current = "";
      }
    }
  }
  if (current.trim()) sentences.push(current.trim());

  return sentences;
}

// --- JSON-LD / structured data extraction ---
// Many news sites embed full article text in JSON-LD even on paywalled pages
function extractArticleFromJsonLd(html, pageUrl) {
  try {
    const dom = new JSDOM(html, { url: pageUrl });
    const scripts = dom.window.document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      try {
        let data = JSON.parse(script.textContent);
        // Some sites wrap in an array
        if (Array.isArray(data)) data = data[0];
        // Look for article types with articleBody
        if (
          data &&
          data.articleBody &&
          (data["@type"] === "NewsArticle" ||
            data["@type"] === "Article" ||
            data["@type"] === "WebPage" ||
            data["@type"] === "ReportageNewsArticle" ||
            Array.isArray(data["@type"]))
        ) {
          const body = data.articleBody;
          if (body.length > 500) {
            console.log(
              `JSON-LD extraction found articleBody: ${body.length} chars`
            );
            return {
              title: data.headline || data.name || null,
              content: `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
              textContent: body,
              byline: data.author
                ? Array.isArray(data.author)
                  ? data.author.map((a) => a.name || a).join(", ")
                  : data.author.name || data.author
                : null,
              siteName: data.publisher?.name || null,
            };
          }
        }
      } catch (_) {
        // Invalid JSON in one script tag — try the next
      }
    }

    // Also check for __NEXT_DATA__ (Next.js sites)
    const nextDataScript = dom.window.document.querySelector(
      "#__NEXT_DATA__"
    );
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript.textContent);
        // Walk the props tree looking for article body content
        const body = findDeepValue(nextData, "body") ||
          findDeepValue(nextData, "articleBody") ||
          findDeepValue(nextData, "content");
        if (typeof body === "string" && body.length > 500) {
          console.log(`__NEXT_DATA__ extraction found body: ${body.length} chars`);
          return {
            title: findDeepValue(nextData, "headline") || findDeepValue(nextData, "title") || null,
            content: `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
            textContent: body,
            byline: null,
            siteName: null,
          };
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error(`JSON-LD extraction failed: ${err.message}`);
  }
  return null;
}

// Walk an object tree to find a string value by key name
function findDeepValue(obj, key, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== "object") return null;
  if (obj[key] && typeof obj[key] === "string" && obj[key].length > 200) return obj[key];
  for (const k of Object.keys(obj)) {
    const result = findDeepValue(obj[k], key, depth + 1);
    if (result) return result;
  }
  return null;
}

// --- Archive fallback via plain HTTP (works through proxies) ---
const ARCHIVE_SOURCES = [
  (url) => `https://archive.ph/newest/${url}`,
  (url) => `https://archive.today/newest/${url}`,
  (url) => `https://archive.is/newest/${url}`,
  (url) => `https://archive.vn/newest/${url}`,
];

// Detect challenge/CAPTCHA pages that aren't real article content
const CAPTCHA_SIGNALS = [
  "complete the security check",
  "please complete the captcha",
  "why do i have to complete a captcha",
  "one more step",
  "checking your browser",
  "verify you are human",
  "just a moment",
  "attention required",
  "enable javascript and cookies",
];

function looksLikeCaptcha(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CAPTCHA_SIGNALS.some((s) => lower.includes(s));
}

// Helper: parse readable article from HTML string
function parseArticleFromHtml(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const reader = new Readability(dom.window.document);
  return reader.parse();
}

// Helper: fetch a single URL and return article if content is sufficient
async function tryFetchArchiveUrl(fetchUrl, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    console.log(`${label}: ${fetchUrl}`);
    const resp = await fetch(fetchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Referer: "https://www.google.com/",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const locationHeader = resp.headers.get("location") || null;
    console.log(`${label} responded: ${resp.status} → ${resp.url}${locationHeader ? ` (Location: ${locationHeader})` : ""}`);

    // Always try to parse the body — archive.ph sometimes serves content even on 429
    const html = await resp.text();
    const article = parseArticleFromHtml(html, resp.url);
    if (article && article.textContent && article.textContent.length > 500) {
      if (looksLikeCaptcha(article.textContent)) {
        console.log(`${label} returned CAPTCHA/challenge page — skipping`);
        return { article: null, status: resp.status, locationHeader };
      }
      console.log(`${label} returned article: ${article.textContent.length} chars`);
      return { article, status: resp.status, locationHeader };
    }
    console.log(`${label} returned insufficient content (${article?.textContent?.length || 0} chars)`);
    return { article: null, status: resp.status, locationHeader };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${label} failed: ${err.message}`);
    return { article: null, status: 0, locationHeader: null };
  }
}

// Detect if a URL looks like a direct archive snapshot (contains a timestamp)
function isSnapshotUrl(url) {
  return /archive\.\w+\/\d{14}\//.test(url);
}

async function fetchViaArchive(url) {
  for (const buildUrl of ARCHIVE_SOURCES) {
    const archiveUrl = buildUrl(url);

    const { article, status, locationHeader } = await tryFetchArchiveUrl(archiveUrl, "Trying archive");
    if (article) return article;

    // On 429, archive.ph puts snapshot URL in Location header (not a real redirect)
    if (status === 429 && locationHeader && isSnapshotUrl(locationHeader)) {
      console.log(`Got snapshot URL from Location header, trying: ${locationHeader}`);
      const snap = await tryFetchArchiveUrl(locationHeader, "Snapshot fetch");
      if (snap.article) return snap.article;
    }
  }

  return null;
}

// --- Wayback Machine (archive.org) fallback ---
async function fetchViaWayback(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // Check if a snapshot exists via the Wayback Availability API
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    console.log(`Wayback Machine: checking ${apiUrl}`);
    const resp = await fetch(apiUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.log(`Wayback API responded: ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const snapshot = data?.archived_snapshots?.closest;
    if (!snapshot || !snapshot.available || !snapshot.url) {
      console.log("Wayback Machine: no snapshot available — triggering Save Page Now");
      // Trigger a save so future requests may find a snapshot
      triggerWaybackSave(url);
      return null;
    }

    // Fetch the snapshot page
    const snapshotUrl = snapshot.url.replace(/^http:/, "https:");
    console.log(`Wayback Machine: fetching snapshot ${snapshotUrl}`);
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 20000);
    const pageResp = await fetch(snapshotUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      redirect: "follow",
      signal: controller2.signal,
    });
    clearTimeout(timeout2);

    if (!pageResp.ok) {
      console.log(`Wayback snapshot responded: ${pageResp.status}`);
      return null;
    }

    const html = await pageResp.text();
    const article = parseArticleFromHtml(html, url);
    if (article && article.textContent && article.textContent.length > 500) {
      if (looksLikeCaptcha(article.textContent)) {
        console.log("Wayback Machine returned CAPTCHA page — skipping");
        return null;
      }
      console.log(`Wayback Machine returned article: ${article.textContent.length} chars`);
      return article;
    }
    console.log(`Wayback Machine returned insufficient content (${article?.textContent?.length || 0} chars)`);
    return null;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`Wayback Machine failed: ${err.message}`);
    return null;
  }
}

// Fire-and-forget: ask Wayback Machine to save a page for next time
function triggerWaybackSave(url) {
  const saveUrl = `https://web.archive.org/save/${url}`;
  console.log(`Wayback Save Page Now: ${saveUrl}`);
  fetch(saveUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: new URLSearchParams({ url, capture_all: "1" }),
  })
    .then((r) => console.log(`Wayback save responded: ${r.status}`))
    .catch((e) => console.error(`Wayback save failed: ${e.message}`));
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

  // Check new session-based auth first
  const email = getAuthEmail(req);
  if (email) {
    const user = db.getUser(email);
    if (user && user.stripe_customer_id && proCustomers.has(user.stripe_customer_id)) {
      return true;
    }
  }

  // Fall back to legacy Stripe cookie
  const customerId = verifyCookie(cookies.cage_pro);
  return customerId && proCustomers.has(customerId);
}

function getAuthEmail(req) {
  const cookies = parseCookies(req);
  return db.getSessionUser(cookies.cage_session || null);
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

// --- Auth endpoints ---

app.post("/api/auth/send-link", async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required." });
  }

  // Rate limit: max 5 sends per email per 15 minutes
  const lower = email.toLowerCase().trim();
  const now = Date.now();
  let bucket = sendLinkLimits.get(lower);
  if (!bucket || now - bucket.start > SEND_LINK_WINDOW) {
    bucket = { start: now, count: 0 };
    sendLinkLimits.set(lower, bucket);
  }
  if (bucket.count >= SEND_LINK_MAX) {
    return res.status(429).json({ error: "Too many requests. Please wait a few minutes." });
  }
  bucket.count++;

  const token = db.createMagicLink(email);
  const link = `${SITE_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;

  if (resend) {
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: lower,
        subject: "Sign in to Cage that Page",
        text: `Click this link to sign in:\n\n${link}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Click the link below to sign in:</p><p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#FF6B2C;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Sign in to Cage that Page</a></p><p style="color:#888;font-size:13px;">This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
      });
    } catch (err) {
      console.error("Resend email failed:", err.message);
      return res.status(500).json({ error: "Failed to send email. Please try again." });
    }
  } else {
    console.log(`\n  Magic link for ${lower}:\n  ${link}\n`);
  }

  res.json({ ok: true });
});

app.get("/api/auth/verify", (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect("/?auth=invalid");

  const email = db.verifyMagicLink(token);
  if (!email) return res.redirect("/?auth=expired");

  const sessionToken = db.createSession(email);
  res.setHeader(
    "Set-Cookie",
    `cage_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
  res.redirect("/?auth=ok");
});

app.get("/api/auth/me", (req, res) => {
  const email = getAuthEmail(req);
  if (!email) return res.json({ authenticated: false });

  const pro = isProUser(req);
  const user = db.getUser(email);

  if (pro) {
    return res.json({ authenticated: true, email, pro: true, limit: null, used: 0, remaining: null });
  }

  const used = db.getUsageCount(email);
  res.json({
    authenticated: true,
    email,
    pro: false,
    limit: FREE_DAILY_LIMIT,
    used,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
  });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  db.deleteSession(cookies.cage_session || null);
  res.setHeader(
    "Set-Cookie",
    "cage_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  res.json({ ok: true });
});

// Expose remaining cages without consuming one
app.get("/api/usage", (req, res) => {
  const email = getAuthEmail(req);
  const pro = isProUser(req);

  if (pro) {
    return res.json({ pro: true, authenticated: !!email, email, limit: null, used: 0, remaining: null });
  }

  // Authenticated free user: email-based limits
  if (email) {
    const used = db.getUsageCount(email);
    return res.json({
      pro: false,
      authenticated: true,
      email,
      limit: FREE_DAILY_LIMIT,
      used,
      remaining: Math.max(0, FREE_DAILY_LIMIT - used),
    });
  }

  // Unauthenticated: IP-based, 1 free cage
  const ip = req.ip;
  const bucket = getRateLimitBucket(ip);
  setRateLimitHeaders(res, bucket, false);
  res.json({
    pro: false,
    authenticated: false,
    limit: UNAUTH_DAILY_LIMIT,
    used: bucket.count,
    remaining: Math.max(0, UNAUTH_DAILY_LIMIT - bucket.count),
  });
});

// --- Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Payments not configured yet." });
  }

  try {
    const email = getAuthEmail(req);
    const checkoutParams = {
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
    };
    // Pre-fill email if the user is authenticated
    if (email) checkoutParams.customer_email = email;
    const session = await stripe.checkout.sessions.create(checkoutParams);

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

      // Link Stripe customer to user account if authenticated
      const email = getAuthEmail(req) || session.customer_email;
      if (email) {
        db.linkStripeCustomer(email, session.customer);
      }

      // Legacy pro cookie (for backwards compatibility)
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
  const email = getAuthEmail(req);

  if (!pro) {
    if (email) {
      // Authenticated free user: email-based limits
      const used = db.getUsageCount(email);
      if (used >= FREE_DAILY_LIMIT) {
        return res.status(429).json({
          error: `You've used all ${FREE_DAILY_LIMIT} free cages for today.`,
          upgrade: true,
          remaining: 0,
        });
      }
      db.incrementUsage(email);
      const remaining = Math.max(0, FREE_DAILY_LIMIT - used - 1);
      res.set("X-RateLimit-Limit", String(FREE_DAILY_LIMIT));
      res.set("X-RateLimit-Remaining", String(remaining));
    } else {
      // Unauthenticated: IP-based, 1 free cage then must sign in
      const ip = req.ip;
      const bucket = getRateLimitBucket(ip);
      if (bucket.count >= UNAUTH_DAILY_LIMIT) {
        return res.status(401).json({
          error: "Sign in to keep caging.",
          requireAuth: true,
          remaining: 0,
        });
      }
      bucket.count++;
      res.set("X-RateLimit-Limit", String(UNAUTH_DAILY_LIMIT));
      res.set("X-RateLimit-Remaining", String(Math.max(0, UNAUTH_DAILY_LIMIT - bucket.count)));
    }
  }

  try {
    let article = null;

    // Helper: fetch with a timeout (prevents hanging on consent-redirect sites like Telegraph)
    function fetchWithTimeout(fetchUrl, options = {}, ms = 15000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ms);
      return fetch(fetchUrl, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeout));
    }

    // GDPR consent cookies — bypass consent-gate redirects (Telegraph, etc.)
    const consentCookies = [
      "euconsent-v2=CPzqYkAPzqYkAAHABBENDICgAAAAAAAAACiQAAAAAAAA",
      "CookieConsent=true",
      "gdpr_consent=1",
      "notice_behavior=expressed,eu",
      "notice_gdpr_prefs=0,1,2:1a8b5228dd",
    ].join("; ");

    // Step 1: Plain HTTP fetch + JSON-LD extraction (fast, works for most sites)
    console.log(`Step 1 — plain fetch: ${url}`);
    let rawHtml = null;
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Referer: "https://www.google.com/",
        Cookie: consentCookies,
      },
      redirect: "follow",
    });

    if (response.ok) {
      rawHtml = await response.text();
      const dom = new JSDOM(rawHtml, { url });
      const reader = new Readability(dom.window.document);
      article = reader.parse();
    }

    // Step 1b: Extract from JSON-LD / structured data in the same HTML
    // Many paywalled sites embed full articleBody in JSON-LD for SEO
    if (rawHtml && (!article || looksPaywalled(article.textContent))) {
      console.log("Step 1b — JSON-LD / structured data extraction");
      const ldArticle = extractArticleFromJsonLd(rawHtml, url);
      if (ldArticle && ldArticle.textContent) {
        article = pickBestArticle(article, ldArticle);
      }
    }

    // Step 1c: Retry with crawler User-Agents (parallel)
    // Many sites serve full content to search/social crawlers for SEO
    if (!article || looksPaywalled(article.textContent)) {
      console.log("Step 1c — crawler UA fetches (parallel)");
      const crawlerUAs = [
        {
          label: "Googlebot",
          ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          referer: "https://www.google.com/",
        },
        {
          label: "Bingbot",
          ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
          referer: "https://www.bing.com/",
        },
        {
          label: "Facebook",
          ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
          referer: "https://www.facebook.com/",
        },
        {
          label: "Twitter",
          ua: "Twitterbot/1.0",
          referer: "https://t.co/",
        },
      ];

      const crawlerResults = await Promise.all(
        crawlerUAs.map(async ({ label, ua, referer }) => {
          try {
            const resp = await fetchWithTimeout(url, {
              headers: {
                "User-Agent": ua,
                Accept: "text/html",
                Referer: referer,
                Cookie: consentCookies,
              },
              redirect: "follow",
            }, 12000);
            if (!resp.ok) return null;
            const html = await resp.text();
            // Try JSON-LD first (might have full article hidden in structured data)
            const ldResult = extractArticleFromJsonLd(html, url);
            if (ldResult && ldResult.textContent && !looksPaywalled(ldResult.textContent)) {
              console.log(`${label} JSON-LD returned article: ${ldResult.textContent.length} chars`);
              return ldResult;
            }
            // Fall back to Readability
            const dom = new JSDOM(html, { url });
            const parsed = new Readability(dom.window.document).parse();
            if (parsed && parsed.textContent) {
              console.log(`${label} Readability returned: ${parsed.textContent.length} chars`);
              return parsed;
            }
            return null;
          } catch (err) {
            console.error(`${label} fetch failed: ${err.message}`);
            return null;
          }
        })
      );

      for (const candidate of crawlerResults) {
        if (candidate && candidate.textContent) {
          article = pickBestArticle(article, candidate);
        }
      }
    }

    // Step 2: Archive.ph + Wayback Machine in parallel
    if (!article || looksPaywalled(article.textContent)) {
      console.log("Step 2 — archive.ph + Wayback Machine (parallel)");
      const [archived, wayback] = await Promise.all([
        fetchViaArchive(url),
        fetchViaWayback(url),
      ]);

      for (const candidate of [archived, wayback]) {
        if (candidate && candidate.textContent) {
          article = pickBestArticle(article, candidate);
        }
      }
    }

    if (!article) {
      return res.status(422).json({
        error:
          "We couldn't get through to this article automatically.",
        fallbackUrl: `https://archive.ph/newest/${url}`,
        fallbackLabel: "backup",
      });
    }

    // Derive text from HTML to preserve paragraph breaks, then strip boilerplate
    const cleanedText = stripBoilerplate(
      htmlToText(article.content) || article.textContent
    );

    // Final safety check — don't generate a PDF full of paywall/CAPTCHA text
    // Check both raw and cleaned text; also reject if cleaned text is too short (teaser)
    if (looksPaywalled(article.textContent) || looksPaywalled(cleanedText) || looksLikeCaptcha(article.textContent)) {
      console.log(`Final article looks paywalled or is a CAPTCHA page — rejecting (raw: ${article.textContent.length}, cleaned: ${cleanedText.length} chars)`);
      return res.status(422).json({
        error:
          "This article is behind a tough paywall, but we have a backup option.",
        fallbackUrl: `https://archive.ph/newest/${url}`,
        fallbackLabel: "backup",
      });
    }

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

// Clean pasted text: extract metadata, strip noise, format paragraphs
app.post("/api/clean-text", (req, res) => {
  const { text, sourceUrl } = req.body;
  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: "Text is too short to process" });
  }
  try {
    const result = cleanArticleText(text, sourceUrl);
    res.json(result);
  } catch (err) {
    console.error("Text cleaning error:", err.message);
    res.status(500).json({ error: "Failed to clean text" });
  }
});

// PDF: generate a PDF from the extracted article text
app.post("/api/pdf", async (req, res) => {
  const { title, byline, siteName, textContent, sourceUrl, articleDate } = req.body;
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

    // Byline, publication, date
    const metaParts = [];
    if (byline) metaParts.push(byline);
    if (siteName) metaParts.push(siteName);
    if (articleDate) metaParts.push(articleDate);
    if (metaParts.length > 0) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#666666")
        .text(metaParts.join(" \u2014 "));
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
