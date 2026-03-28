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

- **`background.js`** (service worker) — OAuth coordination (opens worker auth URLs, listens for callback messages), token lifecycle management (caching access tokens locally, refreshing via worker, deduplicating concurrent refreshes), background alarms (badge update, event refresh, notification checks, PR polling every 10 min), and message handling between sidepanel and APIs.

- **`sidepanel.js`** — All UI logic: fetches events from Google Calendar API v3 and PRs from GitHub REST API, renders mini calendar, timeline, event cards, day summary, RSVP handling, PR review cards, PR detail slide-out, meeting alerts. Manages preferences via `localStorage`. Polls PRs every 2 minutes when panel is open.

- **`sidepanel.html`** — Markup and embedded CSS (light/dark themes via CSS variables, animations, responsive layout). All styles are inline in a single `<style>` tag.

- **`oauth_callback.js` + `oauth_callback.html`** — Multi-provider OAuth redirect handler. Receives session tokens (and access tokens for Google) from the worker redirect, clears URL fragment for security, and sends an `oauthCallback` message to background.js.

- **`worker/auth-token-exchange.js`** — Unified Cloudflare Worker handling both Google and GitHub OAuth. Routes: `/google/auth`, `/google/callback`, `/google/refresh`, `/github/auth`, `/github/callback`, `/github/retrieve`, `/revoke`. Stores Google refresh tokens and GitHub access tokens in Cloudflare KV. Returns opaque session tokens to the extension. CORS restricted to the extension origin. Deployed separately to Cloudflare Workers.

**Data flow:**
- **Calendar:** User clicks Sign In → background.js opens tab to worker `/google/auth` → worker redirects to Google consent → Google redirects back to worker `/google/callback` → worker exchanges code for tokens, stores refresh token in KV → worker redirects to extension `oauth_callback.html` with session token + access token → background.js stores session token and caches access token → sidepanel.js calls Google Calendar API directly with cached access token → renders UI. Access token refreshed via worker every 55 minutes.
- **GitHub PRs:** User clicks Connect GitHub → same tab-based flow through worker → session token stored locally → sidepanel.js retrieves access token from worker on panel open, caches in memory → fetches from GitHub Search API → enriches with PR details, reviews, and timeline → renders PR cards. background.js handles 10-min background polling, desktop notifications for new review requests, and badge updates.

## Key Configuration

- **Worker URL** is defined in `background.js` line 2 (`WORKER_URL`). Must match the deployed Cloudflare Worker domain.
- **Worker environment variables** (set via `wrangler secret put`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- **Worker vars** (in `wrangler.toml`): `EXTENSION_ID` — the Chrome extension ID for CORS and redirect URLs
- **Permissions** in `manifest.json`: `sidePanel`, `storage`, `tabs`, `alarms`, `notifications`
- **Host permissions**: `googleapis.com`, `api.github.com`, worker domain
- **Google OAuth scopes**: `calendar.events` (read/write + RSVP) and `calendar.readonly` (list calendars)
- **GitHub OAuth scope**: `repo` (required for private repo PR access — no narrower scope available)

## Auth Token Lifecycle

**Google:** Authorization code flow via Cloudflare Worker. Worker exchanges code for access token + refresh token. Refresh token stored server-side in KV (90-day TTL). Access token cached locally in `chrome.storage.local` with timestamp. Background alarm refreshes at 55 minutes via `POST /google/refresh` to worker. On 401 API response, `tryReAuth()` attempts refresh via worker. On 401/404 from worker (session expired), local session is cleared and user must re-authenticate.

**GitHub:** Authorization code flow via same worker. Worker exchanges code for access token, stores in KV (90-day TTL). Extension stores opaque session token locally. Access token retrieved from worker on panel open, cached in memory for the session. On 401 from any GitHub API call, token is cleared and user is prompted to reconnect.

**Session tokens:** Opaque UUIDs generated by the worker. Stored in `chrome.storage.local`. Used to retrieve/refresh real tokens from the worker. Client secrets never leave the worker.

## Storage

- **`chrome.storage.local`**: Google session (`googleSessionToken`, `googleAccessToken`, `googleTokenTime`), GitHub session (`githubSessionToken`, `githubUsername`), cached events (`cachedEvents`, `cacheTime`), cached PRs (`cachedPRs`, `prCacheTime`), notification tracking (`notifiedEventKeys`, `notifiedPRKeys`), PR repo filter (`enabledPRRepos`)
- **`localStorage`**: UI preferences — dark mode, mini calendar collapsed state, enabled calendar IDs, PR section collapsed state
