#!/usr/bin/env node

/**
 * SPA-Aware Site Crawler
 *
 * Handles React SPAs with hash routing (#/path), client-side routing,
 * and click-based navigation. Discovers routes by:
 *   1. Scanning <a href="..."> including hash links
 *   2. Clicking all nav/sidebar links and detecting URL changes
 *   3. Following any dynamically discovered routes
 *
 * Outputs self-contained HTML+CSS pages with no JavaScript.
 */

const { chromium } = require("playwright");
const fs = require("fs-extra");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

// ── Config ─────────────────────────────────────────────────────────────────
const BASE_URL = process.env.SITE_URL || "https://example.com";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./static-output";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "100", 10);
const WAIT_FOR_NETWORK = process.env.WAIT_FOR_NETWORK === "true";
const TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "30000", 10);
const DOWNLOAD_ASSETS = process.env.DOWNLOAD_ASSETS !== "false";
const RENDER_DELAY = parseInt(process.env.RENDER_DELAY || "3000", 10);

// ── State ──────────────────────────────────────────────────────────────────
const capturedRoutes = new Map(); // route key → { url, html, css, title, assets }
const downloadedAssets = new Map(); // original URL → local path
const discoveredRoutes = new Set(); // all route keys we've seen

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get a stable key for a route — handles both pathname and hash routing.
 * Examples:
 *   https://site.com/#/colors     → "#/colors"
 *   https://site.com/about        → "/about"
 *   https://site.com/#/           → "#/"
 *   https://site.com/             → "/"
 */
function routeKey(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.hash && url.hash.length > 1) {
      // Hash routing: #/colors, #/components, etc.
      return url.hash;
    }
    // Normal pathname routing
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

/**
 * Convert a route key to a safe filename
 * "#/colors"     → "colors.html"
 * "#/ai"         → "ai.html"
 * "#/"           → "index.html"
 * "/"            → "index.html"
 * "/about"       → "about.html"
 * "/docs/intro"  → "docs/intro.html"
 */
function routeToFilename(key) {
  let cleaned = key
    .replace(/^#\/?/, "") // remove leading #/
    .replace(/^\//, "")   // remove leading /
    .replace(/\/+$/, ""); // remove trailing /

  if (!cleaned) return "index.html";

  // Replace special chars
  cleaned = cleaned.replace(/[?&=]/g, "_");

  if (!cleaned.endsWith(".html")) {
    cleaned += ".html";
  }
  return cleaned;
}

function hashUrl(url) {
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}

function isInternalUrl(href) {
  try {
    const url = new URL(href, BASE_URL);
    const base = new URL(BASE_URL);
    return url.hostname === base.hostname;
  } catch {
    return false;
  }
}

// ── Asset Downloading ──────────────────────────────────────────────────────

async function downloadAsset(assetUrl, requestContext) {
  if (downloadedAssets.has(assetUrl)) return downloadedAssets.get(assetUrl);
  try {
    const parsed = new URL(assetUrl);
    const ext = path.extname(parsed.pathname).split("?")[0] || ".bin";
    const localName = `${hashUrl(assetUrl)}${ext}`;
    const localPath = path.join("assets", localName);
    const fullPath = path.join(OUTPUT_DIR, localPath);

    await fs.ensureDir(path.dirname(fullPath));
    const response = await requestContext.get(assetUrl);
    if (response.ok()) {
      await fs.writeFile(fullPath, await response.body());
      downloadedAssets.set(assetUrl, localPath);
      return localPath;
    }
  } catch {}
  return null;
}

// ── CSS Extraction ─────────────────────────────────────────────────────────

async function extractAllCSS(page) {
  return await page.evaluate(async () => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        let css = "";
        for (const rule of (sheet.cssRules || sheet.rules)) {
          css += rule.cssText + "\n";
        }
        if (css.trim()) results.push(css);
      } catch {
        if (sheet.href) {
          try {
            const r = await fetch(sheet.href);
            results.push(await r.text());
          } catch {}
        }
      }
    }
    return results;
  });
}

// ── HTML Extraction ────────────────────────────────────────────────────────

async function extractCleanHTML(page) {
  return await page.evaluate(() => {
    const clone = document.body.cloneNode(true);

    // Remove scripts, styles, framework noise
    clone.querySelectorAll("script, noscript, style, link[rel='stylesheet'], link[rel='preload'], link[rel='prefetch'], link[rel='modulepreload']")
      .forEach(el => el.remove());

    // Clean framework data- attributes
    const frameworkPrefixes = ["data-rh", "data-react", "data-next", "data-v-", "data-testid"];
    const exactAttrs = ["data-n-head", "data-server-rendered", "data-reactroot", "data-reactid"];

    clone.querySelectorAll("*").forEach(el => {
      const toRemove = [];
      for (const attr of el.attributes) {
        if (exactAttrs.includes(attr.name) ||
            frameworkPrefixes.some(p => attr.name.startsWith(p))) {
          toRemove.push(attr.name);
        }
      }
      toRemove.forEach(a => el.removeAttribute(a));
    });

    return clone.innerHTML;
  });
}

// ── Asset URL Discovery ────────────────────────────────────────────────────

async function extractAssetUrls(page) {
  return await page.evaluate(() => {
    const urls = new Set();
    document.querySelectorAll("img[src], source[src], video[src], video[poster]").forEach(el => {
      if (el.src) urls.add(el.src);
      if (el.poster) urls.add(el.poster);
    });
    document.querySelectorAll("[srcset]").forEach(el => {
      el.srcset.split(",").forEach(entry => {
        const u = entry.trim().split(/\s+/)[0];
        if (u) urls.add(u);
      });
    });
    // Background images in inline styles
    document.querySelectorAll("[style]").forEach(el => {
      const matches = el.style.cssText.match(/url\(["']?([^"')]+)["']?\)/g);
      if (matches) matches.forEach(m => {
        const u = m.replace(/url\(["']?/, "").replace(/["']?\)/, "");
        if (u.startsWith("http")) urls.add(u);
      });
    });
    return [...urls];
  });
}

// ── Route Discovery ────────────────────────────────────────────────────────

/**
 * Discovers all routes by scanning hrefs AND clicking navigation elements.
 * Returns an array of full URLs to visit.
 */
async function discoverAllRoutes(page) {
  const routes = new Set();

  // 1. Scan all <a href="..."> including hash links
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(a => {
      return { href: a.href, rawHref: a.getAttribute("href") };
    });
  });

  for (const { href, rawHref } of hrefs) {
    // Handle hash routes: href="#/colors" or raw "#/colors"
    if (rawHref && rawHref.startsWith("#")) {
      const fullUrl = new URL(BASE_URL);
      fullUrl.hash = rawHref;
      const key = routeKey(fullUrl.href);
      if (key) routes.add(fullUrl.href);
      continue;
    }

    // Handle normal internal links
    if (href && isInternalUrl(href)) {
      const key = routeKey(href);
      if (key) routes.add(href);
    }
  }

  // 2. Find clickable nav elements that might trigger route changes
  //    (React Router Links, sidebar items, nav buttons, etc.)
  const clickableSelectors = [
    "nav a", "nav button",
    "[class*='sidebar'] a", "[class*='sidebar'] button",
    "[class*='Sidebar'] a", "[class*='Sidebar'] button",
    "[class*='nav'] a", "[class*='nav'] button",
    "[class*='Nav'] a", "[class*='Nav'] button",
    "[class*='menu'] a", "[class*='menu'] button",
    "[class*='Menu'] a", "[class*='Menu'] button",
    "[role='navigation'] a", "[role='navigation'] button",
    "[class*='tab'] a", "[class*='tab'] button",
    "[class*='Tab'] a", "[class*='Tab'] button",
    // MUI-specific selectors
    ".MuiListItem-root", ".MuiListItemButton-root",
    ".MuiTab-root", ".MuiButton-root",
    "[class*='ListItem'] a", "[class*='ListItem'] button",
  ];

  const selector = clickableSelectors.join(", ");
  const clickTargets = await page.$$(selector);

  console.log(`    📍 Found ${routes.size} href routes + ${clickTargets.length} clickable nav elements`);

  for (const el of clickTargets) {
    try {
      const urlBefore = page.url();

      // Click and wait for potential navigation
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);

      const urlAfter = page.url();
      if (urlAfter !== urlBefore) {
        const key = routeKey(urlAfter);
        if (key) {
          routes.add(urlAfter);
        }
        // Navigate back so we can click the next element
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}
  }

  return [...routes];
}

// ── Page Capture ───────────────────────────────────────────────────────────

/**
 * Navigate to a specific route (handles both hash and pathname routing)
 * and capture the rendered content.
 */
async function captureRoute(page, url, requestContext) {
  const key = routeKey(url);
  if (!key || capturedRoutes.has(key)) return null;

  console.log(`  🌐 Capturing: ${key} (${url})`);

  try {
    // For hash routes, go to base URL first then set hash
    const parsedUrl = new URL(url);
    if (parsedUrl.hash && parsedUrl.hash.length > 1) {
      // Navigate to base URL if not already there
      const currentBase = page.url().split("#")[0];
      const targetBase = url.split("#")[0];
      if (currentBase !== targetBase) {
        await page.goto(targetBase, {
          waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
          timeout: TIMEOUT,
        });
        await page.waitForTimeout(1500);
      }

      // Set the hash to trigger React Router navigation
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, parsedUrl.hash);

      // Wait for content to render
      await page.waitForTimeout(RENDER_DELAY);
    } else {
      await page.goto(url, {
        waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
        timeout: TIMEOUT,
      });
      await page.waitForTimeout(RENDER_DELAY);
    }

    // Ensure body has content
    await page.waitForSelector("body *", { timeout: 5000 }).catch(() => {});

    // Extract content
    const [html, cssBlocks, assetUrls] = await Promise.all([
      extractCleanHTML(page),
      extractAllCSS(page),
      extractAssetUrls(page),
    ]);

    const title = await page.title();

    // Download assets
    if (DOWNLOAD_ASSETS) {
      for (const assetUrl of assetUrls) {
        await downloadAsset(assetUrl, requestContext);
      }
      for (const cssBlock of cssBlocks) {
        const urlMatches = cssBlock.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g) || [];
        for (const m of urlMatches) {
          const u = m.replace(/url\(["']?/, "").replace(/["']?\)/, "");
          await downloadAsset(u, requestContext);
        }
      }
    }

    // Discover additional routes from this page
    const newRoutes = await discoverAllRoutes(page);

    const result = {
      key,
      url,
      title,
      html,
      css: cssBlocks.join("\n\n"),
      newRoutes,
    };

    capturedRoutes.set(key, result);
    return result;
  } catch (err) {
    console.error(`  ❌ Error capturing ${key}: ${err.message}`);
    return null;
  }
}

// ── Link Rewriting ─────────────────────────────────────────────────────────

/**
 * Rewrite all internal links in HTML to point to local .html files.
 * Handles hash routes (#/path) and pathname routes.
 */
function rewriteLinks(html, currentKey) {
  let result = html;
  const currentFile = routeToFilename(currentKey);
  const currentDir = path.dirname(currentFile);

  for (const [key] of capturedRoutes) {
    const targetFile = routeToFilename(key);
    let rel = path.relative(currentDir, targetFile);
    if (!rel.startsWith(".")) rel = "./" + rel;

    // Rewrite hash-style hrefs: href="#/colors" etc.
    if (key.startsWith("#")) {
      result = result.split(`href="${key}"`).join(`href="${rel}"`);
      // Also handle without leading slash: href="#colors"
      const noSlash = key.replace("#/", "#");
      result = result.split(`href="${noSlash}"`).join(`href="${rel}"`);
    }

    // Rewrite pathname-style hrefs
    const pathname = key.startsWith("#") ? null : key;
    if (pathname) {
      result = result.split(`href="${pathname}"`).join(`href="${rel}"`);
      result = result.split(`href="${pathname}/"`).join(`href="${rel}"`);
      // Full URL form
      for (const [, r] of capturedRoutes) {
        if (routeKey(r.url) === key) {
          result = result.split(`href="${r.url}"`).join(`href="${rel}"`);
          result = result.split(`href="${r.url}/"`).join(`href="${rel}"`);
        }
      }
    }
  }

  return result;
}

function rewriteAssetUrls(content, currentKey) {
  let result = content;
  const currentFile = routeToFilename(currentKey);
  const currentDir = path.dirname(currentFile);

  for (const [originalUrl, localPath] of downloadedAssets) {
    const rel = path.relative(currentDir, localPath);
    result = result.split(originalUrl).join(rel.startsWith(".") ? rel : "./" + rel);
  }
  return result;
}

// ── Output Building ────────────────────────────────────────────────────────

function buildPage(route) {
  let html = rewriteLinks(route.html, route.key);
  html = rewriteAssetUrls(html, route.key);
  let css = rewriteAssetUrls(route.css, route.key);

  const safeTitle = (route.title || "Untitled")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
  console.log(`\n🚀 SPA-Aware Site Crawler`);
  console.log(`   Source:       ${BASE_URL}`);
  console.log(`   Output:       ${OUTPUT_DIR}`);
  console.log(`   Max pages:    ${MAX_PAGES}`);
  console.log(`   Render delay: ${RENDER_DELAY}ms`);
  console.log(`   Assets:       ${DOWNLOAD_ASSETS ? "download" : "skip"}\n`);

  // Clean slate
  await fs.remove(OUTPUT_DIR);
  await fs.ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; StaticSiteCrawler/1.0)",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // ── Step 1: Load the site and discover initial routes ────────────────
  console.log("📡 Loading site and discovering routes...\n");

  await page.goto(BASE_URL, {
    waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
    timeout: TIMEOUT,
  });
  await page.waitForTimeout(RENDER_DELAY);

  // Capture the landing page first
  const landingKey = routeKey(page.url()) || "/";
  const landingHtml = await extractCleanHTML(page);
  const landingCss = await extractAllCSS(page);
  const landingTitle = await page.title();
  const landingAssets = await extractAssetUrls(page);

  if (DOWNLOAD_ASSETS) {
    for (const u of landingAssets) await downloadAsset(u, context.request);
    for (const css of landingCss) {
      const matches = css.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g) || [];
      for (const m of matches) {
        await downloadAsset(m.replace(/url\(["']?/, "").replace(/["']?\)/, ""), context.request);
      }
    }
  }

  capturedRoutes.set(landingKey, {
    key: landingKey,
    url: page.url(),
    title: landingTitle,
    html: landingHtml,
    css: landingCss.join("\n\n"),
    newRoutes: [],
  });
  discoveredRoutes.add(landingKey);
  console.log(`  ✅ Landing: ${landingKey}\n`);

  // Discover routes from the landing page
  const initialRoutes = await discoverAllRoutes(page);
  console.log(`\n  📍 Discovered ${initialRoutes.length} initial routes\n`);

  // Add to queue
  const routeQueue = [...initialRoutes];
  for (const r of routeQueue) {
    discoveredRoutes.add(routeKey(r));
  }

  // ── Step 2: Crawl all discovered routes ──────────────────────────────
  while (routeQueue.length > 0 && capturedRoutes.size < MAX_PAGES) {
    const url = routeQueue.shift();
    const key = routeKey(url);

    if (!key || capturedRoutes.has(key)) continue;

    const result = await captureRoute(page, url, context.request);

    if (result && result.newRoutes) {
      for (const newUrl of result.newRoutes) {
        const newKey = routeKey(newUrl);
        if (newKey && !discoveredRoutes.has(newKey)) {
          discoveredRoutes.add(newKey);
          routeQueue.push(newUrl);
        }
      }
    }
  }

  await browser.close();

  // ── Step 3: Write static files ───────────────────────────────────────
  console.log(`\n📝 Writing ${capturedRoutes.size} static pages...\n`);

  const manifest = [];

  for (const [key, route] of capturedRoutes) {
    const filename = routeToFilename(key);
    const fullPath = path.join(OUTPUT_DIR, filename);

    const staticHTML = buildPage(route);

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, staticHTML, "utf-8");

    manifest.push({
      route: key,
      file: filename,
      url: route.url,
      title: route.title,
    });

    console.log(`  ✅ ${filename} (${key})`);
  }

  // Manifest
  await fs.writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  // Sitemap
  const sitemapEntries = manifest
    .map(m => `  <url><loc>${m.file}</loc></url>`)
    .join("\n");
  await fs.writeFile(
    path.join(OUTPUT_DIR, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}
</urlset>`,
    "utf-8"
  );

  // .nojekyll
  await fs.writeFile(path.join(OUTPUT_DIR, ".nojekyll"), "", "utf-8");

  // Site index page for easy navigation
  const indexLinks = manifest
    .map(m => `    <li><a href="${m.file}">${m.title || m.route}</a> <code>${m.route}</code></li>`)
    .join("\n");

  await fs.writeFile(
    path.join(OUTPUT_DIR, "_sitemap.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Site Map — ${BASE_URL}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    li { margin: 0.5rem 0; }
    code { color: #666; font-size: 0.85em; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>Static Site Map</h1>
  <p>Crawled from <code>${BASE_URL}</code> — ${manifest.length} pages</p>
  <ul>
${indexLinks}
  </ul>
</body>
</html>`,
    "utf-8"
  );

  console.log(`\n✨ Done! ${capturedRoutes.size} pages + ${downloadedAssets.size} assets`);
  console.log(`   Output: ${OUTPUT_DIR}\n`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
