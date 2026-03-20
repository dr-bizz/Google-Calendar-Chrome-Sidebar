# Resilient Token Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Google token expiry from signing out all open side panel tabs — only explicit sign-out should propagate.

**Architecture:** Add an `explicitSignOutTime` timestamp to `chrome.storage.local` when the user clicks Sign Out. The `storage.onChanged` listener checks this timestamp to decide whether to sign out or attempt silent recovery. `getStoredToken` stops deleting expired tokens from storage to avoid triggering false sign-out cascades.

**Tech Stack:** Chrome Extension APIs (storage, identity, runtime messaging). No build step, no dependencies.

**Spec:** `docs/superpowers/specs/2026-03-20-resilient-token-expiry-design.md`

---

## File Structure

- **Modify:** `background.js` — signOut handler and getStoredToken handler
- **Modify:** `sidepanel.js` — storage.onChanged accessToken listener

No new files created.

---

### Task 1: Stop `getStoredToken` from deleting expired tokens

**Files:**
- Modify: `background.js:722-737`

- [ ] **Step 1: Remove the `chrome.storage.local.remove()` call for expired tokens**

Replace the `getStoredToken` handler. Instead of deleting expired tokens, just return null:

```javascript
  if (message.type === 'getStoredToken') {
    chrome.storage.local.get(['accessToken', 'tokenTime'], (data) => {
      if (data.accessToken && data.tokenTime) {
        const age = Date.now() - data.tokenTime;
        if (age < 3500000) {
          sendResponse({ token: data.accessToken });
        } else {
          // Token expired — return null but do NOT remove from storage.
          // Removing it triggers storage.onChanged across all tabs,
          // causing a sign-out cascade. The stale token sits inert until
          // overwritten by a successful refresh or cleared by explicit sign-out.
          sendResponse({ token: null });
        }
      } else {
        sendResponse({ token: null });
      }
    });
    return true;
  }
```

- [ ] **Step 2: Verify manually**

Load extension, open side panel. Wait for token to age past 58 minutes (or temporarily lower the threshold to test). Confirm the side panel does NOT show the auth screen — it should stay on the main view.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "fix: stop getStoredToken from deleting expired tokens to prevent cross-tab sign-out"
```

---

### Task 2: Set `explicitSignOutTime` on explicit sign-out

**Files:**
- Modify: `background.js:739-753`

- [ ] **Step 1: Update the signOut handler to set a timestamp before clearing the token**

Replace the `signOut` handler:

```javascript
  if (message.type === 'signOut') {
    // Also revoke the token with Google if possible.
    // Set timestamp so other tabs know this is an explicit sign-out (not token expiry).
    // Tabs check if this timestamp is within the last 5 seconds to decide behavior.
    chrome.storage.local.set({ explicitSignOutTime: Date.now() }, () => {
      chrome.storage.local.get(['accessToken'], (data) => {
        if (data.accessToken) {
          try {
            chrome.identity.removeCachedAuthToken({ token: data.accessToken }, () => {});
          } catch (e) {}
        }
        chrome.storage.local.remove(['accessToken', 'tokenTime'], () => {
          sendResponse({ success: true });
        });
      });
    });
    return true;
  }
```

- [ ] **Step 2: Verify manually**

Open side panel in two tabs. Click Sign Out in Tab A. Confirm Tab B also signs out and shows the auth screen.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat: set explicitSignOutTime timestamp on sign-out for cross-tab detection"
```

---

### Task 3: Update `storage.onChanged` to recover silently on token expiry

**Files:**
- Modify: `sidepanel.js:2363-2370`

- [ ] **Step 1: Replace the token-cleared branch with recovery logic**

Replace the `else if (!newToken && oldToken)` block (lines 2363-2370) with:

```javascript
        } else if (!newToken && oldToken) {
          // Token was cleared — check if this is an explicit sign-out or token expiry.
          // This recovery path is a safety net: the primary recovery mechanism is the
          // checkToken alarm in background.js which refreshes tokens proactively.
          // This code handles edge cases where the token is removed from storage
          // without an explicit sign-out (e.g., external revocation).
          (async () => {
            try {
              const data = await chrome.storage.local.get(['explicitSignOutTime']);
              const signOutAge = data.explicitSignOutTime
                ? Date.now() - data.explicitSignOutTime
                : Infinity;

              if (signOutAge < 5000) {
                // Explicit sign-out from another tab — sign out this tab too
                authToken = null;
                clearAllIntervals();
                events = [];
                showToast('Signed out from another tab');
                showScreen('authScreen');
                return;
              }

              // Token expiry — attempt silent recovery
              console.log('[Auth] Token cleared (not explicit sign-out), attempting silent recovery...');

              // Step 1: Try silent refresh
              const silent = await sendMsg({ type: 'silentRefresh' });
              if (silent && silent.token) {
                console.log('[Auth] Silent recovery succeeded');
                authToken = silent.token;
                clearReAuthBanner();
                return;
              }

              // Step 2: Check if another tab already refreshed
              const stored = await sendMsg({ type: 'getStoredToken' });
              if (stored && stored.token) {
                console.log('[Auth] Picked up token from another tab');
                authToken = stored.token;
                clearReAuthBanner();
                return;
              }

              // Step 3: All recovery failed — show re-auth banner (not auth screen)
              console.log('[Auth] Silent recovery failed, showing re-auth banner');
              authToken = null;
              showReAuthBanner();
            } catch (e) {
              // Catches extension context invalidation (e.g., extension updated/reloaded).
              // sendMsg itself never rejects — it resolves with { error: ... } on failure.
              console.error('[Auth] Recovery error:', e);
              authToken = null;
              showReAuthBanner();
            }
          })();
        }
```

- [ ] **Step 2: Verify explicit sign-out still works**

Open side panel in two tabs. Click Sign Out in Tab A. Confirm Tab B also signs out immediately (shows auth screen with toast "Signed out from another tab").

- [ ] **Step 3: Verify token expiry triggers recovery**

Open side panel in two tabs. Simulate token expiry by running in the background script console:
```javascript
chrome.storage.local.remove(['accessToken', 'tokenTime']);
```

Confirm both tabs attempt silent recovery (check console for "[Auth] Token cleared (not explicit sign-out)..." logs). If Google session is still active, they should recover silently. If not, they should show the re-auth banner (not the auth screen).

- [ ] **Step 4: Commit**

```bash
git add sidepanel.js
git commit -m "feat: recover silently on token expiry instead of signing out all tabs"
```
