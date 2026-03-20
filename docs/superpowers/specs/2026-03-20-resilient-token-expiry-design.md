# Resilient Token Expiry — Don't Sign Out All Tabs

**Date:** 2026-03-20
**Status:** Approved

## Problem

When a Google OAuth token expires or is revoked externally, the extension clears `accessToken` from `chrome.storage.local`. Every open side panel tab listens to `storage.onChanged` and treats this identically to an explicit sign-out — immediately showing the auth screen. This means one expired token signs out every tab.

**Desired behavior:** Explicit sign-out (user clicks "Sign Out") should sign out all tabs. Token expiry should trigger silent re-authentication, not a sign-out cascade.

## Approach: Explicit Sign-Out Flag

Differentiate explicit sign-out from token expiry using an `explicitSignOut` flag in `chrome.storage.local`.

## Changes

### 1. background.js — `signOut` message handler (line 739-753)

Before removing `accessToken`, set `explicitSignOut: true` in storage. Then remove `accessToken` and `tokenTime` as before.

### 2. background.js — `getStoredToken` message handler (line 722-737)

When token is older than ~58 minutes, return `{ token: null }` but **do not** call `chrome.storage.local.remove()`. This prevents triggering `storage.onChanged` across all tabs. The token sits inert until overwritten by a successful refresh or cleared by explicit sign-out.

### 3. sidepanel.js — `storage.onChanged` listener (line 2363-2369)

When `!newToken && oldToken`, instead of immediately signing out:

1. Check if `explicitSignOut` flag is set in storage
2. **If yes:** Sign out (current behavior — clear state, show auth screen), then remove the `explicitSignOut` flag
3. **If no** (token expired/revoked): Attempt recovery:
   a. Silent refresh via `sendMsg({ type: 'silentRefresh' })`
   b. If that fails, check `getStoredToken` for a token another tab may have refreshed
   c. If both fail, show the re-auth banner (not auth screen — user stays on current view)

## Edge Cases

**Token cleanup:** `getStoredToken` no longer deletes expired tokens, but stale tokens don't accumulate — the existing `checkToken`/`tokenRefresh` alarm overwrites them on successful silent refresh, or they sit inert (returned as null).

**Race condition — multiple tabs recovering simultaneously:** The existing `reAuthPromise` deduplication handles per-tab dedup. Cross-tab: the first tab that successfully refreshes calls `storeToken()`, triggering `storage.onChanged` with a new token. Other tabs pick up the new token and abort their recovery.

**`explicitSignOut` flag cleanup:** Each tab clears the flag after reading it. Subsequent tabs see the token already gone and flag already cleared — they end up on the auth screen (correct for explicit sign-out).

## Files Changed

- `background.js` — 2 edits (signOut handler, getStoredToken handler)
- `sidepanel.js` — 1 edit (storage.onChanged accessToken listener)

## Not Changed

Auth strategies, alarm handlers, GitHub token handling, manual token entry, re-auth banner UI.
