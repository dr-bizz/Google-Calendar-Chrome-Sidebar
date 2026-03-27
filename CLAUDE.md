# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Calendar Side Panel — a Manifest V3 Chrome extension (also works in Brave/Edge) that displays Google Calendar events in the browser side panel and tracks GitHub PRs awaiting review. No build step, no dependencies, no package.json. Pure vanilla JavaScript, HTML, and CSS.

## Development Workflow

1. Load the extension unpacked at `chrome://extensions` (or `brave://extensions`) with developer mode enabled
2. Edit files directly — there is no build, transpile, or bundle step
3. Reload the extension in the extensions page to pick up changes
4. No test framework or linter is configured

## Architecture

**Five source files + one external worker:**

- **`background.js`** (service worker) — Google OAuth authentication (launchWebAuthFlow → tab-based fallback → manual token entry), GitHub OAuth (launchWebAuthFlow → Cloudflare Worker code exchange), token lifecycle management, background alarms (badge update, event refresh, notification checks, PR polling every 10 min), and message handling between sidepanel and APIs.

- **`sidepanel.js`** — All UI logic: fetches events from Google Calendar API v3 and PRs from GitHub REST API, renders mini calendar, timeline, event cards, day summary, RSVP handling, PR review cards, PR detail slide-out, meeting alerts. Manages preferences via `localStorage`. Polls PRs every 2 minutes when panel is open.

- **`sidepanel.html`** — Markup and embedded CSS (light/dark themes via CSS variables, animations, responsive layout). All styles are inline in a single `<style>` tag.

- **`oauth_callback.js` + `oauth_callback.html`** — Google OAuth redirect handler that extracts the access token from the URL hash and sends it to background.js.

- **`worker/github-token-exchange.js`** — Cloudflare Worker that exchanges GitHub OAuth authorization codes for access tokens. Deployed separately to Cloudflare Workers. CORS restricted to the extension origin.

**Data flow:**
- **Calendar:** User interaction → sidepanel.js sends Chrome messages → background.js handles auth/tokens → sidepanel.js calls Google Calendar API directly with token → renders UI. Events cached in `chrome.storage.local`.
- **GitHub PRs:** sidepanel.js fetches from GitHub Search API → enriches with PR details, reviews, and timeline → renders PR cards. background.js handles 10-min background polling, desktop notifications for new review requests, and badge updates.

## Key Configuration

- **Google OAuth Client ID** is defined in two places: `background.js` line 2 (`CLIENT_ID`) and `manifest.json` (`oauth2.client_id`). Both must match.
- **GitHub OAuth** config: `GITHUB_CLIENT_ID` and `GITHUB_WORKER_URL` in `background.js`. The worker domain must also be in `manifest.json` `host_permissions`.
- **Permissions** in `manifest.json`: `sidePanel`, `storage`, `tabs`, `identity`, `alarms`, `notifications`
- **Google OAuth scopes**: `calendar.events` (read/write + RSVP) and `calendar.readonly` (list calendars)
- **GitHub OAuth scope**: `repo` (required for private repo PR access — no narrower scope available)

## Auth Token Lifecycle

**Google:** Implicit OAuth flow with ~1 hour expiry. Silent refresh triggered at 45 minutes via `checkToken` alarm. On 401 API response, `tryReAuth()` attempts silent refresh then cross-tab token pickup. Manual token entry available as last-resort fallback.

**GitHub:** OAuth tokens don't expire unless revoked. Validated via `GET /user` on session start. On 401 from any GitHub API call, token is cleared and user is prompted to reconnect. Token exchange goes through the Cloudflare Worker (client secret never in the extension).

## Storage

- **`chrome.storage.local`**: Google token (`accessToken`, `tokenTime`), GitHub token (`githubToken`, `githubTokenTime`, `githubUsername`), cached events (`cachedEvents`, `cacheTime`), cached PRs (`cachedPRs`, `prCacheTime`), notification tracking (`notifiedEventKeys`, `notifiedPRKeys`), PR repo filter (`enabledPRRepos`)
- **`localStorage`**: UI preferences — dark mode, compact mode, mini calendar collapsed state, enabled calendar IDs, PR section collapsed state
