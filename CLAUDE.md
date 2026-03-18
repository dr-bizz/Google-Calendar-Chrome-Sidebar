# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Calendar Side Panel — a Manifest V3 Chrome extension (also works in Brave/Edge) that displays Google Calendar events in the browser side panel. No build step, no dependencies, no package.json. Pure vanilla JavaScript, HTML, and CSS.

## Development Workflow

1. Load the extension unpacked at `chrome://extensions` (or `brave://extensions`) with developer mode enabled
2. Edit files directly — there is no build, transpile, or bundle step
3. Reload the extension in the extensions page to pick up changes
4. No test framework or linter is configured

## Architecture

**Four source files, clear separation of concerns:**

- **`background.js`** (service worker) — OAuth authentication (3-strategy flow: `getAuthToken` → `launchWebAuthFlow` → tab-based fallback), token lifecycle management (storage, 45-min silent refresh, cross-tab sync via `chrome.storage.onChanged`), background alarms (badge update, event refresh, notification checks), and message handling between sidepanel and Google APIs.

- **`sidepanel.js`** — All UI logic: fetches events from Google Calendar API v3, renders mini calendar, timeline with overlapping-column layout, event cards, day summary stats, RSVP handling, event detail view, meeting alerts. Manages preferences (dark/compact mode, calendar filter) via `localStorage`. Polls for token changes every 2 seconds for cross-tab sync.

- **`sidepanel.html`** — Markup and ~750 lines of embedded CSS (light/dark themes via CSS variables, animations, responsive layout). All styles are inline in a single `<style>` tag.

- **`oauth_callback.js` + `oauth_callback.html`** — OAuth redirect handler that extracts the access token from the URL hash and sends it to background.js.

**Data flow:** User interaction → sidepanel.js sends Chrome messages → background.js handles auth/tokens → sidepanel.js calls Google Calendar API directly with token → renders UI. Events are cached in `chrome.storage.local` for fast reopen and badge updates.

## Key Configuration

- **OAuth Client ID** is defined in two places: `background.js` line 2 (`CLIENT_ID`) and `manifest.json` (`oauth2.client_id`). Both must match.
- **Permissions** in `manifest.json`: `sidePanel`, `storage`, `tabs`, `identity`, `alarms`, `notifications`
- **OAuth scopes**: `calendar.events` (read/write + RSVP) and `calendar.readonly` (list calendars)

## Auth Token Lifecycle

Implicit OAuth flow with ~1 hour expiry. Silent refresh triggered at 45 minutes via `checkToken` alarm. On 401 API response, `tryReAuth()` attempts silent refresh then cross-tab token pickup. Manual token entry available as last-resort fallback.

## UI State

Preferences stored in `localStorage`: dark mode, compact mode, mini calendar collapsed state, enabled calendar IDs. Event cache stored in `chrome.storage.local` with 30-minute staleness threshold.
