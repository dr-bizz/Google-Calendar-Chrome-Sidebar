# README Rewrite — Design Spec

## Problem

The current README is developer-focused only and doesn't mention the Chrome Web Store. The GitHub PR review feature adds significant new setup steps (GitHub OAuth App + Cloudflare Worker) that aren't documented. SETUP.md is now redundant and only covers Google Calendar setup. CLAUDE.md is stale (doesn't mention GitHub integration). The privacy statement ("No external servers") is now inaccurate since the extension communicates with GitHub API and a Cloudflare Worker.

## Decisions

| Decision | Choice |
|----------|--------|
| File structure | Single README.md with two install paths |
| SETUP.md | Remove — README becomes single source of truth |
| Architecture section | Keep, condensed, updated for GitHub integration |
| GitHub setup | Clearly marked as optional (calendar works without it) |
| Publishing section | Drop — the referenced workflow doesn't exist |

---

## 1. Structure

### Section Order

1. **Header** — Project name, one-line description
2. **Features** — Full feature list including GitHub PR reviews and desktop notifications
3. **Install from Chrome Web Store** — Short section: link + note about pending approval
4. **Developer Setup (Load Unpacked)** — Full step-by-step:
   - Prerequisites list
   - Step 1: Load extension in browser (get Extension ID)
   - Step 2: Google Cloud project + Calendar API + OAuth client
   - Step 3 (Optional): GitHub OAuth App + Cloudflare Worker for PR reviews
   - Step 4: Configure extension files with real values
   - Step 5: Reload and test
5. **Troubleshooting** — Common issues + new GitHub issues
6. **Architecture** — File responsibilities, data flow, auth strategies (Google + GitHub)
7. **Contributing** — File guide table, development workflow (no build step)
8. **Privacy** — Updated to reflect GitHub API + Cloudflare Worker communication, link to PRIVACY.md
9. **License** — MIT

---

## 2. Content Details

### Features Section

Include all features from the current README plus:
- **Desktop notifications** — alerts before meetings start (added in commit 15a07aa)
- **GitHub PR review tracking** — see PRs awaiting your review, re-review detection, desktop notifications for new review requests

### Chrome Web Store Section

- Preview link: `https://chromewebstore.google.com/detail/fefpaminbjodcadohglcnikaklhbjfgb/preview`
- Note that it's pending approval
- One sentence: install, pin, sign in — done

### Developer Setup

Google Calendar setup steps taken from current SETUP.md (Steps 1-5), updated for Chrome as well as Brave.

GitHub PR Reviews setup is a new section marked **(Optional)** with detailed sub-steps:

1. **Create GitHub OAuth App** at `github.com/settings/developers`
   - Callback URL: `https://<EXTENSION_ID>.chromiumapp.org/` (same pattern as Google)
   - Note the Client ID and Client Secret
2. **Deploy Cloudflare Worker**
   - Install wrangler: `npm install -g wrangler`
   - From `worker/` directory: `npx wrangler deploy`
   - Set secret: `npx wrangler secret put GITHUB_CLIENT_SECRET`
   - Update `wrangler.toml` with real `GITHUB_CLIENT_ID` and `EXTENSION_ID`
3. **Update extension config**
   - `background.js`: Set `GITHUB_CLIENT_ID` and `GITHUB_WORKER_URL`
   - `manifest.json`: Update the worker domain in `host_permissions` if using a different subdomain

**Scope disclosure:** Clearly note that the GitHub OAuth flow requests the `repo` scope, which grants full read/write access to repositories. Explain that this is required because GitHub does not offer a narrower scope for read-only access to private repo PRs. Users should be informed of this before connecting.

### Troubleshooting

From old SETUP.md:
- `redirect_uri_mismatch` error
- Sign-in hangs / nothing happens
- Token expired after ~1 hour

New GitHub-specific:
- "GitHub integration not configured" — placeholder values not replaced
- GitHub sign-in fails — check OAuth App callback URL matches extension ID
- PR reviews not loading — check Cloudflare Worker is deployed and reachable

### Architecture

Updated to cover:
- Extension source files: `background.js`, `sidepanel.js`, `sidepanel.html`, `oauth_callback.js` + `oauth_callback.html`
- External component: `worker/github-token-exchange.js` (Cloudflare Worker for GitHub OAuth token exchange)
- Two auth flows: Google OAuth (launchWebAuthFlow → tab-based fallback → manual token entry) and GitHub OAuth (launchWebAuthFlow → Cloudflare Worker code exchange)
- Two data sources: Google Calendar API and GitHub REST API
- Storage: `chrome.storage.local` for data (tokens, cached events/PRs, notification tracking), `localStorage` for UI preferences

### Privacy Section

**Must be updated.** The current statement "No external servers, no analytics, no tracking" is now inaccurate. The new text should state:
- Calendar data only communicates with Google APIs (`googleapis.com`, `accounts.google.com`)
- GitHub PR feature (optional) communicates with GitHub API (`api.github.com`) and a Cloudflare Worker for token exchange
- No analytics, no tracking, no third-party data sharing
- All cached data stays in browser storage

---

## 3. Files Changed

- **Modify:** `README.md` — Complete rewrite with both install paths
- **Delete:** `SETUP.md` — Consolidated into README
- **Modify:** `CLAUDE.md` — Update to reflect GitHub integration: new files (`worker/github-token-exchange.js`), new auth flow (GitHub OAuth via Cloudflare Worker), new storage keys (`githubToken`, `cachedPRs`, `enabledPRRepos`, etc.), new background alarm (`checkPRs`), new config constants (`GITHUB_CLIENT_ID`, `GITHUB_WORKER_URL`)
