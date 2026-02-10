# 🕷️ Figma Make → Static HTML/CSS → GitHub Pages

Crawls a React/JS site (like a Figma Make site) with a headless browser, extracts the fully-rendered HTML + CSS, downloads assets, and deploys a clean static version to GitHub Pages — ready for AI scraping.

## How It Works

1. **Playwright** loads each page in headless Chromium and waits for React to hydrate
2. **Extracts** the rendered DOM, all CSS (inline + external), and discovers internal links
3. **Downloads** images, fonts, and other assets referenced in HTML and CSS
4. **Rewrites** all internal links to point to local `.html` files
5. **Strips** `<script>` tags, React data attributes, and framework noise
6. **Deploys** the result to GitHub Pages — every run overwrites the previous version

## Setup (One-Time)

### 1. Create the repo and push the files

```
your-repo/
├── .github/workflows/crawl-and-deploy.yml
└── crawler/
    ├── crawl.js
    └── package.json
```

### 2. Enable GitHub Pages

1. Go to **Settings** → **Pages**
2. Under **Source**, select **GitHub Actions**
3. That's it — no branch selection needed

### 3. Set your default URL

Edit `.github/workflows/crawl-and-deploy.yml` and set `DEFAULT_SITE_URL`:

```yaml
env:
  DEFAULT_SITE_URL: "https://your-figma-site.com"
```

### 4. (Optional) Enable scheduled runs

Uncomment the `schedule` block in the workflow to run automatically:

```yaml
schedule:
  - cron: "0 */4 * * *"      # Every 4 hours
  # - cron: "0 8,12,17 * * *" # 3x daily
  # - cron: "*/30 * * * *"    # Every 30 minutes
```

## Running

### Manual

Go to **Actions** → **Crawl & Deploy Static Site** → **Run workflow** → enter URL → **Run**

### Automatic

Once you uncomment a schedule trigger, it runs on that cron. Each run fully overwrites the previous deployment — no stale pages accumulate.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `SITE_URL` | — | URL to crawl (required) |
| `MAX_PAGES` | `100` | Max pages to crawl |
| `CONCURRENCY` | `3` | Parallel browser tabs |
| `WAIT_FOR_NETWORK` | `true` | Wait for `networkidle` (slower, captures lazy-loaded content) |
| `PAGE_TIMEOUT` | `30000` | Per-page timeout in ms |
| `DOWNLOAD_ASSETS` | `true` | Download images/fonts/media to `assets/` |

## Output

Once deployed, your static site is at:

```
https://<username>.github.io/<repo-name>/
```

The output structure:

```
index.html              # Homepage (self-contained HTML+CSS)
about.html              # /about → about.html
features.html           # /features → features.html
assets/                 # Downloaded images, fonts, etc.
  a1b2c3d4e5f6.png
  ...
manifest.json           # Page list with URLs, titles, file paths
sitemap.xml             # For crawlers/discovery
.nojekyll               # Tells GitHub Pages to skip Jekyll processing
```

Every HTML file is **self-contained** — CSS is inlined in `<style>` tags, no JavaScript, no external dependencies. Links between pages use relative paths so the whole site works as a unit.

## Why This Approach

Figma Make (and most site builders) generate React SPAs. If you just `curl` or `wget` them, you get an empty `<div id="root">` with a bunch of JS bundles — useless for AI scraping. This crawler renders the JS first, then captures what the user actually sees.

## Concurrency Note

The workflow uses `cancel-in-progress: true` — if a new run starts while another is deploying, the old one is cancelled. This prevents conflicts when running multiple times a day.
