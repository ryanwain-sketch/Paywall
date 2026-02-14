const express = require("express");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const PDFDocument = require("pdfkit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Failed to fetch URL (HTTP ${response.status})` });
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return res
        .status(422)
        .json({ error: "Could not extract article content from this URL" });
    }

    res.json({
      title: article.title,
      byline: article.byline,
      siteName: article.siteName,
      content: article.content,
      textContent: article.textContent,
      excerpt: article.excerpt,
      length: article.length,
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
      .text(`Archived with Web Archiver — PDF generated ${dateStr}`, {
        align: "center",
      });

    doc.end();
  } catch (err) {
    console.error("PDF error:", err.message);
    res.status(500).json({ error: `Failed to generate PDF: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Web Archiver running at http://localhost:${PORT}`);
});
