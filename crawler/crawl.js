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
 * Captures content by clicking navigation elements (not just setting hash),
 * ensuring React Router state updates properly.
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
const navMap = new Map(); // route key → { label, icon } for building navigation

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a route key — collapses #/ and / to the same key.
 * Examples:
 *   https://site.com/#/colors     → "#/colors"
 *   https://site.com/about        → "/about"
 *   https://site.com/#/           → "/"        ← normalized!
 *   https://site.com/             → "/"
 */
function routeKey(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.hash && url.hash.length > 1) {
      // Normalize #/ to / (they're the same landing page)
      const hashPath = url.hash.replace(/^#\/?/, "").replace(/\/+$/, "");
      if (!hashPath) return "/";
      return "#/" + hashPath;
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

  // Skip downloading Google Fonts and other CDN font resources
  // These should remain as CDN URLs for better performance and reliability
  try {
    const parsed = new URL(assetUrl);
    if (parsed.hostname.includes('googleapis.com') ||
        parsed.hostname.includes('gstatic.com') ||
        parsed.hostname.includes('fonts.net') ||
        parsed.hostname.includes('typekit.net')) {
      // Mark as "keep original URL" by not adding to downloadedAssets
      return null;
    }

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

// ── Clickable element selectors ────────────────────────────────────────────

const CLICKABLE_SELECTORS = [
  // Specific navigation selectors
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
  // Figma Make component cards and clickable elements
  "[data-slot='card'][class*='cursor-pointer']",
  "[class*='cursor-pointer'][role='button']",
  // Component listing page: links to component detail pages (Button, Tab, Badge, etc.)
  "a[href*='#/components/']", "a[href*='/components/']",
  "[class*='card'] a", "[class*='Card'] a",
  "[class*='card']", "[class*='Card']",
  // Generic button/link selectors (for Figma sites with generic Tailwind classes)
  "button", "a[href]",
].join(", ");

// ── Content fingerprinting ──────────────────────────────────────────────────

/**
 * Get a quick fingerprint of the page's main content area.
 * Used to detect when a click changes the visible content even if the URL
 * doesn't change (common in SPAs that use React state for navigation).
 *
 * Compares heading text (h1-h3) — the most reliable signal for whether
 * the "page" actually changed. Element count alone is too noisy
 * (sidebar collapse, animations, etc.).
 */
async function getContentFingerprint(page) {
  return await page.evaluate(() => {
    // Primary signal: heading text in the main content area
    // Exclude headings in nav/sidebar to avoid false negatives
    const allHeadings = Array.from(document.querySelectorAll("h1, h2, h3"));
    const contentHeadings = allHeadings.filter(h => {
      const parent = h.closest("nav, [class*='sidebar'], [class*='Sidebar'], [role='navigation']");
      return !parent;
    });
    const headingText = contentHeadings
      .slice(0, 8)
      .map(h => h.textContent.trim())
      .join("|");

    // Secondary signal: first few paragraphs
    const paragraphs = Array.from(document.querySelectorAll("p, [class*='description']"))
      .slice(0, 3)
      .map(p => p.textContent.trim().slice(0, 50))
      .join("|");

    return `${headingText}|||${paragraphs}`;
  });
}

/**
 * Derive a route key from a sidebar button's text label.
 * e.g., "palette Colors" → "#/colors", "widgets Components" → "#/components"
 */
function labelToRouteKey(label) {
  // Skip known non-navigation labels
  const skipPatterns = [
    /collapse/i, /expand/i, /search/i, /close/i, /toggle/i,
    /menu/i, /hamburger/i, /settings/i,
  ];
  if (skipPatterns.some(p => p.test(label))) return null;

  // Strip icon prefixes. Three formats:
  // 1. "palette Colors" (lowercase icon + space + Label)
  // 2. "paletteColors" (camelCase: lowercase icon + CamelLabel)
  // 3. "text_fieldsTypography" (snake_case icon + CamelLabel)
  let cleaned = label;

  // Format 1: "palette Colors" → "Colors"
  cleaned = cleaned.replace(/^[a-z_]+\s+/, "").trim();

  // Format 2 & 3: "paletteColors" or "text_fieldsTypography" → "Colors" or "Typography"
  // Match lowercase/underscore prefix up to first uppercase letter
  if (!cleaned.includes(" ")) {
    cleaned = cleaned.replace(/^[a-z_]+(?=[A-Z])/, "");
  }

  if (!cleaned) cleaned = label.trim();

  // Convert to slug: "Status Chips" → "status-chips", "Colors" → "colors"
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `#/${slug}` : null;
}

/**
 * When on the components listing page, derive component detail route from label.
 * "Button", "Button Complete", "Tab Complete" → "#/components/button", "#/components/tab"
 */
function labelToComponentDetailRouteKey(label) {
  if (!label || typeof label !== "string") return null;
  // Strip "Complete" badge and similar status text
  let cleaned = label
    .replace(/\s*Complete\s*/gi, " ")
    .replace(/\s*Beta\s*/gi, " ")
    .replace(/\s*New\s*/gi, " ")
    .trim();
  if (!cleaned) return null;
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `#/components/${slug}` : null;
}

/**
 * Get slug from a button/label for content-only route derivation.
 * "Button", "Tab 1" → "button", "tab-1"
 */
function labelToSlug(label) {
  if (!label || typeof label !== "string") return null;
  const k = labelToRouteKey(label);
  if (!k) return null;
  return k.replace(/^#\/?|\/$/g, "") || null;
}

/**
 * Derive route key when URL didn't change but content did (e.g. click opened a panel/tab).
 * Puts the new "page" under the current route: fromKey "#/overview" + "Usage" → "#/overview/usage"
 */
function deriveContentRouteKey(fromKey, label) {
  const slug = labelToSlug(label);
  if (!slug) return null;
  const base = (fromKey || "/").replace(/\/+$/, "").trim();
  const prefix = base.startsWith("#") ? "#/" : "/";
  const path = base.replace(/^#\/?|\/+$/g, "") || "";
  if (!path) return prefix + slug;
  return prefix + path + "/" + slug;
}

/**
 * Clean button/link text for use in breadcrumb (strip "Complete", icon prefix, etc.).
 */
function cleanLabelForBreadcrumb(label) {
  if (!label || typeof label !== "string") return "";
  let cleaned = label
    .replace(/\s*Complete\s*/gi, " ")
    .replace(/\s*Beta\s*/gi, " ")
    .replace(/\s*New\s*/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
  // Strip leading icon word: "palette Colors" → "Colors"
  cleaned = cleaned.replace(/^[a-z_]+\s+/, "").trim();
  // Strip camelCase icon prefix: "homeOverview" → "Overview", "text_fieldsTypography" → "Typography"
  if (!cleaned.includes(" ")) {
    cleaned = cleaned.replace(/^[a-z_]+(?=[A-Z])/, "");
  }
  return cleaned || label.trim();
}

/**
 * Derive a default breadcrumb label from a route key when we don't have one from a click.
 * "#/components/badge" → "Components/Badge", "#/colors" → "Colors"
 */
function keyToDefaultLabel(key) {
  if (!key || key === "/") return "Overview";
  const path = key.replace(/^#\/?|\/+$/g, "").trim();
  if (!path) return "Overview";
  const segments = path.split("/").filter(Boolean);
  return segments
    .map(seg => seg.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()))
    .join("/");
}

// ── Seed sidebar routes (guarantee main nav pages are in the queue) ───────

const BASE_NAV_KEYWORDS = [
  "overview", "colors", "typography", "spacing", "components", "iconography", "navigation",
  "home", "about", "docs", "guide", "api"
];

/**
 * Collect sidebar/nav button labels directly from the page.
 * Works even when there is no <nav>, no <a href>, no role=navigation —
 * just plain <button> elements with text like "home Overview", "palette Colors", etc.
 *
 * Strategy: find ALL buttons on the page whose text (after stripping icon prefixes)
 * matches a known base-page keyword. Return them as { label } items.
 */
async function seedSidebarRoutesFromPage(page) {
  const items = await page.evaluate((navKeywords) => {
    const results = [];
    const seen = new Set();
    // Collect from buttons AND links
    const elements = document.querySelectorAll("button, a[href]");
    elements.forEach((el) => {
      const rawText = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (rawText.length === 0 || rawText.length > 80) return;
      // Strip icon prefix: "home Overview" → "Overview", "palette Colors" → "Colors"
      const cleaned = rawText.replace(/^[a-z_]+\s+/i, "").trim();
      const lower = (cleaned || rawText).toLowerCase();
      const hasNavKeyword = navKeywords.some(kw => lower === kw || lower.includes(kw));
      if (!hasNavKeyword) return;
      // Avoid duplicates and non-nav items
      const dedup = cleaned.toLowerCase();
      if (seen.has(dedup)) return;
      seen.add(dedup);
      // Get href if it's a link
      let href = null;
      if (el.tagName === "A") href = el.getAttribute("href");
      results.push({ rawText, cleaned, href });
    });
    return results;
  }, BASE_NAV_KEYWORDS);

  console.log(`    🔎 seedSidebarRoutesFromPage found ${items.length} nav items: ${items.map(i => i.cleaned).join(", ")}`);

  const base = BASE_URL.replace(/\/$/, "");
  const results = [];
  const seenKeys = new Set();
  for (const { rawText, cleaned, href } of items) {
    let key = null;
    if (href && href.startsWith("#")) {
      const u = new URL(base);
      u.hash = href;
      key = routeKey(u.href);
    } else if (href && !href.startsWith("http") && !href.startsWith("//")) {
      try { key = routeKey(new URL(href, base).href); } catch {}
    }
    if (!key) {
      key = labelToRouteKey(rawText);
    }
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      results.push({
        key,
        url: `${base}${key}`,
        label: cleanLabelForBreadcrumb(cleaned || rawText),
        buttonText: rawText, // exact text to find the button later
      });
    }
  }
  return results;
}

// ── Route Discovery (click-based with capture) ─────────────────────────────

/**
 * Collect all clickable labels (buttons, links, cards) from the current page.
 * Returns an array of { text, cleaned } strings — no element handles stored.
 * This is safe across navigations: we re-find the element by text each time.
 */
const CLICKABLE_QUERY = "button, a[href], [role='button'], [role='tab'], [tabindex='0'], [class*='cursor-pointer']";

async function collectClickableLabels(page) {
  return await page.evaluate((clickableQuery) => {
    const results = [];
    const seen = new Set();
    const skipPatterns = /collapse|search design|view ai|^copy$/i;

    // Gather from standard clickable elements
    document.querySelectorAll(clickableQuery).forEach((el) => {
      const raw = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (raw.length === 0 || raw.length > 200) return;
      if (skipPatterns.test(raw)) return;
      if (seen.has(raw)) return;
      seen.add(raw);
      const heading = el.querySelector("h1, h2, h3, h4");
      const shortLabel = heading ? (heading.textContent || "").trim().replace(/\s+/g, " ") : null;
      results.push({ text: raw, shortLabel });
    });

    // Also look for "card-like" divs: elements that have an h3 inside and look clickable
    // (have border/rounded styling, arrow icon, or cursor-pointer in any ancestor)
    document.querySelectorAll("div").forEach((el) => {
      const h3 = el.querySelector("h3");
      if (!h3) return;
      // Only consider direct card containers (not deeply nested wrappers)
      const parentH3s = el.querySelectorAll("h3");
      if (parentH3s.length > 1) return; // skip wrapper divs that contain multiple cards
      const raw = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (raw.length === 0 || raw.length > 200) return;
      if (seen.has(raw)) return;
      // Must look "card-like": has border, rounded corners, arrow, or explicit click handler
      const style = window.getComputedStyle(el);
      const hasBorder = style.borderWidth !== "0px" && style.borderStyle !== "none";
      const hasRounded = style.borderRadius !== "0px";
      const hasArrow = el.querySelector("svg, [class*='arrow'], [class*='chevron']") !== null;
      const hasCursor = style.cursor === "pointer";
      if (!hasBorder && !hasRounded && !hasArrow && !hasCursor) return;
      seen.add(raw);
      const shortLabel = (h3.textContent || "").trim().replace(/\s+/g, " ");
      results.push({ text: raw, shortLabel: shortLabel || null });
    });

    return results;
  }, CLICKABLE_QUERY);
}

/**
 * Find and click a button/link by its text content.
 * Re-queries the DOM each time so we never use stale handles.
 * Returns true if the element was found and clicked.
 */
async function clickByText(page, text) {
  const clicked = await page.evaluate(({ targetText, clickableQuery }) => {
    // First try standard clickable elements
    const elements = document.querySelectorAll(clickableQuery);
    for (const el of elements) {
      const t = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (t === targetText) {
        el.click();
        return true;
      }
    }
    // Then try card-like divs (with h3 inside)
    const divs = document.querySelectorAll("div");
    for (const el of divs) {
      if (!el.querySelector("h3")) continue;
      const t = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (t === targetText) {
        el.click();
        return true;
      }
    }
    return false;
  }, { targetText: text, clickableQuery: CLICKABLE_QUERY });
  return clicked;
}

/**
 * Discover routes AND capture content by clicking navigation elements.
 *
 * Strategy: collect all clickable labels ONCE, then iterate through them.
 * For each label: reload the "from" page, find the element by text, click it,
 * check if content changed, capture if so.
 *
 * This avoids stale element handles entirely — we never store Playwright ElementHandles
 * across navigations.
 *
 * Builds a breadcrumb trail from the path of clicks: e.g. "Components/Badge".
 *
 * Returns an array of newly discovered route URLs.
 *
 * navigateToFromPage: async function that navigates the page back to the "from" page.
 * excludeLabels: Set of button texts to skip (e.g. sidebar base-page buttons when crawling sub-pages).
 */
async function discoverAndCapture(page, requestContext, fromKey, fromBreadcrumb, navigateToFromPage, excludeLabels) {
  const newRouteUrls = [];
  const effectiveBreadcrumb = fromBreadcrumb != null ? fromBreadcrumb : (navMap.get(fromKey)?.label ?? keyToDefaultLabel(fromKey));
  const isTopLevel = !fromKey || fromKey === "/" || fromKey === "#/" || fromKey === "#";

  // Helper: go back to the "from" page (reload + click sidebar button if needed)
  async function goBackToFromPage() {
    if (navigateToFromPage) {
      await navigateToFromPage();
    } else {
      await page.goto(BASE_URL, { waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
      await page.waitForTimeout(RENDER_DELAY);
    }
  }

  // 1. Scan all <a href="..."> including hash links → just collect URLs
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(a => {
      return { href: a.href, rawHref: a.getAttribute("href") };
    });
  });

  for (const { href, rawHref } of hrefs) {
    if (rawHref && rawHref.startsWith("#")) {
      const fullUrl = new URL(BASE_URL);
      fullUrl.hash = rawHref;
      const key = routeKey(fullUrl.href);
      if (key && !discoveredRoutes.has(key) && !capturedRoutes.has(key)) {
        discoveredRoutes.add(key);
        newRouteUrls.push(fullUrl.href);
      }
      continue;
    }
    if (href && isInternalUrl(href)) {
      const key = routeKey(href);
      if (key && !discoveredRoutes.has(key) && !capturedRoutes.has(key)) {
        discoveredRoutes.add(key);
        newRouteUrls.push(href);
      }
    }
  }

  // 2. Collect all clickable labels from the current page (just text, no handles)
  const allLabels = await collectClickableLabels(page);
  const contentFingerprint = await getContentFingerprint(page);

  console.log(`    📍 Found ${newRouteUrls.length} href routes + ${allLabels.length} clickable labels`);

  // 3. Click each label, check content, capture if changed
  for (const { text, shortLabel } of allLabels) {
    // Skip sidebar base-page buttons when crawling sub-pages
    if (excludeLabels && excludeLabels.has(text)) continue;

    // Use shortLabel (heading text) for route key derivation when available
    const labelForKey = shortLabel || text;

    // Skip labels we know are already captured
    const cleaned = cleanLabelForBreadcrumb(labelForKey);
    const potentialKey = isTopLevel
      ? labelToRouteKey(labelForKey)
      : deriveContentRouteKey(fromKey, labelForKey);
    if (potentialKey && capturedRoutes.has(potentialKey)) continue;

    // Click the element by finding it fresh in the DOM
    const urlBefore = page.url();
    const contentBefore = await getContentFingerprint(page);

    const didClick = await clickByText(page, text);
    if (!didClick) continue;

    await page.waitForTimeout(1500);

    let urlAfter, contentAfter;
    try {
      urlAfter = page.url();
      contentAfter = await getContentFingerprint(page);
    } catch (err) {
      // Page might have hard-navigated; go back to from page and continue
      await goBackToFromPage();
      continue;
    }

    const urlChanged = urlAfter !== urlBefore;
    const contentChanged = contentAfter !== contentBefore;

    if (!urlChanged && !contentChanged) continue; // click did nothing

    // Determine the route key (use shortLabel/heading for clean slugs)
    let key;
    if (urlChanged) {
      key = routeKey(urlAfter);
    } else {
      const isFromComponentsListing = fromKey && (
        fromKey === "#/components" || fromKey === "/components"
      );
      if (isFromComponentsListing) {
        key = labelToComponentDetailRouteKey(labelForKey) || labelToRouteKey(labelForKey);
      } else if (isTopLevel) {
        key = labelToRouteKey(labelForKey);
      } else {
        key = deriveContentRouteKey(fromKey, labelForKey) || labelToRouteKey(labelForKey);
      }
    }

    if (!key || capturedRoutes.has(key)) {
      // Navigate back to the "from" page before trying the next label
      await goBackToFromPage();
      continue;
    }

    const displayLabel = cleanLabelForBreadcrumb(labelForKey);
    const newBreadcrumb = isTopLevel ? displayLabel : (effectiveBreadcrumb + "/" + displayLabel);
    console.log(`    🔀 Nav click → ${key} (${newBreadcrumb}) (url: ${urlChanged ? "changed" : "same"}, content: ${contentChanged ? "changed" : "same"})`);

    navMap.set(key, { label: newBreadcrumb });

    // Wait for content to fully render
    await page.waitForTimeout(RENDER_DELAY);
    await page.waitForSelector("body *", { timeout: 5000 }).catch(() => {});

    // Content fingerprint to detect duplicate content
    const fingerprint = await getContentFingerprint(page);
    const duplicateFingerprint = [...capturedRoutes.values()].some(r => r._fingerprint && r._fingerprint === fingerprint);
    if (duplicateFingerprint) {
      console.log(`    ⏭️  Skip ${key} — content identical to existing page (fingerprint match)`);
      await goBackToFromPage();
      continue;
    }

    // Capture content
    const [html, cssBlocks, assetUrls] = await Promise.all([
      extractCleanHTML(page),
      extractAllCSS(page),
      extractAssetUrls(page),
    ]);
    const title = await page.title();

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

    capturedRoutes.set(key, {
      key,
      url: urlChanged ? urlAfter : `${BASE_URL}#/${key.replace(/^#\//, "")}`,
      title,
      html,
      css: cssBlocks.join("\n\n"),
      newRoutes: [],
      _fingerprint: fingerprint,
    });
    discoveredRoutes.add(key);
    console.log(`    ✅ Captured ${key} via click`);

    // Discover sub-links from this page
    const subHrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]")).map(a => {
        return { href: a.href, rawHref: a.getAttribute("href") };
      });
    });
    for (const { href, rawHref } of subHrefs) {
      let fullUrl;
      if (rawHref && rawHref.startsWith("#")) {
        fullUrl = new URL(BASE_URL);
        fullUrl.hash = rawHref;
      } else if (href && isInternalUrl(href)) {
        fullUrl = new URL(href);
      }
      if (fullUrl) {
        const k = routeKey(fullUrl.href);
        if (k && !discoveredRoutes.has(k)) {
          discoveredRoutes.add(k);
          newRouteUrls.push(fullUrl.href);
        }
      }
    }

    // Navigate back to the "from" page so we can click the next label
    await goBackToFromPage();
  }

  return newRouteUrls;
}

// ── Page Capture (for routes not captured via click) ────────────────────────

/**
 * Navigate to a specific route and capture the rendered content.
 *
 * Strategy (in order):
 *   1. Full page.goto(url) — works when SPA reads hash on load
 *   2. Click matching sidebar item — works when SPA uses React state nav
 *   3. Verify content differs from landing page — skip if it's duplicate
 */
async function captureRoute(page, url, requestContext) {
  const key = routeKey(url);
  if (!key || capturedRoutes.has(key)) return null;

  // Skip the landing page key since it's already captured
  if (key === "/") return null;

  console.log(`  🌐 Capturing: ${key} (${url})`);

  try {
    // Step 1: Full page reload with the hash URL
    // This works if the SPA reads window.location.hash on initialization
    await page.goto(url, {
      waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page.waitForTimeout(RENDER_DELAY);

    // Step 2: Check if we got different content than the landing page
    const fingerprint = await getContentFingerprint(page);
    const landingRoute = capturedRoutes.get("/");
    let landingFingerprint = null;
    if (landingRoute) {
      // Quick check: does this page look like the landing page?
      // Compare heading text as a proxy
      landingFingerprint = landingRoute._fingerprint || null;
    }

    // Step 3: If content looks like landing page, try clicking sidebar
    const parsedUrl = new URL(url);
    const hashPath = (parsedUrl.hash || key).replace(/^#\/?/, "");

    if (hashPath && landingFingerprint && fingerprint === landingFingerprint) {
      console.log(`    🔄 Hash navigation didn't change content, trying sidebar click for "${hashPath}"...`);
      const clicked = await clickMatchingSidebarItem(page, hashPath);
      if (clicked) {
        await page.waitForTimeout(RENDER_DELAY);
      }
    }

    // Ensure body has content
    await page.waitForSelector("body *", { timeout: 5000 }).catch(() => {});

    // Final fingerprint check — skip if still duplicate of landing
    const finalFingerprint = await getContentFingerprint(page);
    if (landingFingerprint && finalFingerprint === landingFingerprint && key !== "/") {
      console.log(`    ⏭️  Skipping ${key} — content identical to landing page`);
      return null;
    }

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

    // Discover additional routes (href-only, don't click here)
    const newRoutes = await discoverHrefRoutes(page);

    // Also discover routes by clicking (for SPAs with content-only changes)
    // This is especially important for components pages with clickable cards
    const clickDiscoveredRoutes = await discoverAndCapture(page, requestContext, key);
    newRoutes.push(...clickDiscoveredRoutes);

    const result = {
      key,
      url,
      title,
      html,
      css: cssBlocks.join("\n\n"),
      newRoutes,
      _fingerprint: finalFingerprint,
    };

    if (!navMap.has(key)) {
      navMap.set(key, { label: keyToDefaultLabel(key) });
    }
    capturedRoutes.set(key, result);
    return result;
  } catch (err) {
    console.error(`  ❌ Error capturing ${key}: ${err.message}`);
    return null;
  }
}

/**
 * Try to click a sidebar element that matches the given route path.
 * This triggers React Router's internal navigation properly.
 */
async function clickMatchingSidebarItem(page, hashPath) {
  const segments = hashPath.split("/");
  const lastSegment = segments[segments.length - 1] || "";
  const searchTerms = [
    lastSegment.replace(/-/g, " "),
    lastSegment,
    hashPath,
  ].filter(Boolean);

  const buttons = await page.$$(CLICKABLE_SELECTORS);

  for (const term of searchTerms) {
    try {
      for (const btn of buttons) {
        const text = await btn.evaluate(e => (e.textContent || "").trim().toLowerCase());
        if (text.includes(term.toLowerCase())) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * Discover routes from <a href> only (no clicking), for use during capture.
 */
async function discoverHrefRoutes(page) {
  const routes = [];
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(a => {
      return { href: a.href, rawHref: a.getAttribute("href") };
    });
  });

  for (const { href, rawHref } of hrefs) {
    if (rawHref && rawHref.startsWith("#")) {
      const fullUrl = new URL(BASE_URL);
      fullUrl.hash = rawHref;
      const key = routeKey(fullUrl.href);
      if (key) routes.push(fullUrl.href);
      continue;
    }
    if (href && isInternalUrl(href)) {
      const key = routeKey(href);
      if (key) routes.push(href);
    }
  }
  return routes;
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
    let rel = path.relative(currentDir, targetFile).replace(/\\/g, "/");
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

  // Only rewrite URLs that were actually downloaded
  // Skip CDN URLs (fonts, etc.) that we intentionally preserved
  for (const [originalUrl, localPath] of downloadedAssets) {
    const rel = path.relative(currentDir, localPath).replace(/\\/g, "/");
    result = result.split(originalUrl).join(rel.startsWith(".") ? rel : "./" + rel);
  }
  return result;
}

// ── Navigation Injection ──────────────────────────────────────────────────

/**
 * Build a static navigation bar HTML that links to all captured pages.
 * This replaces the dead JavaScript-driven sidebar buttons.
 */
function buildNavBar(currentKey) {
  // Group routes into sections
  const mainRoutes = []; // top-level routes like #/colors, #/overview
  const aiRoutes = [];   // #/ai/* routes
  const componentRoutes = [];  // #/components/* and #/ai/components/*

  for (const [key] of capturedRoutes) {
    const filename = routeToFilename(key);
    if (filename === "index.html" && key === "/") continue; // skip duplicate

    if (key.startsWith("#/ai/components/") || key.startsWith("#/components/")) {
      componentRoutes.push(key);
    } else if (key.startsWith("#/ai")) {
      aiRoutes.push(key);
    } else {
      mainRoutes.push(key);
    }
  }

  function makeLink(key, label) {
    const currentFile = routeToFilename(currentKey);
    const currentDir = path.dirname(currentFile);
    const targetFile = routeToFilename(key);
    let rel = path.relative(currentDir, targetFile).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    const isActive = key === currentKey;
    const depth = (label.match(/\//g) || []).length;
    const depthClass = depth > 0 ? ` nav-depth-${depth}` : "";
    const activeClass = isActive ? " nav-active" : "";
    return `<a href="${rel}" class="nav-item${depthClass}${activeClass}">${label}</a>`;
  }

  function keyToLabel(key, showShort = false) {
    // Use breadcrumb from navMap (e.g. "Components/Badge")
    if (navMap.has(key)) {
      const raw = navMap.get(key).label;
      if (showShort && raw.includes("/")) {
        // Under a section heading, show only the last segment: "Badge"
        return raw.split("/").pop().trim();
      }
      if (raw.includes("/")) return raw;
      const cleaned = raw.replace(/^[a-z_]+\s+/, "");
      return cleaned || raw;
    }
    return keyToDefaultLabel(key);
  }

  let nav = `<nav class="static-nav" aria-label="Page navigation">\n`;
  nav += `  <div class="static-nav-brand">Site Navigation</div>\n`;
  nav += `  <div class="static-nav-section">\n`;

  // Home/Overview link
  if (capturedRoutes.has("/")) {
    nav += `    ${makeLink("/", navMap.get("/")?.label || "Overview")}\n`;
  }

  // Main section pages
  for (const key of mainRoutes.sort()) {
    if (key === "/") continue;
    nav += `    ${makeLink(key, keyToLabel(key))}\n`;
  }

  // AI section
  if (aiRoutes.length > 0) {
    nav += `  </div>\n  <div class="static-nav-section">\n`;
    nav += `    <div class="static-nav-heading">AI Snapshot</div>\n`;
    for (const key of aiRoutes.sort()) {
      nav += `    ${makeLink(key, keyToLabel(key))}\n`;
    }
  }

  // Components — show only the last part of the breadcrumb (e.g. "Badge" not "Components/Badge")
  if (componentRoutes.length > 0) {
    nav += `  </div>\n  <div class="static-nav-section">\n`;
    nav += `    <div class="static-nav-heading">Components</div>\n`;
    for (const key of componentRoutes.sort()) {
      nav += `    ${makeLink(key, keyToLabel(key, true))}\n`;
    }
  }

  nav += `  </div>\n</nav>`;
  return nav;
}

const NAV_CSS = `
/* ── Static Navigation (injected by crawler) ──────────────────────────── */
.static-nav {
  position: fixed;
  top: 0;
  left: 0;
  width: 220px;
  height: 100vh;
  overflow-y: auto;
  background: #1a1f36;
  color: #c1c7d7;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  z-index: 99999;
  padding: 0;
  box-shadow: 2px 0 8px rgba(0,0,0,0.15);
}
.static-nav-brand {
  padding: 16px 16px 12px;
  font-weight: 700;
  font-size: 14px;
  color: #fff;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.static-nav-section {
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.static-nav-heading {
  padding: 10px 16px 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #8a8fa8;
}
.static-nav a.nav-item {
  display: block;
  padding: 7px 16px 7px 20px;
  color: #c1c7d7;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
  border-left: 3px solid transparent;
}
.static-nav a.nav-depth-1 { padding-left: 28px; font-size: 12px; }
.static-nav a.nav-depth-2 { padding-left: 36px; font-size: 12px; }
.static-nav a.nav-depth-3 { padding-left: 44px; font-size: 12px; }
.static-nav a.nav-item:hover {
  background: rgba(255,255,255,0.07);
  color: #fff;
}
.static-nav a.nav-item.nav-active {
  background: rgba(255,255,255,0.1);
  color: #7ef29d;
  border-left-color: #7ef29d;
  font-weight: 600;
}
/* Push main content to the right of the nav */
body {
  margin-left: 220px !important;
}
@media (max-width: 768px) {
  .static-nav {
    position: relative;
    width: 100%;
    height: auto;
    max-height: 50vh;
  }
  body {
    margin-left: 0 !important;
  }
}
`;

// ── Output Building ────────────────────────────────────────────────────────

function buildPage(route) {
  let html = rewriteLinks(route.html, route.key);
  html = rewriteAssetUrls(html, route.key);
  let css = rewriteAssetUrls(route.css, route.key);

  const safeTitle = (route.title || "Untitled")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const navHtml = buildNavBar(route.key);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
${css}
${NAV_CSS}
  </style>
</head>
<body>
${navHtml}
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

  // ── Step 1: Load the site and capture landing page ────────────────────
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
  const landingFingerprint = await getContentFingerprint(page);

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
    _fingerprint: landingFingerprint,
  });
  discoveredRoutes.add(landingKey);
  navMap.set(landingKey, { label: "Overview" });
  console.log(`  ✅ Landing: ${landingKey} (fingerprint: ${landingFingerprint.slice(0, 40)}...)\n`);

  // ── Step 1b: Seed base pages from sidebar buttons ──
  const seeded = await seedSidebarRoutesFromPage(page);
  for (const item of seeded) {
    if (item.key && !discoveredRoutes.has(item.key)) {
      discoveredRoutes.add(item.key);
      navMap.set(item.key, { label: item.label });
    }
  }
  console.log(`  🌱 Seeded ${seeded.length} sidebar base pages: ${seeded.map(s => s.label).join(", ")}\n`);

  // ── Step 2: Click each sidebar button, capture the page, then crawl its children ────────
  console.log("🔍 Crawling base pages via sidebar button clicks...\n");

  for (const item of seeded) {
    if (capturedRoutes.size >= MAX_PAGES) break;
    if (capturedRoutes.has(item.key)) continue;

    // Reload the site to get back to landing (clean state)
    await page.goto(BASE_URL, {
      waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
      timeout: TIMEOUT,
    });
    await page.waitForTimeout(RENDER_DELAY);

    // Click the sidebar button by its text
    const contentBefore = await getContentFingerprint(page);
    const didClick = await clickByText(page, item.buttonText);
    if (!didClick) {
      console.log(`  ⚠️ Could not find sidebar button: "${item.buttonText}"`);
      continue;
    }

    await page.waitForTimeout(RENDER_DELAY);
    const contentAfter = await getContentFingerprint(page);
    if (contentAfter === contentBefore) {
      console.log(`  ⏭️  Skipping ${item.key} — content didn't change after click`);
      continue;
    }

    // Check for duplicate content
    const fingerprint = await getContentFingerprint(page);
    const duplicateFingerprint = [...capturedRoutes.values()].some(r => r._fingerprint && r._fingerprint === fingerprint);
    if (duplicateFingerprint) {
      console.log(`  ⏭️  Skipping ${item.key} — content identical to existing page`);
      continue;
    }

    // Capture the page
    const [html, cssBlocks, assetUrls] = await Promise.all([
      extractCleanHTML(page),
      extractAllCSS(page),
      extractAssetUrls(page),
    ]);
    const title = await page.title();

    if (DOWNLOAD_ASSETS) {
      for (const assetUrl of assetUrls) {
        await downloadAsset(assetUrl, context.request);
      }
      for (const cssBlock of cssBlocks) {
        const urlMatches = cssBlock.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g) || [];
        for (const m of urlMatches) {
          const u = m.replace(/url\(["']?/, "").replace(/["']?\)/, "");
          await downloadAsset(u, context.request);
        }
      }
    }

    capturedRoutes.set(item.key, {
      key: item.key,
      url: `${BASE_URL}${item.key}`,
      title,
      html,
      css: cssBlocks.join("\n\n"),
      newRoutes: [],
      _fingerprint: fingerprint,
    });
    discoveredRoutes.add(item.key);
    console.log(`  ✅ Captured base page: ${item.key} (${item.label})`);

    // Now crawl deeper: discover buttons/links on this page and capture sub-pages
    if (capturedRoutes.size < MAX_PAGES) {
      const pageBreadcrumb = item.label;
      const buttonText = item.buttonText;
      // Function to navigate back to this base page: reload site + click the sidebar button
      const navigateToThisPage = async () => {
        await page.goto(BASE_URL, {
          waitUntil: WAIT_FOR_NETWORK ? "networkidle" : "domcontentloaded",
          timeout: TIMEOUT,
        });
        await page.waitForTimeout(RENDER_DELAY);
        await clickByText(page, buttonText);
        await page.waitForTimeout(RENDER_DELAY);
      };
      // Exclude sidebar base-page buttons so clicking "Typography" from "Colors" page
      // doesn't get captured as a child of Colors
      const sidebarLabels = new Set(seeded.map(s => s.buttonText));
      console.log(`  🔍 Crawling children of ${item.key}...`);
      const moreRoutes = await discoverAndCapture(page, context.request, item.key, pageBreadcrumb, navigateToThisPage, sidebarLabels);
      console.log(`    📍 Discovered ${moreRoutes.length} additional URLs from ${item.key}\n`);
    }
  }

  await browser.close();

  // ── Step 4: Write static files ───────────────────────────────────────
  console.log(`\n📝 Writing ${capturedRoutes.size} static pages...\n`);

  const manifest = [];
  const writtenFiles = new Set();

  for (const [key, route] of capturedRoutes) {
    const filename = routeToFilename(key);

    // Avoid writing the same file twice (e.g., / and #/ both → index.html)
    if (writtenFiles.has(filename)) {
      console.log(`  ⏭️  Skipping duplicate: ${filename} (${key})`);
      continue;
    }
    writtenFiles.add(filename);

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
