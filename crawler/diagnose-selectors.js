#!/usr/bin/env node

const { chromium } = require("playwright");

const CLICKABLE_SELECTORS = [
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
  ".MuiListItem-root", ".MuiListItemButton-root",
  ".MuiTab-root", ".MuiButton-root",
  "[class*='ListItem'] a", "[class*='ListItem'] button",
].join(", ");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("🔍 Navigating to Figma site...\n");
  await page.goto("https://cabin-hem-65260868.figma.site/", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  console.log("📊 Testing current CLICKABLE_SELECTORS:\n");
  const currentMatches = await page.$$(CLICKABLE_SELECTORS);
  console.log(`   Found: ${currentMatches.length} elements\n`);

  console.log("🔎 Analyzing page structure:\n");

  // Get all elements with nav-related classes
  const navAnalysis = await page.evaluate(() => {
    const results = {
      navElements: [],
      sidebarElements: [],
      allClickable: [],
      classPatterns: new Set(),
    };

    // Find all nav/sidebar-looking elements
    const allElements = document.querySelectorAll("*");
    allElements.forEach(el => {
      const classNameObj = el.className;
      const className = typeof classNameObj === "string" ? classNameObj : (classNameObj.baseVal || "");
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();

      // Collect class patterns
      if (className) {
        className.split(" ").forEach(c => {
          if (c) results.classPatterns.add(c);
        });
      }

      // Look for navigation-looking elements
      const classLower = className.toLowerCase();
      if (
        classLower.includes("nav") ||
        classLower.includes("sidebar") ||
        classLower.includes("menu") ||
        role === "navigation" ||
        tag === "nav"
      ) {
        results.navElements.push({
          tag,
          className,
          role,
          text: el.textContent?.trim().substring(0, 50),
        });
      }

      // Look for clickable elements in potential sidebars
      if (
        (tag === "a" || tag === "button" || role === "button") &&
        el.textContent?.trim()
      ) {
        const text = el.textContent.trim();
        if (text.length > 0 && text.length < 100) {
          results.allClickable.push({
            tag,
            className,
            role,
            text: text.substring(0, 80),
          });
        }
      }
    });

    results.classPatterns = Array.from(results.classPatterns);
    return results;
  });

  console.log("   Nav/Sidebar Elements:");
  navAnalysis.navElements.slice(0, 10).forEach(el => {
    console.log(`     <${el.tag}> class="${el.className}" role="${el.role}"`);
    console.log(`       Text: ${el.text}`);
  });

  console.log(`\n   All Clickable Elements (${navAnalysis.allClickable.length} total):`);
  navAnalysis.allClickable.slice(0, 20).forEach(el => {
    console.log(`     <${el.tag}> class="${el.className}"`);
    console.log(`       Text: "${el.text}"`);
  });

  console.log(`\n   Common Class Patterns (showing navigation-related):`);
  const navClasses = navAnalysis.classPatterns
    .filter(c =>
      c.toLowerCase().includes("nav") ||
      c.toLowerCase().includes("sidebar") ||
      c.toLowerCase().includes("menu") ||
      c.toLowerCase().includes("list") ||
      c.toLowerCase().includes("item") ||
      c.toLowerCase().includes("button")
    )
    .slice(0, 30);
  navClasses.forEach(c => console.log(`     ${c}`));

  console.log("\n✅ Diagnosis complete!");
  await browser.close();
})();
