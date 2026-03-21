# Resilient Token Expiry — Don't Sign Out All Tabs

**Date:** 2026-03-20
**Status:** Approved

## Problem

When a Google OAuth token expires or is revoked externally, the extension clears `accessToken` from `chrome.storage.local`. Every open side panel tab listens to `storage.onChanged` and treats this identically to an explicit sign-out — immediately showing the auth screen. This means one expired token signs out every tab.

**Desired behavior:** Explicit sign-out (user clicks "Sign Out") should sign out all tabs. Token expiry should trigger silent re-authentication, not a sign-out cascade.

## Approach: Explicit Sign-Out Timestamp

Differentiate explicit sign-out from token expiry using an `explicitSignOutTime` timestamp in `chrome.storage.local`. A timestamp (not a boolean) avoids a race condition where multiple tabs read and clear a boolean concurrently — some tabs could miss the flag. With a timestamp, each tab checks whether sign-out occurred within the last 5 seconds. No tab clears the timestamp; it simply ages out.

## Changes

### 1. background.js — `signOut` message handler (line 739-753)

Before removing `accessToken`, set `explicitSignOutTime: Date.now()` in storage. Then remove `accessToken` and `tokenTime` as before.

### 2. background.js — `getStoredToken` message handler (line 722-737)

When token is older than ~58 minutes, return `{ token: null }` but **do not** call `chrome.storage.local.remove()`. This prevents triggering `storage.onChanged` across all tabs. The token sits inert until overwritten by a successful refresh or cleared by explicit sign-out.

### 3. sidepanel.js — `storage.onChanged` listener (line 2363-2369)

When `!newToken && oldToken`, instead of immediately signing out:

1. Check if `explicitSignOutTime` is set in storage and is within the last 5 seconds
2. **If yes (recent explicit sign-out):** Sign out (current behavior — clear state, show auth screen). Do not clear the timestamp — it ages out naturally.
3. **If no** (token expired/revoked, or timestamp is stale): Attempt recovery (wrapped in async IIFE since the listener is synchronous):
   a. Silent refresh via `sendMsg({ type: 'silentRefresh' })`
   b. If that fails, check `getStoredToken` for a token another tab may have refreshed
   c. If both fail, show the re-auth banner (not auth screen — user stays on current view)

## Edge Cases

**Token cleanup:** `getStoredToken` no longer deletes expired tokens, but stale tokens don't accumulate — the existing `checkToken`/`tokenRefresh` alarm overwrites them on successful silent refresh, or they sit inert (returned as null).

**Race condition — multiple tabs recovering simultaneously:** The existing `reAuthPromise` deduplication handles per-tab dedup. Cross-tab: the first tab that successfully refreshes calls `storeToken()`, triggering `storage.onChanged` with a new token. Other tabs pick up the new token and abort their recovery.

**`explicitSignOutTime` race safety:** Using a timestamp instead of a boolean eliminates the race condition where multiple tabs try to read and clear a flag concurrently. Every tab that checks within 5 seconds of sign-out sees a recent timestamp and signs out. No tab clears it — the 5-second window simply expires.

**Async recovery in synchronous listener:** The `storage.onChanged` callback is synchronous. The recovery path (silentRefresh, getStoredToken) requires async calls. Implementation must wrap recovery logic in an async IIFE. If `sendMsg` throws (e.g., service worker terminated), fall through to showing the re-auth banner.

**Interaction with `checkToken` alarm:** The alarm (background.js line 83-117) fires every minute and attempts silent re-auth when token is >45 min old. It calls `storeToken()` on success, overwriting the stale token. If it fails, the stale token stays inert. No conflict with the sidepanel's own recovery attempt — whichever succeeds first writes a new token, and tabs pick it up via `storage.onChanged`.

## Files Changed

- `background.js` — 2 edits (signOut handler, getStoredToken handler)
- `sidepanel.js` — 1 edit (storage.onChanged accessToken listener)

## Not Changed

Auth strategies, alarm handlers, GitHub token handling, manual token entry, re-auth banner UI.
