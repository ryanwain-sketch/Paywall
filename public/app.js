const urlInput = document.getElementById("url-input");
const archiveBtn = document.getElementById("archive-btn");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const errorMsg = document.getElementById("error-msg");
const result = document.getElementById("result");
const pdfBtn = document.getElementById("pdf-btn");

const articleTitle = document.getElementById("article-title");
const articleMeta = document.getElementById("article-meta");
const articleExcerpt = document.getElementById("article-excerpt");

let currentArticle = null;

archiveBtn.addEventListener("click", archive);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") archive();
});
pdfBtn.addEventListener("click", downloadPdf);

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
  loading.hidden = false;
  loadingText.textContent = "Fetching article...";
  archiveBtn.disabled = true;

  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to archive article.");
    }

    currentArticle = { ...data, sourceUrl: url };

    articleTitle.textContent = data.title || "Untitled";
    const metaParts = [];
    if (data.byline) metaParts.push(data.byline);
    if (data.siteName) metaParts.push(data.siteName);
    articleMeta.textContent = metaParts.join(" — ");
    articleExcerpt.textContent = data.excerpt || "";

    loading.hidden = true;
    result.hidden = false;
  } catch (err) {
    loading.hidden = true;
    showError(err.message);
  } finally {
    archiveBtn.disabled = false;
  }
}

async function downloadPdf() {
  if (!currentArticle) return;

  pdfBtn.disabled = true;
  const btnText = pdfBtn.querySelector(".pdf-btn-text strong");
  const origText = btnText.textContent;
  btnText.textContent = "Generating PDF...";

  try {
    const res = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentArticle),
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
    pdfBtn.disabled = false;
    btnText.textContent = origText;
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}
