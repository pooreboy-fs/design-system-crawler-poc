# 🕷️ Figma Make → Static HTML/CSS → GitHub Pages

Crawls a React SPA (like a Figma Make site) with a headless browser, renders every route, and deploys a clean static HTML+CSS version to GitHub Pages — ready for AI scraping.

## Why This Exists

Figma Make (and most site builders) generate React SPAs. If you `curl` them, you get an empty `<div id="root">`. Even basic crawlers miss content because:

- **Hash routing** (`#/colors`, `#/components`) — all "pages" live at the same URL
- **Client-side navigation** — React Router `<Link>` components don't have real `<a href>` tags
- **Dynamic rendering** — content only appears after JavaScript execution

This crawler handles all of that.

## How It Works

1. **Loads the site** in headless Chromium via Playwright
2. **Discovers routes** by scanning `<a href>` tags (including `#/hash` links) AND clicking navigation elements (sidebar items, tabs, nav buttons, MUI components)
3. **Navigates to each route** by setting `window.location.hash` for hash routing or visiting the URL directly
4. **Waits for React to render** the content (configurable delay)
5. **Captures** the rendered DOM and all CSS
6. **Downloads** images, fonts, and media assets
7. **Rewrites links** so `#/colors` → `colors.html`, navigation works between static pages
8. **Deploys** to GitHub Pages — every run fully overwrites the previous version

## Setup

### 1. Push these files to your repo

```
your-repo/
├── .github/workflows/crawl-and-deploy.yml
└── crawler/
    ├── crawl.js
    └── package.json
```

### 2. Enable GitHub Pages

**Settings** → **Pages** → **Source** → select **GitHub Actions**

### 3. Set your URL

Edit `crawl-and-deploy.yml`:

```yaml
env:
  DEFAULT_SITE_URL: "https://your-figma-site.com"
```

### 4. Run it

**Actions** → **Crawl & Deploy Static Site** → **Run workflow** → enter URL → **Run**

Your static site appears at `https://<user>.github.io/<repo>/`

### 5. (Optional) Schedule

Uncomment a cron in the workflow:

```yaml
schedule:
  - cron: "0 */4 * * *"  # Every 4 hours
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SITE_URL` | — | URL to crawl (required) |
| `MAX_PAGES` | `100` | Max routes to capture |
| `WAIT_FOR_NETWORK` | `true` | Wait for `networkidle` (captures lazy content) |
| `RENDER_DELAY` | `3000` | Ms to wait after navigation for React to render |
| `DOWNLOAD_ASSETS` | `true` | Download images/fonts/media |
| `PAGE_TIMEOUT` | `30000` | Per-page navigation timeout |

## Output

```
index.html          # Landing page / #/ route
colors.html         # #/colors route
components.html     # #/components route
typography.html     # #/typography route
ai.html             # #/ai route
assets/             # Downloaded images, fonts, etc.
manifest.json       # All captured routes with metadata
sitemap.xml         # For crawlers
_sitemap.html       # Human-readable page list
.nojekyll           # Tells GitHub Pages to skip Jekyll
```

Each HTML file is **self-contained** — CSS inlined, no JavaScript, all links rewritten to relative `.html` paths.

## How Overwriting Works

- `fs.remove(OUTPUT_DIR)` clears everything before each crawl
- The workflow uses `cancel-in-progress: true` — if a new run starts while one is deploying, the old one is cancelled
- GitHub Pages deployment always overwrites the entire site atomically
- Safe to run multiple times per day
