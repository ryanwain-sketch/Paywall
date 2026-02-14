const urlInput = document.getElementById("url-input");
const archiveBtn = document.getElementById("archive-btn");
const cageArea = document.getElementById("cage-area");
const cageStatus = document.getElementById("cage-status");
const errorMsg = document.getElementById("error-msg");
const result = document.getElementById("result");
const pdfBtn = document.getElementById("pdf-btn");

const articleTitle = document.getElementById("article-title");
const articleMeta = document.getElementById("article-meta");
const articleExcerpt = document.getElementById("article-excerpt");

const historySection = document.getElementById("history");
const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history-btn");

const usageBar = document.getElementById("usage-bar");
const usageText = document.getElementById("usage-text");
const usageDots = document.getElementById("usage-dots");
const upgradeBanner = document.getElementById("upgrade-banner");
const upgradeBtn = document.getElementById("upgrade-btn");

const STORAGE_KEY = "cage-history";
const FREE_LIMIT = 3;

let currentArticle = null;
let isPro = false;

// --- Events ---
archiveBtn.addEventListener("click", archive);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") archive();
});
pdfBtn.addEventListener("click", () => downloadPdf(currentArticle));
clearHistoryBtn.addEventListener("click", clearHistory);
upgradeBtn.addEventListener("click", async () => {
  upgradeBtn.disabled = true;
  upgradeBtn.textContent = "Redirecting\u2026";
  try {
    const res = await fetch("/api/checkout", { method: "POST" });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || "Could not start checkout.");
    }
  } catch (err) {
    showError(err.message);
    upgradeBtn.disabled = false;
    upgradeBtn.innerHTML = "Go Pro &mdash; $5/mo";
  }
});

// --- Init ---
renderHistory();
fetchUsage();

// Clean ?pro=1 from URL after Stripe redirect
if (new URLSearchParams(window.location.search).get("pro") === "1") {
  history.replaceState(null, "", "/");
}

// --- Usage ---
async function fetchUsage() {
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    isPro = !!data.pro;
    if (isPro) {
      renderProStatus();
    } else {
      renderUsage(data.remaining);
    }
  } catch {
    // Silently fail — usage bar just stays hidden
  }
}

function renderProStatus() {
  usageBar.hidden = false;
  usageBar.classList.add("pro");
  usageText.textContent = "Pro \u2014 Unlimited cages";
  usageDots.innerHTML = "";
  upgradeBanner.hidden = true;
  upgradeBanner.style.display = "none";
  archiveBtn.disabled = false;
}

function renderUsage(remaining) {
  usageBar.hidden = false;

  if (remaining <= 0) {
    usageText.textContent = "No free cages left today";
    showUpgradeBanner();
  } else {
    usageText.textContent = `${remaining} of ${FREE_LIMIT} free cages left today`;
    hideUpgradeBanner();
  }

  // Render dots
  usageDots.innerHTML = "";
  for (let i = 0; i < FREE_LIMIT; i++) {
    const dot = document.createElement("span");
    dot.className = "usage-dot" + (i < remaining ? " active" : "");
    usageDots.appendChild(dot);
  }
}

function showUpgradeBanner() {
  upgradeBanner.hidden = false;
  archiveBtn.disabled = true;
}

function hideUpgradeBanner() {
  upgradeBanner.hidden = true;
}

// --- Archive ---
async function archive() {
  const url = urlInput.value.trim();
  if (!url) {
    showError("Please enter a URL.");
    return;
  }

  try {
    new URL(url);
  } catch {
    showError("That doesn't look like a valid URL.");
    return;
  }

  hideError();
  result.hidden = true;
  archiveBtn.disabled = true;

  cageArea.className = "cage-area caging";
  cageStatus.textContent = "Caging that page\u2026";

  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    // Update usage from response headers (skip for Pro — they're unlimited)
    if (!isPro) {
      const remaining = res.headers.get("X-RateLimit-Remaining");
      if (remaining !== null) renderUsage(parseInt(remaining, 10));
    }

    if (res.status === 429) {
      cageArea.className = "cage-area";
      cageStatus.textContent = "Paste a URL and cage that page";
      if (!isPro) renderUsage(0);
      return;
    }

    if (!res.ok) {
      throw new Error(data.error || "Failed to cage article.");
    }

    currentArticle = { ...data, sourceUrl: url };

    articleTitle.textContent = data.title || "Untitled";
    const metaParts = [];
    if (data.byline) metaParts.push(data.byline);
    if (data.siteName) metaParts.push(data.siteName);
    articleMeta.textContent = metaParts.join(" \u2014 ");
    articleExcerpt.textContent = data.excerpt || "";

    cageArea.className = "cage-area caged";
    cageStatus.textContent = "Page caged!";
    result.hidden = false;

    // Save to history
    saveToHistory(currentArticle);
  } catch (err) {
    cageArea.className = "cage-area";
    cageStatus.textContent = "Paste a URL and cage that page";
    showError(err.message);
  } finally {
    archiveBtn.disabled = false;
  }
}

// --- PDF Download ---
async function downloadPdf(article, btn) {
  if (!article) return;

  const targetBtn = btn || pdfBtn;
  const strong = targetBtn.querySelector("strong");
  const origText = strong ? strong.textContent : null;
  targetBtn.disabled = true;
  if (strong) strong.textContent = "Generating PDF\u2026";

  try {
    const res = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(article),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to generate PDF.");
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download =
      res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ||
      "article.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
  } catch (err) {
    showError(err.message);
  } finally {
    targetBtn.disabled = false;
    if (strong && origText) strong.textContent = origText;
  }
}

// --- History: localStorage ---
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory(article) {
  const history = getHistory();

  // Don't duplicate the same URL if caged again — move it to the top
  const filtered = history.filter((h) => h.sourceUrl !== article.sourceUrl);

  filtered.unshift({
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    textContent: article.textContent,
    excerpt: article.excerpt,
    sourceUrl: article.sourceUrl,
    cagedAt: new Date().toISOString(),
  });

  // Keep max 50 entries
  if (filtered.length > 50) filtered.length = 50;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  renderHistory();
}

function deleteFromHistory(sourceUrl) {
  const history = getHistory().filter((h) => h.sourceUrl !== sourceUrl);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  renderHistory();
}

function clearHistory() {
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
}

// --- History: render ---
function renderHistory() {
  const history = getHistory();

  if (history.length === 0) {
    historySection.hidden = true;
    return;
  }

  historySection.hidden = false;
  historyList.innerHTML = "";

  for (const item of history) {
    const card = document.createElement("div");
    card.className = "history-card";

    const metaParts = [];
    if (item.siteName) metaParts.push(item.siteName);
    metaParts.push(formatDate(item.cagedAt));

    card.innerHTML = `
      <div class="history-card-title">${escapeHtml(item.title || "Untitled")}</div>
      <div class="history-card-meta">${escapeHtml(metaParts.join(" \u2014 "))}</div>
      ${item.excerpt ? `<div class="history-card-excerpt">${escapeHtml(item.excerpt)}</div>` : ""}
      <div class="history-card-actions">
        <button class="history-download-btn" type="button"><strong>PDF</strong></button>
        <button class="history-delete-btn" type="button">Remove</button>
      </div>
    `;

    const dlBtn = card.querySelector(".history-download-btn");
    dlBtn.addEventListener("click", () => downloadPdf(item, dlBtn));

    card.querySelector(".history-delete-btn").addEventListener("click", () => {
      deleteFromHistory(item.sourceUrl);
    });

    historyList.appendChild(card);
  }
}

// --- Helpers ---
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
