#!/usr/bin/env node

/**
 * Site Crawler — Renders a React/JS site and outputs a deployable static HTML+CSS site
 *
 * Traverses all internal links using Playwright, captures rendered HTML and CSS,
 * rewrites links for static hosting, and downloads assets (images, fonts, etc.)
 */

const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

// ── Configuration ──────────────────────────────────────────────────────────
const BASE_URL = process.env.SITE_URL || "https://example.com";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./static-output";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "100", 10);
const WAIT_FOR_NETWORK = process.env.WAIT_FOR_NETWORK === "true";
const TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "30000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const DOWNLOAD_ASSETS = process.env.DOWNLOAD_ASSETS !== "false";

// ── State ──────────────────────────────────────────────────────────────────
const visited = new Set();
const queue = [];
const results = [];
const downloadedAssets = new Map(); // original URL → local relative path

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isInternalUrl(href) {
  try {
    const url = new URL(href);
    const base = new URL(BASE_URL);
    return url.hostname === base.hostname;
  } catch {
    return false;
  }
}

function urlToFilePath(pageUrl) {
  const url = new URL(pageUrl);
  let pathname = url.pathname;
  if (pathname === "/" || pathname === "") {
    pathname = "/index";
  }
  pathname = pathname.replace(/\/+$/, "");
  if (!pathname.endsWith(".html")) {
    pathname += ".html";
  }
  return pathname;
}

function getRelativePath(fromPageUrl, toPageUrl) {
  const fromPath = urlToFilePath(fromPageUrl);
  const toPath = urlToFilePath(toPageUrl);
  const fromDir = path.dirname(fromPath);
  let rel = path.relative(fromDir, toPath);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function hashUrl(url) {
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}

async function downloadAsset(assetUrl, page) {
  if (downloadedAssets.has(assetUrl)) return downloadedAssets.get(assetUrl);

  try {
    const parsed = new URL(assetUrl);
    const ext = path.extname(parsed.pathname).split("?")[0] || ".bin";
    const hash = hashUrl(assetUrl);
    const localName = `${hash}${ext}`;
    const localPath = path.join("assets", localName);
    const fullPath = path.join(OUTPUT_DIR, localPath);

    await fs.ensureDir(path.dirname(fullPath));

    const response = await page.context().request.get(assetUrl);
    if (response.ok()) {
      const buffer = await response.body();
      await fs.writeFile(fullPath, buffer);
      downloadedAssets.set(assetUrl, localPath);
      return localPath;
    }
  } catch {
    // Silently skip failed downloads
  }
  return null;
}

async function extractAllCSS(page) {
  return await page.evaluate(async () => {
    const cssTexts = [];
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        let sheetCSS = "";
        for (const rule of rules) {
          sheetCSS += rule.cssText + "\n";
        }
        if (sheetCSS.trim()) {
          cssTexts.push({ source: sheet.href || "inline", css: sheetCSS });
        }
      } catch {
        if (sheet.href) {
          try {
            const resp = await fetch(sheet.href);
            const text = await resp.text();
            cssTexts.push({ source: sheet.href, css: text });
          } catch {}
        }
      }
    }
    return cssTexts;
  });
}

async function extractCleanHTML(page) {
  return await page.evaluate(() => {
    const clone = document.body.cloneNode(true);

    clone
      .querySelectorAll("script, noscript, style")
      .forEach((el) => el.remove());
    clone
      .querySelectorAll(
        'link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"]'
      )
      .forEach((el) => el.remove());

    clone.querySelectorAll("*").forEach((el) => {
      const remove = [];
      for (const attr of el.attributes) {
        if (
          attr.name.startsWith("data-rh") ||
          attr.name.startsWith("data-react") ||
          attr.name.startsWith("data-next") ||
          attr.name === "data-n-head" ||
          attr.name === "data-server-rendered" ||
          attr.name === "data-reactroot" ||
          attr.name === "data-reactid"
        ) {
          remove.push(attr.name);
        }
      }
      remove.forEach((a) => el.removeAttribute(a));
    });

    return clone.innerHTML;
  });
}

async function extractAssetUrls(page) {
  return await page.evaluate(() => {
    const urls = new Set();
    document
      .querySelectorAll(
        "img[src], source[src], video[src], video[poster], picture source[srcset]"
      )
      .forEach((el) => {
        if (el.src) urls.add(el.src);
        if (el.poster) urls.add(el.poster);
        if (el.srcset) {
          el.srcset.split(",").forEach((entry) => {
            const url = entry.trim().split(/\s+/)[0];
            if (url) urls.add(url);
          });
        }
      });
    // Inline style background images
    document.querySelectorAll("[style]").forEach((el) => {
      const matches = el.style.cssText.match(
        /url\(["']?([^"')]+)["']?\)/g
      );
      if (matches) {
        matches.forEach((m) => {
          const url = m.replace(/url\(["']?/, "").replace(/["']?\)/, "");
          if (url.startsWith("http")) urls.add(url);
        });
      }
    });
    return Array.from(urls);
  });
}

async function discoverLinks(page) {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map((a) => a.href)
  );
  const links = [];
  for (const href of hrefs) {
    const normalized = normalizeUrl(href, BASE_URL);
    if (normalized && isInternalUrl(normalized) && !visited.has(normalized)) {
      links.push(normalized);
    }
  }
  return [...new Set(links)];
}

function rewriteLinks(html, currentPageUrl, allCrawledUrls) {
  let result = html;
  const baseOrigin = new URL(BASE_URL).origin;

  for (const crawledUrl of allCrawledUrls) {
    const url = new URL(crawledUrl);
    const relativePath = getRelativePath(currentPageUrl, crawledUrl);
    const patterns = [
      `href="${crawledUrl}"`,
      `href="${crawledUrl}/"`,
      `href="${url.pathname}"`,
      `href="${url.pathname}/"`,
    ];
    for (const pattern of patterns) {
      result = result.split(pattern).join(`href="${relativePath}"`);
    }
  }

  // Point uncrawled root-relative links back to source
  result = result.replace(/href="\/([^"]*?)"/g, (match, p1) => {
    if (match.includes(".html")) return match;
    return `href="${baseOrigin}/${p1}"`;
  });

  return result;
}

function rewriteAssetUrls(html, currentPageUrl) {
  let result = html;
  const currentDir = path.dirname(urlToFilePath(currentPageUrl));
  for (const [originalUrl, localPath] of downloadedAssets) {
    const rel = path.relative(currentDir, localPath);
    result = result.split(originalUrl).join(rel.startsWith(".") ? rel : "./" + rel);
  }
  return result;
}

function rewriteCSSAssetUrls(css, currentPageUrl) {
  let result = css;
  const currentDir = path.dirname(urlToFilePath(currentPageUrl));
  for (const [originalUrl, localPath] of downloadedAssets) {
    const rel = path.relative(currentDir, localPath);
    result = result.split(originalUrl).join(rel.startsWith(".") ? rel : "./" + rel);
  }
  return result;
}

async function processPage(page, pageUrl) {
  console.log(`  🌐 Crawling: ${pageUrl}`);
  try {
    await page.goto(pageUrl, {
      waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page.waitForTimeout(2000);
    await page.waitForSelector("body *", { timeout: 5000 }).catch(() => {});

    const [html, cssBlocks, links, assetUrls] = await Promise.all([
      extractCleanHTML(page),
      extractAllCSS(page),
      discoverLinks(page),
      extractAssetUrls(page),
    ]);

    // Download assets
    if (DOWNLOAD_ASSETS) {
      for (const assetUrl of assetUrls) {
        await downloadAsset(assetUrl, page);
      }
      for (const block of cssBlocks) {
        const urlMatches =
          block.css.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g) || [];
        for (const m of urlMatches) {
          const url = m.replace(/url\(["']?/, "").replace(/["']?\)/, "");
          await downloadAsset(url, page);
        }
      }
    }

    const title = await page.title();
    return { url: pageUrl, title, html, cssBlocks, links, error: null };
  } catch (err) {
    console.error(`  ❌ Error: ${pageUrl}: ${err.message}`);
    return {
      url: pageUrl,
      title: "",
      html: "",
      cssBlocks: [],
      links: [],
      error: err.message,
    };
  }
}

function buildStaticPage(title, bodyHtml, combinedCSS, currentPageUrl, allCrawledUrls) {
  let html = rewriteLinks(bodyHtml, currentPageUrl, allCrawledUrls);
  html = rewriteAssetUrls(html, currentPageUrl);
  let css = rewriteCSSAssetUrls(combinedCSS, currentPageUrl);

  const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
${css}
  </style>
</head>
<body>
${html}
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Static Site Crawler`);
  console.log(`   Source:      ${BASE_URL}`);
  console.log(`   Output:      ${OUTPUT_DIR}`);
  console.log(`   Max pages:   ${MAX_PAGES}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Assets:      ${DOWNLOAD_ASSETS ? "download" : "skip"}\n`);

  // Clean output dir for a fresh overwrite every run
  await fs.remove(OUTPUT_DIR);
  await fs.ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const seedUrl = normalizeUrl(BASE_URL, BASE_URL);
  queue.push(seedUrl);
  visited.add(seedUrl);

  while (queue.length > 0 && results.length < MAX_PAGES) {
    const batch = queue.splice(0, CONCURRENCY);
    const promises = batch.map(async (url) => {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; StaticSiteCrawler/1.0)",
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      try {
        const result = await processPage(page, url);
        results.push(result);
        for (const link of result.links) {
          if (!visited.has(link) && visited.size < MAX_PAGES) {
            visited.add(link);
            queue.push(link);
          }
        }
      } finally {
        await context.close();
      }
    });
    await Promise.all(promises);
  }

  await browser.close();

  // ── Write output ─────────────────────────────────────────────────────
  console.log(`\n📝 Writing ${results.length} static pages...\n`);

  const allCrawledUrls = results.filter((r) => !r.error).map((r) => r.url);
  const manifest = [];

  for (const result of results) {
    if (result.error || !result.html) continue;

    const filePath = urlToFilePath(result.url);
    const fullPath = path.join(OUTPUT_DIR, filePath);
    const combinedCSS = result.cssBlocks.map((b) => b.css).join("\n\n");

    const staticHTML = buildStaticPage(
      result.title,
      result.html,
      combinedCSS,
      result.url,
      allCrawledUrls
    );

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, staticHTML, "utf-8");

    manifest.push({
      url: result.url,
      file: filePath,
      title: result.title,
      cssSourceCount: result.cssBlocks.length,
    });

    console.log(`  ✅ ${filePath}`);
  }

  // Manifest
  await fs.writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  // Sitemap
  const sitemapEntries = manifest
    .map((m) => `  <url><loc>${m.file}</loc></url>`)
    .join("\n");
  await fs.writeFile(
    path.join(OUTPUT_DIR, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}
</urlset>`,
    "utf-8"
  );

  // .nojekyll — tells GitHub Pages to serve files as-is (no Jekyll processing)
  await fs.writeFile(path.join(OUTPUT_DIR, ".nojekyll"), "", "utf-8");

  console.log(
    `\n✨ Done! ${manifest.length} pages + ${downloadedAssets.size} assets written to ${OUTPUT_DIR}\n`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
