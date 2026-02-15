// --- DOM refs ---
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
const upgradeTitle = document.getElementById("upgrade-title");
const upgradeSubtitle = document.getElementById("upgrade-subtitle");
const upgradeBtn = document.getElementById("upgrade-btn");

const pasteFallback = document.getElementById("paste-fallback");
const pasteArchiveLink = document.getElementById("paste-archive-link");
const pasteTextarea = document.getElementById("paste-textarea");
const pasteActions = document.getElementById("paste-actions");
const pastePdfBtn = document.getElementById("paste-pdf-btn");

const authPrompt = document.getElementById("auth-prompt");
const authPromptTitle = document.getElementById("auth-prompt-title");
const authPromptSubtitle = document.getElementById("auth-prompt-subtitle");
const authEmail = document.getElementById("auth-email");
const authSendBtn = document.getElementById("auth-send-btn");
const authStatusEl = document.getElementById("auth-status");

const urlRowsContainer = document.getElementById("url-rows");
const addUrlBtn = document.getElementById("add-url-btn");
const ghostRows = document.getElementById("ghost-rows");
const ghostUpgradeLink = document.getElementById("ghost-upgrade-link");

// Account dropdown
const accountBtn = document.getElementById("account-btn");
const accountDropdown = document.getElementById("account-dropdown");
const accountSignedOut = document.getElementById("account-signed-out");
const accountSignedIn = document.getElementById("account-signed-in");
const accountSigninBtn = document.getElementById("account-signin-btn");
const accountEmailEl = document.getElementById("account-email");
const accountTierBadge = document.getElementById("account-tier-badge");
const accountArchiveBtn = document.getElementById("account-archive-btn");
const accountProBtn = document.getElementById("account-pro-btn");
const accountProLabel = document.getElementById("account-pro-label");
const accountLogoutBtn = document.getElementById("account-logout-btn");

// Tier cards
const tierStrip = document.getElementById("tier-strip");
const tierFreeCard = document.getElementById("tier-free");
const tierRegisteredCard = document.getElementById("tier-registered");
const tierProCard = document.getElementById("tier-pro");
const proStatus = document.getElementById("pro-status");

// --- State ---
const STORAGE_KEY = "cage-history";
const FREE_LIMIT = 3;
const MAX_PARALLEL_ROWS = 4;

let currentArticle = null;
let isPro = false;
let isAuthenticated = false;
let userEmail = null;
let lastFailedUrl = null;
let cagingMsgTimer = null;
let urlRowId = 0;

// --- Caging messages ---
const cagingMessages = [
  "Caging that page\u2026",
  "Breaking through the paywall\u2026",
  "Extracting the article\u2026",
  "Cleaning up the text\u2026",
  "Almost there\u2026",
];

function startCagingMessages() {
  let idx = 0;
  cageStatus.textContent = cagingMessages[0];
  cagingMsgTimer = setInterval(() => {
    idx = Math.min(idx + 1, cagingMessages.length - 1);
    cageStatus.textContent = cagingMessages[idx];
  }, 3000);
}

function stopCagingMessages() {
  if (cagingMsgTimer) {
    clearInterval(cagingMsgTimer);
    cagingMsgTimer = null;
  }
}

// --- Events ---
archiveBtn.addEventListener("click", archive);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") archive();
});
pdfBtn.addEventListener("click", () => downloadPdf(currentArticle));
clearHistoryBtn.addEventListener("click", clearHistory);

pasteTextarea.addEventListener("input", () => {
  pasteActions.hidden = pasteTextarea.value.trim().length < 50;
});

// Account dropdown toggle
accountBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !accountDropdown.hidden;
  accountDropdown.hidden = isOpen;
  accountBtn.classList.toggle("active", !isOpen);
});

document.addEventListener("click", (e) => {
  if (!accountDropdown.hidden && !accountDropdown.contains(e.target) && e.target !== accountBtn) {
    accountDropdown.hidden = true;
    accountBtn.classList.remove("active");
  }
});

accountSigninBtn.addEventListener("click", () => {
  accountDropdown.hidden = true;
  accountBtn.classList.remove("active");
  showAuthPrompt();
});

accountArchiveBtn.addEventListener("click", () => {
  accountDropdown.hidden = true;
  accountBtn.classList.remove("active");
  const hist = document.getElementById("history");
  if (hist && !hist.hidden) {
    hist.scrollIntoView({ behavior: "smooth" });
  }
});

accountProBtn.addEventListener("click", () => {
  accountDropdown.hidden = true;
  accountBtn.classList.remove("active");
  if (!isPro) startCheckout();
});

accountLogoutBtn.addEventListener("click", () => {
  accountDropdown.hidden = true;
  accountBtn.classList.remove("active");
  logout();
});

// Ghost row upgrade link
ghostUpgradeLink.addEventListener("click", (e) => {
  e.preventDefault();
  startCheckout();
});

// Tier card clicks
tierRegisteredCard.addEventListener("click", () => {
  if (!isAuthenticated) {
    showAuthPrompt();
  }
});

tierProCard.addEventListener("click", () => {
  if (!isPro) {
    startCheckout();
  }
});

pastePdfBtn.addEventListener("click", async () => {
  const raw = pasteTextarea.value.trim();
  if (!raw) return;

  const strong = pastePdfBtn.querySelector("strong");
  pastePdfBtn.disabled = true;
  if (strong) strong.textContent = "Cleaning up text\u2026";

  try {
    const cleanRes = await fetch("/api/clean-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: raw, sourceUrl: lastFailedUrl || "" }),
    });

    let article;
    if (cleanRes.ok) {
      const cleaned = await cleanRes.json();
      article = {
        title: cleaned.title,
        byline: cleaned.byline,
        siteName: cleaned.siteName,
        articleDate: cleaned.articleDate,
        textContent: cleaned.textContent,
        excerpt: cleaned.excerpt,
        sourceUrl: lastFailedUrl || "",
      };
    } else {
      article = {
        title: null,
        byline: null,
        siteName: null,
        textContent: formatPastedText(raw),
        sourceUrl: lastFailedUrl || "",
      };
    }

    saveToHistory(article);
    pastePdfBtn.disabled = false;
    if (strong) strong.textContent = "Download PDF";
    downloadPdf(article, pastePdfBtn);
  } catch (err) {
    showError(err.message);
    pastePdfBtn.disabled = false;
    if (strong) strong.textContent = "Download PDF";
  }
});

upgradeBtn.addEventListener("click", startCheckout);

authSendBtn.addEventListener("click", sendMagicLink);
authEmail.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMagicLink();
});

addUrlBtn.addEventListener("click", () => {
  addUrlRow();
});

// --- Init ---
renderHistory();
init();

async function init() {
  await fetchAuthState();
  handleAuthParams();
}

// --- Auth ---
async function fetchAuthState() {
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    isAuthenticated = !!data.authenticated;
    userEmail = data.email || null;
    isPro = !!data.pro;

    renderAuthState();

    if (isPro) {
      renderProStatus();
    } else if (isAuthenticated) {
      renderUsage(data.remaining, FREE_LIMIT);
    } else {
      renderUsage(data.remaining, data.limit);
    }
  } catch {
    // Silently fail
  }
}

function renderAuthState() {
  // Account icon state
  accountBtn.classList.remove("authenticated", "pro");
  if (isPro) {
    accountBtn.classList.add("pro");
  } else if (isAuthenticated) {
    accountBtn.classList.add("authenticated");
  }

  // Dropdown: signed-in vs signed-out sections
  if (isAuthenticated) {
    accountSignedOut.hidden = true;
    accountSignedIn.hidden = false;
    accountEmailEl.textContent = userEmail;
    authPrompt.hidden = true;

    // Tier badge
    if (isPro) {
      accountTierBadge.textContent = "Pro";
      accountTierBadge.className = "tier-badge badge-pro";
      accountProLabel.textContent = "Pro member";
      accountProBtn.classList.remove("pro-item");
    } else {
      accountTierBadge.textContent = "Member";
      accountTierBadge.className = "tier-badge badge-member";
      accountProLabel.textContent = "Upgrade to Pro";
      accountProBtn.classList.add("pro-item");
    }
  } else {
    accountSignedOut.hidden = false;
    accountSignedIn.hidden = true;
  }

  // Parallel URL rows: real for Pro, ghost teaser for everyone else
  if (isPro) {
    addUrlBtn.hidden = false;
    ghostRows.hidden = true;
  } else {
    addUrlBtn.hidden = true;
    ghostRows.hidden = false;
  }

  // Tier strip visibility:
  // Pro → hide tier strip, show pro status banner
  // Member → hide Visitor card, show Member (active) + Pro
  // Visitor → show all three
  if (isPro) {
    tierStrip.hidden = true;
    proStatus.hidden = false;
  } else {
    tierStrip.hidden = false;
    proStatus.hidden = true;

    tierFreeCard.classList.remove("tier-active");
    tierRegisteredCard.classList.remove("tier-active");
    tierProCard.classList.remove("tier-active");

    if (isAuthenticated) {
      // Member: hide visitor card, highlight member
      tierFreeCard.hidden = true;
      tierRegisteredCard.classList.add("tier-active");
    } else {
      // Visitor: show all, highlight visitor
      tierFreeCard.hidden = false;
      tierFreeCard.classList.add("tier-active");
    }
  }
}

function handleAuthParams() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get("auth");
  if (auth === "ok") {
    history.replaceState(null, "", "/");
  } else if (auth === "expired") {
    showError("That sign-in link has expired. Please request a new one.");
    history.replaceState(null, "", "/");
  } else if (auth === "invalid") {
    showError("Invalid sign-in link. Please request a new one.");
    history.replaceState(null, "", "/");
  }
  if (params.get("pro") === "1") {
    history.replaceState(null, "", "/");
  }
}

async function sendMagicLink() {
  const email = authEmail.value.trim();
  if (!email) {
    authEmail.focus();
    return;
  }

  authSendBtn.disabled = true;
  authSendBtn.textContent = "Sending\u2026";
  authStatusEl.hidden = true;

  try {
    const res = await fetch("/api/auth/send-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to send link.");
    }

    authStatusEl.textContent = "Check your email for a sign-in link!";
    authStatusEl.className = "auth-status success";
    authStatusEl.hidden = false;
  } catch (err) {
    authStatusEl.textContent = err.message;
    authStatusEl.className = "auth-status error";
    authStatusEl.hidden = false;
  } finally {
    authSendBtn.disabled = false;
    authSendBtn.textContent = "Send magic link";
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch { /* ignore */ }
  isAuthenticated = false;
  userEmail = null;
  isPro = false;
  renderAuthState();
  await fetchAuthState();
}

function showAuthPrompt(afterCage) {
  if (afterCage) {
    authPromptTitle.textContent = "Nice cage! Sign in for 2 more today";
    authPromptSubtitle.textContent = "Get 3 free cages a day with just your email — no password needed.";
  } else {
    authPromptTitle.textContent = "Sign in to keep caging";
    authPromptSubtitle.textContent = "Get 3 free cages a day with just your email — no password needed.";
  }
  authPrompt.hidden = false;
  authStatusEl.hidden = true;
  authEmail.value = "";
  setTimeout(() => authEmail.focus(), 100);
}

// --- Checkout ---
async function startCheckout() {
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
}

// --- Usage ---
function renderProStatus() {
  usageBar.hidden = true;
  upgradeBanner.hidden = true;
  archiveBtn.disabled = false;
}

function renderUsage(remaining, limit) {
  const total = limit || FREE_LIMIT;
  usageBar.hidden = false;

  if (remaining <= 0) {
    if (!isAuthenticated) {
      usageText.textContent = "Sign in for 3 free cages a day";
      showUpgradeBanner(total - remaining, false);
    } else {
      usageText.textContent = "No free cages left today";
      showUpgradeBanner(total - remaining, true);
    }
  } else {
    if (!isAuthenticated && total === 1) {
      usageText.textContent = "1 free cage — sign in for 3/day";
    } else {
      usageText.textContent = `${remaining} of ${total} free cage${total === 1 ? "" : "s"} left today`;
    }
    hideUpgradeBanner();
  }

  usageDots.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const dot = document.createElement("span");
    dot.className = "usage-dot" + (i < remaining ? " active" : "");
    usageDots.appendChild(dot);
  }
}

function showUpgradeBanner(used, showProUpgrade) {
  if (showProUpgrade) {
    // Authenticated free user hit their limit
    upgradeTitle.textContent = `You've used your ${used} free cage${used === 1 ? "" : "s"} today`;
    upgradeSubtitle.textContent = "Go Pro for unlimited cages, parallel mode, and more.";
    upgradeBtn.innerHTML = "Go Pro &mdash; $5/mo";
    upgradeBtn.onclick = startCheckout;
  } else {
    // Unauth user hit their 1 free cage
    upgradeTitle.textContent = "Want more? Sign in for free";
    upgradeSubtitle.textContent = "Get 3 cages a day with just your email, or go unlimited with Pro.";
    upgradeBtn.innerHTML = "Go Pro &mdash; $5/mo";
    upgradeBtn.onclick = startCheckout;
  }
  upgradeBanner.hidden = false;
  archiveBtn.disabled = true;
}

function hideUpgradeBanner() {
  upgradeBanner.hidden = true;
}

// --- Archive (primary URL input) ---
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
  startCagingMessages();

  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    // Update usage from response headers (skip for Pro)
    if (!isPro) {
      const remaining = res.headers.get("X-RateLimit-Remaining");
      if (remaining !== null) {
        const limit = parseInt(res.headers.get("X-RateLimit-Limit") || FREE_LIMIT, 10);
        renderUsage(parseInt(remaining, 10), limit);
      }
    }

    // Needs auth — show sign-in prompt
    if (res.status === 401 && data.requireAuth) {
      stopCagingMessages();
      cageArea.className = "cage-area";
      cageStatus.textContent = "Paste a URL and cage that page";
      showAuthPrompt();
      return;
    }

    if (res.status === 429) {
      stopCagingMessages();
      cageArea.className = "cage-area";
      cageStatus.textContent = "Paste a URL and cage that page";
      if (!isPro) renderUsage(0, FREE_LIMIT);
      return;
    }

    if (!res.ok) {
      if (data.fallbackUrl) {
        lastFailedUrl = url;
        showPasteFallback(data.error, data.fallbackUrl);
      } else {
        showError(data.error || "Failed to cage article.");
      }
      throw new Error(data.error || "Failed to cage article.");
    }

    currentArticle = { ...data, sourceUrl: url };

    articleTitle.textContent = data.title || "Untitled";
    const metaParts = [];
    if (data.byline) metaParts.push(data.byline);
    if (data.siteName) metaParts.push(data.siteName);
    articleMeta.textContent = metaParts.join(" \u2014 ");
    articleExcerpt.textContent = data.excerpt || "";

    stopCagingMessages();
    cageArea.className = "cage-area caged";
    cageStatus.textContent = "Page caged!";
    result.hidden = false;

    saveToHistory(currentArticle);

    // After first successful cage, show auth prompt for unauthenticated users
    if (!isAuthenticated) {
      showAuthPrompt(true);
    }
  } catch (err) {
    stopCagingMessages();
    cageArea.className = "cage-area";
    cageStatus.textContent = "Paste a URL and cage that page";
    if (errorMsg.hidden) showError(err.message);
  } finally {
    archiveBtn.disabled = false;
  }
}

// --- Parallel URL rows (Pro feature) ---
function addUrlRow() {
  const count = urlRowsContainer.children.length;
  if (count >= MAX_PARALLEL_ROWS) return;

  const id = ++urlRowId;
  const row = document.createElement("div");
  row.className = "url-row";
  row.dataset.id = id;

  row.innerHTML = `
    <input type="url" class="url-row-input" placeholder="https://example.com/article..." autocomplete="off" spellcheck="false">
    <button class="url-row-btn" type="button">Cage</button>
    <div class="url-row-status"></div>
    <button class="url-row-delete" type="button" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>
  `;

  const input = row.querySelector(".url-row-input");
  const btn = row.querySelector(".url-row-btn");
  const deleteBtn = row.querySelector(".url-row-delete");

  btn.addEventListener("click", () => archiveRow(id));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") archiveRow(id);
  });
  deleteBtn.addEventListener("click", () => removeUrlRow(id));

  urlRowsContainer.appendChild(row);
  input.focus();
  updateAddUrlBtn();
}

function removeUrlRow(id) {
  const row = urlRowsContainer.querySelector(`[data-id="${id}"]`);
  if (row) row.remove();
  updateAddUrlBtn();
}

function updateAddUrlBtn() {
  const count = urlRowsContainer.children.length;
  addUrlBtn.hidden = !isPro || count >= MAX_PARALLEL_ROWS;
}

async function archiveRow(id) {
  const row = urlRowsContainer.querySelector(`[data-id="${id}"]`);
  if (!row) return;

  const input = row.querySelector(".url-row-input");
  const btn = row.querySelector(".url-row-btn");
  const statusEl = row.querySelector(".url-row-status");
  const url = input.value.trim();

  if (!url) return;

  try { new URL(url); } catch {
    statusEl.innerHTML = '<span style="color:var(--error-text)">Invalid URL</span>';
    return;
  }

  btn.disabled = true;
  input.disabled = true;
  row.className = "url-row caging";
  statusEl.innerHTML = '<div class="url-row-spinner"></div><span>Caging\u2026</span>';

  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (res.status === 429) {
      row.className = "url-row error";
      statusEl.innerHTML = '<span style="color:var(--error-text)">Rate limited</span>';
      return;
    }

    if (!res.ok) {
      if (data.fallbackUrl) {
        row.className = "url-row needs-paste";
        statusEl.innerHTML = `<svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg><a href="${escapeHtml(data.fallbackUrl)}" target="_blank" rel="noopener">Backup reader</a>`;
      } else {
        row.className = "url-row error";
        statusEl.innerHTML = `<span style="color:var(--error-text)">${escapeHtml(data.error || "Failed")}</span>`;
      }
      return;
    }

    // Success
    row.className = "url-row caged";
    const article = { ...data, sourceUrl: url };
    saveToHistory(article);

    statusEl.innerHTML = '<svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><button class="url-row-pdf-btn" type="button">PDF</button>';
    statusEl.querySelector(".url-row-pdf-btn").addEventListener("click", (e) => {
      downloadPdf(article, e.target);
    });
  } catch (err) {
    row.className = "url-row error";
    statusEl.innerHTML = `<span style="color:var(--error-text)">Network error</span>`;
  } finally {
    btn.disabled = false;
    input.disabled = false;
  }
}

// --- PDF Download ---
async function downloadPdf(article, btn) {
  if (!article) return;

  const targetBtn = btn || pdfBtn;
  const strong = targetBtn.querySelector("strong");
  const origText = strong ? strong.textContent : targetBtn.textContent;
  targetBtn.disabled = true;
  if (strong) {
    strong.textContent = "Generating PDF\u2026";
  } else {
    targetBtn.textContent = "\u2026";
  }

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
    if (strong) {
      strong.textContent = origText;
    } else {
      targetBtn.textContent = origText;
    }
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
  const filtered = history.filter((h) => h.sourceUrl !== article.sourceUrl);

  filtered.unshift({
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    articleDate: article.articleDate || null,
    textContent: article.textContent,
    excerpt: article.excerpt,
    sourceUrl: article.sourceUrl,
    cagedAt: new Date().toISOString(),
  });

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
    if (item.byline) metaParts.push(item.byline);
    if (item.articleDate) {
      metaParts.push(item.articleDate);
    } else {
      metaParts.push(formatDate(item.cagedAt));
    }

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
  errorMsg.textContent = "";
  errorMsg.hidden = true;
  hidePasteFallback();
}

function showPasteFallback(errorText, archiveUrl) {
  errorMsg.hidden = true;
  pasteArchiveLink.href = archiveUrl;
  pasteTextarea.value = "";
  pasteActions.hidden = true;
  pasteFallback.hidden = false;
}

function hidePasteFallback() {
  pasteFallback.hidden = true;
  pasteTextarea.value = "";
  pasteActions.hidden = true;
  lastFailedUrl = null;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatPastedText(raw) {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (/\n\s*\n/.test(text)) {
    return text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 0)
      .join("\n\n");
  }

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const paragraphs = [];
  let current = lines[0] || "";

  for (let i = 1; i < lines.length; i++) {
    const prev = current;
    const line = lines[i];
    const isSoftWrap =
      prev.length > 0 &&
      !/[.!?:;"\u201d]$/.test(prev) &&
      /^[a-z]/.test(line);

    if (isSoftWrap) {
      current += " " + line;
    } else {
      paragraphs.push(current);
      current = line;
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
