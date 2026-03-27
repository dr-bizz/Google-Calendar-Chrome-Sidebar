# GitHub PR Review Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub PR review tracker to the Chrome extension side panel so pending reviews are always visible alongside calendar events.

**Architecture:** GitHub OAuth via Cloudflare Worker for token exchange. Side panel fetches PR data from GitHub API, renders a collapsible PR section below calendar events. Background service worker handles polling, notifications, and badge updates. All state persisted in `chrome.storage.local` (data) and `localStorage` (UI prefs).

**Tech Stack:** Vanilla JavaScript, Chrome Extension Manifest V3, GitHub REST API, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-18-github-pr-review-notifications-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `worker/github-token-exchange.js` | Create | Cloudflare Worker — exchanges OAuth code for GitHub access token |
| `manifest.json` | Modify | Add `host_permissions` for GitHub API and Cloudflare Worker |
| `background.js` | Modify | GitHub OAuth flow, PR polling alarm, PR notifications, badge update, message handlers |
| `sidepanel.html` | Modify | PR section markup, PR detail slide-out, toolbar icon, all new CSS |
| `sidepanel.js` | Modify | GitHub auth state, PR fetching/caching, PR rendering, PR detail view, polling, preferences |

---

### Task 1: Cloudflare Worker — Token Exchange

**Files:**
- Create: `worker/github-token-exchange.js`
- Create: `worker/wrangler.toml`

This task builds the server-side component that exchanges GitHub OAuth authorization codes for access tokens. It must be deployed before the extension can authenticate.

- [ ] **Step 1: Create the worker directory**

```bash
mkdir -p worker
```

- [ ] **Step 2: Write the Cloudflare Worker**

Create `worker/github-token-exchange.js`:

```javascript
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/github/token') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const { code } = await request.json();
      if (!code) {
        return Response.json({ error: 'Missing code' }, { status: 400 });
      }

      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const data = await tokenResponse.json();

      if (data.error) {
        return Response.json({ error: data.error_description || data.error }, {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      return Response.json({ access_token: data.access_token }, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return Response.json({ error: 'Internal error' }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
```

- [ ] **Step 3: Write wrangler.toml**

Create `worker/wrangler.toml`:

```toml
name = "github-token-exchange"
main = "github-token-exchange.js"
compatibility_date = "2024-01-01"

[vars]
GITHUB_CLIENT_ID = "YOUR_GITHUB_CLIENT_ID"
```

Note: `GITHUB_CLIENT_SECRET` is set via `npx wrangler secret put GITHUB_CLIENT_SECRET` (never in config files).

- [ ] **Step 4: Commit**

```bash
git add worker/
git commit -m "feat: add Cloudflare Worker for GitHub OAuth token exchange"
```

---

### Task 2: Manifest — Add GitHub Host Permissions

**Files:**
- Modify: `manifest.json:15-18` (host_permissions array)

- [ ] **Step 1: Add GitHub API and worker domains to host_permissions**

In `manifest.json`, update the `host_permissions` array (currently lines 15-18) to include GitHub API. Add a placeholder for the worker URL (to be updated with the real domain after deployment):

```json
"host_permissions": [
  "https://www.googleapis.com/*",
  "https://accounts.google.com/*",
  "https://api.github.com/*",
  "https://github-token-exchange.YOUR_SUBDOMAIN.workers.dev/*"
],
```

- [ ] **Step 2: Commit**

```bash
git add manifest.json
git commit -m "feat: add GitHub API and worker to host_permissions"
```

---

### Task 3: Background — GitHub OAuth Flow

**Files:**
- Modify: `background.js:1-3` (add constants after existing CONFIG section)
- Modify: `background.js:417-567` (add new message handlers in the existing `onMessage` listener)

This task adds the GitHub OAuth authentication flow to background.js. It follows the same pattern as the existing Google auth but uses `launchWebAuthFlow` → Cloudflare Worker for token exchange.

- [ ] **Step 1: Add GitHub constants after the existing CONFIG section**

After line 3 of `background.js` (after the existing `SCOPES` constant), add:

```javascript
// ---- GITHUB CONFIG ----
const GITHUB_CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID';
const GITHUB_WORKER_URL = 'https://github-token-exchange.YOUR_SUBDOMAIN.workers.dev';
const GITHUB_SCOPE = 'repo';
```

- [ ] **Step 2: Add the `authViaGitHub()` function**

Add before the `// ---- MESSAGE HANDLING ----` comment (before line 417):

```javascript
// ---- GITHUB AUTH ----
async function authViaGitHub() {
  return new Promise((resolve) => {
    const redirectUri = getRedirectURL();
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: GITHUB_SCOPE,
      state,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    console.log('[GitHub Auth] Starting OAuth flow');
    console.log('[GitHub Auth] Redirect URI:', redirectUri);

    try {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        async (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            console.warn('[GitHub Auth] Failed:', chrome.runtime.lastError?.message);
            resolve({ error: chrome.runtime.lastError?.message || 'No response' });
            return;
          }

          try {
            const url = new URL(responseUrl);
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');

            if (!code) {
              resolve({ error: 'No authorization code in response' });
              return;
            }

            if (returnedState !== state) {
              resolve({ error: 'State mismatch — possible CSRF attack' });
              return;
            }

            // Exchange code for token via Cloudflare Worker
            const tokenResponse = await fetch(`${GITHUB_WORKER_URL}/github/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code }),
            });

            const data = await tokenResponse.json();
            if (data.error) {
              resolve({ error: data.error });
              return;
            }

            if (data.access_token) {
              console.log('[GitHub Auth] Success!');
              await chrome.storage.local.set({
                githubToken: data.access_token,
                githubTokenTime: Date.now(),
              });
              resolve({ token: data.access_token });
            } else {
              resolve({ error: 'No access token in worker response' });
            }
          } catch (e) {
            console.error('[GitHub Auth] Token exchange error:', e);
            resolve({ error: e.message });
          }
        }
      );
    } catch (e) {
      console.warn('[GitHub Auth] Exception:', e.message);
      resolve({ error: e.message });
    }
  });
}
```

- [ ] **Step 3: Add GitHub message handlers**

Inside the existing `chrome.runtime.onMessage.addListener` callback (after the `getCachedEvents` handler, around line 565), add these handlers:

```javascript
  // ---- GITHUB AUTH MESSAGE HANDLERS ----
  if (message.type === 'startGitHubAuth') {
    (async () => {
      const result = await authViaGitHub();
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'getGitHubToken') {
    chrome.storage.local.get(['githubToken'], (data) => {
      sendResponse({ token: data.githubToken || null });
    });
    return true;
  }

  if (message.type === 'disconnectGitHub') {
    chrome.storage.local.remove(['githubToken', 'githubTokenTime', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys', 'githubUsername'], () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // ---- PR CACHING MESSAGE HANDLERS ----
  if (message.type === 'cachePRs') {
    chrome.storage.local.set({
      cachedPRs: message.prs,
      prCacheTime: Date.now(),
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'getCachedPRs') {
    chrome.storage.local.get(['cachedPRs', 'prCacheTime'], (data) => {
      sendResponse({
        prs: data.cachedPRs || null,
        cacheTime: data.prCacheTime || null,
      });
    });
    return true;
  }
```

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat: add GitHub OAuth flow and message handlers to background.js"
```

---

### Task 4: Background — PR Polling Alarm, Notifications, Badge

**Files:**
- Modify: `background.js:62-67` (onInstalled — add `checkPRs` alarm)
- Modify: `background.js:69-229` (alarm handlers — add `checkPRs` handler, update `updateBadge`)
- Modify: `background.js:249-265` (notification click handlers — add `pr::` routing)
- Modify: `background.js:160-168` (auto-dismiss loop — skip `pr::` IDs)

- [ ] **Step 1: Add the `checkPRs` alarm in `onInstalled`**

In the `chrome.runtime.onInstalled.addListener` callback (line 62-67), add after the `checkNotifications` alarm:

```javascript
  chrome.alarms.create('checkPRs', { periodInMinutes: 10 });
```

- [ ] **Step 2: Add the `checkPRs` alarm handler**

Inside the `chrome.alarms.onAlarm.addListener` callback, after the `updateBadge` handler (after line 228), add:

```javascript
  if (alarm.name === 'checkPRs') {
    try {
      const data = await chrome.storage.local.get(['githubToken', 'githubUsername', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys', 'enabledPRRepos']);
      if (!data.githubToken || !data.githubUsername) return;

      // Deduplication: skip if cache was updated less than 90 seconds ago
      if (data.prCacheTime && Date.now() - data.prCacheTime < 90000) return;

      // Lightweight search-only fetch (no enrichment)
      const searchUrl = `https://api.github.com/search/issues?q=type:pr+review-requested:${data.githubUsername}+is:open&per_page=100`;
      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `token ${data.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      });

      if (response.status === 401) {
        await chrome.storage.local.remove(['githubToken', 'githubTokenTime', 'githubUsername']);
        return;
      }

      if (response.status === 403) {
        console.warn('[checkPRs] Rate limited, skipping this cycle');
        return;
      }

      if (!response.ok) return;

      const searchData = await response.json();
      const newPRs = (searchData.items || []).map(item => {
        const [owner, repo] = (item.repository_url || '').replace('https://api.github.com/repos/', '').split('/');
        return {
          id: item.id,
          repo: `${owner}/${repo}`,
          title: item.title,
          number: item.number,
          htmlUrl: item.html_url,
          author: { login: item.user?.login, avatarUrl: item.user?.avatar_url },
        };
      });

      // Detect new review requests
      const oldIds = new Set((data.cachedPRs || []).map(pr => pr.id));
      const notifiedKeys = new Set(data.notifiedPRKeys || []);
      const enabledRepos = data.enabledPRRepos ? new Set(data.enabledPRRepos) : null;
      let notifiedChanged = false;

      for (const pr of newPRs) {
        // Respect repo filter
        if (enabledRepos && !enabledRepos.has(pr.repo)) continue;

        if (!oldIds.has(pr.id) && !notifiedKeys.has(`pr::${pr.id}`)) {
          // Check if this is a re-review (exists in old cache with isReReview data)
          const oldPR = (data.cachedPRs || []).find(p => p.id === pr.id);
          const isReReview = oldPR ? oldPR.isReReview : false;

          const notifOptions = {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `${pr.repo} #${pr.number}`,
            message: `${isReReview ? 'Re-review' : 'Review'} requested: ${pr.title}`,
            priority: isReReview ? 2 : 1,
            requireInteraction: isReReview,
          };

          chrome.notifications.create(`pr::${pr.id}`, notifOptions);
          notifiedKeys.add(`pr::${pr.id}`);
          notifiedChanged = true;
        }
      }

      // Cleanup: remove notified keys for PRs no longer requesting review
      const currentIds = new Set(newPRs.map(pr => pr.id));
      for (const key of notifiedKeys) {
        if (key.startsWith('pr::')) {
          const prId = parseInt(key.substring(4));
          if (!currentIds.has(prId)) {
            notifiedKeys.delete(key);
            notifiedChanged = true;
          }
        }
      }

      // Merge new lightweight data with existing enriched cache
      const mergedPRs = newPRs.map(newPR => {
        const existing = (data.cachedPRs || []).find(p => p.id === newPR.id);
        return existing ? { ...existing, ...newPR } : newPR;
      });

      const updates = { cachedPRs: mergedPRs, prCacheTime: Date.now() };
      if (notifiedChanged) updates.notifiedPRKeys = [...notifiedKeys];
      await chrome.storage.local.set(updates);

    } catch (e) {
      console.error('[Alarms] checkPRs error:', e);
    }
  }
```

- [ ] **Step 3: Update `updateBadge` to include PR count fallback**

Replace the **entire** `updateBadge` alarm handler block (lines 190-228 of `background.js` — from `if (alarm.name === 'updateBadge')` to its closing brace) with this complete replacement. Search for `if (alarm.name === 'updateBadge')` to find it:

```javascript
  if (alarm.name === 'updateBadge') {
    try {
      const data = await chrome.storage.local.get(['cachedEvents', 'cachedPRs', 'enabledPRRepos']);

      // Helper: get filtered PR count
      function getPRCount() {
        if (!data.cachedPRs || !Array.isArray(data.cachedPRs)) return 0;
        const enabledRepos = data.enabledPRRepos ? new Set(data.enabledPRRepos) : null;
        return data.cachedPRs.filter(pr => !enabledRepos || enabledRepos.has(pr.repo)).length;
      }

      if (data.cachedEvents && Array.isArray(data.cachedEvents)) {
        const now = Date.now();
        const upcoming = data.cachedEvents
          .filter(event => event.start && event.start.dateTime)
          .map(event => ({ ...event, startMs: new Date(event.start.dateTime).getTime() }))
          .filter(event => event.startMs > now)
          .sort((a, b) => a.startMs - b.startMs);

        if (upcoming.length > 0) {
          const next = upcoming[0];
          const minutesUntil = Math.round((next.startMs - now) / 60000);

          if (minutesUntil <= 2) {
            chrome.action.setBadgeText({ text: 'NOW' });
            chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
          } else if (minutesUntil <= 30) {
            chrome.action.setBadgeText({ text: `${minutesUntil}m` });
            chrome.action.setBadgeBackgroundColor({ color: '#0000FF' });
          } else {
            // No meeting within 30 min — show PR count or empty
            const prCount = getPRCount();
            if (prCount > 0) {
              chrome.action.setBadgeText({ text: `${prCount}` });
              chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
            } else {
              chrome.action.setBadgeText({ text: '' });
            }
          }
        } else {
          // No upcoming meetings at all — show PR count or empty
          const prCount = getPRCount();
          if (prCount > 0) {
            chrome.action.setBadgeText({ text: `${prCount}` });
            chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
        }
      } else {
        // No cached events — show PR count or empty
        const prCount = getPRCount();
        if (prCount > 0) {
          chrome.action.setBadgeText({ text: `${prCount}` });
          chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
        } else {
          chrome.action.setBadgeText({ text: '' });
        }
      }
    } catch (e) {
      console.error('[Alarms] updateBadge error:', e);
    }
  }
```

- [ ] **Step 4: Update notification click handlers to route `pr::` IDs**

Replace the existing `chrome.notifications.onClicked` listener (line 249-254) with:

```javascript
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('pr::')) {
    // PR notification — look up the htmlUrl from cached PRs
    chrome.storage.local.get(['cachedPRs'], (data) => {
      const prId = parseInt(notificationId.substring(4));
      const pr = (data.cachedPRs || []).find(p => p.id === prId);
      if (pr && pr.htmlUrl) {
        chrome.tabs.create({ url: pr.htmlUrl });
      }
    });
  } else {
    // Calendar event notification
    findEventFromNotification(notificationId, (event) => {
      if (event) openEventUrl(event);
    });
  }
  chrome.notifications.clear(notificationId);
});
```

Replace the existing `chrome.notifications.onButtonClicked` listener (line 256-265) with:

```javascript
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId.startsWith('pr::')) {
    // PR notification button — open in GitHub
    if (buttonIndex === 0) {
      chrome.storage.local.get(['cachedPRs'], (data) => {
        const prId = parseInt(notificationId.substring(4));
        const pr = (data.cachedPRs || []).find(p => p.id === prId);
        if (pr && pr.htmlUrl) {
          chrome.tabs.create({ url: pr.htmlUrl });
        }
      });
    }
  } else if (buttonIndex === 0) {
    // Calendar event button
    findEventFromNotification(notificationId, (event) => {
      if (event && event.hangoutLink && isSafeUrl(event.hangoutLink)) {
        chrome.tabs.create({ url: event.hangoutLink });
      }
    });
  }
  chrome.notifications.clear(notificationId);
});
```

- [ ] **Step 5: Update auto-dismiss loop to skip `pr::` notification IDs**

In the `checkNotifications` alarm handler, find the auto-dismiss loop (lines 160-168). Update it to skip PR notification IDs:

```javascript
        // Auto-dismiss notifications for events that started 10+ minutes ago
        chrome.notifications.getAll((active) => {
          for (const id of Object.keys(active)) {
            if (id.startsWith('pr::')) continue; // Skip PR notifications
            const parts = id.split('::');
            const ts = parseInt(parts[parts.length - 1]);
            if (ts && now - ts > 10 * 60 * 1000) {
              chrome.notifications.clear(id);
            }
          }
        });
```

- [ ] **Step 6: Commit**

```bash
git add background.js
git commit -m "feat: add PR polling alarm, notifications, and badge update to background.js"
```

---

### Task 5: Side Panel HTML — Markup and CSS

**Files:**
- Modify: `sidepanel.html:7-690` (add new CSS rules inside the `<style>` tag)
- Modify: `sidepanel.html:704-731` (toolbar — add PR icon button)
- Modify: `sidepanel.html:795-799` (add PR section container and detail slide-out)

- [ ] **Step 1: Add PR-related CSS**

Inside the `<style>` tag in `sidepanel.html`, before the closing `</style>` (line 690), add:

```css
    /* ---- PR Reviews Section ---- */
    .pr-section { padding: 0 12px 8px; }
    .pr-section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 0 6px 0; cursor: pointer;
    }
    .pr-section-header:hover { opacity: 0.8; }
    .pr-section-title {
      font-size: 12px; font-weight: 600; color: var(--primary); text-transform: uppercase;
      letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;
    }
    .pr-section-count {
      font-size: 10px; background: var(--primary); color: #fff; padding: 1px 6px;
      border-radius: 10px; font-weight: 600;
    }
    .pr-section-actions { display: flex; align-items: center; gap: 4px; }
    .pr-section-toggle {
      font-size: 10px; color: var(--text-tertiary); transition: transform 0.2s;
    }
    .pr-section-gear {
      background: none; border: none; cursor: pointer; color: var(--text-tertiary);
      padding: 2px; border-radius: 4px; display: flex; align-items: center;
    }
    .pr-section-gear:hover { background: var(--hover-bg); color: var(--text-secondary); }
    .pr-section-body { }
    .pr-section-body.collapsed { display: none; }

    /* ---- PR Card ---- */
    .pr-card {
      display: flex; gap: 10px; padding: 8px 10px; margin-bottom: 4px;
      border-radius: 6px; background: var(--surface); border: 1px solid var(--border-light);
      transition: box-shadow 0.15s; cursor: pointer;
    }
    .pr-card:hover { box-shadow: 0 1px 4px var(--card-shadow); }
    .pr-card-avatar {
      width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
      background: var(--primary-light); color: var(--primary);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; overflow: hidden;
    }
    .pr-card-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .pr-card-details { flex: 1; min-width: 0; }
    .pr-card-title-row { display: flex; align-items: center; gap: 6px; }
    .pr-card-title {
      font-size: 13px; font-weight: 500; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; flex: 1;
    }
    .pr-card-rereview {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      padding: 1px 6px; border-radius: 3px;
      background: #e37400; color: #fff; flex-shrink: 0; letter-spacing: 0.3px;
    }
    body.dark .pr-card-rereview { background: #f6bf26; color: #1e1e1e; }
    .pr-card-repo {
      font-size: 11px; color: var(--text-secondary); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pr-card-meta {
      font-size: 10px; color: var(--text-tertiary); margin-top: 2px;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .pr-card-diff-add { color: var(--green); }
    .pr-card-diff-del { color: var(--red); }
    .pr-card-labels { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
    .pr-card-label {
      font-size: 9px; padding: 1px 6px; border-radius: 10px;
      font-weight: 500; white-space: nowrap;
    }
    .pr-card-reviewers { display: flex; gap: 3px; margin-top: 3px; align-items: center; }
    .pr-reviewer-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .pr-reviewer-dot.approved { background: var(--green); }
    .pr-reviewer-dot.changes-requested { background: var(--red); }
    .pr-reviewer-dot.pending { background: var(--text-muted); }

    /* ---- PR Connect Prompt ---- */
    .pr-connect-prompt {
      padding: 16px; text-align: center; background: var(--surface);
      border-radius: 8px; border: 1px solid var(--border-light); margin-bottom: 8px;
    }
    .pr-connect-icon { font-size: 28px; margin-bottom: 8px; opacity: 0.6; }
    .pr-connect-text { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
    .pr-connect-btn {
      padding: 8px 20px; background: var(--primary); color: #fff; border: none;
      border-radius: 4px; font-size: 13px; cursor: pointer; font-weight: 500;
      transition: background 0.15s;
    }
    .pr-connect-btn:hover { background: var(--primary-hover); }
    .pr-connect-btn:disabled { background: var(--primary-disabled); cursor: not-allowed; }

    /* ---- PR Settings Panel ---- */
    .pr-settings { display: none; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border-light); border-radius: 6px; margin-bottom: 8px; }
    .pr-settings.open { display: block; }
    .pr-settings-user { font-size: 12px; color: var(--text); margin-bottom: 8px; font-weight: 500; }
    .pr-settings-disconnect {
      font-size: 11px; color: var(--red); background: none; border: 1px solid var(--red);
      padding: 4px 12px; border-radius: 4px; cursor: pointer; margin-bottom: 8px;
    }
    .pr-settings-disconnect:hover { background: var(--red-light); }
    .pr-filter-label {
      font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;
      letter-spacing: 0.5px; padding: 6px 0 4px; border-top: 1px solid var(--border-lighter);
      margin-top: 4px; display: flex; align-items: center; justify-content: space-between;
    }
    .pr-filter-actions { display: flex; gap: 12px; font-size: 11px; }
    .pr-filter-actions button {
      background: none; border: none; cursor: pointer; color: var(--primary); font-size: 11px; padding: 0;
    }
    .pr-filter-actions button:hover { text-decoration: underline; }
    .pr-filter-item {
      display: flex; align-items: center; gap: 8px; padding: 4px;
      cursor: pointer; font-size: 12px; color: var(--text); border-radius: 4px;
    }
    .pr-filter-item:hover { background: var(--hover-bg); }
    .pr-filter-item input[type="checkbox"] {
      accent-color: var(--primary); margin: 0; width: 14px; height: 14px; cursor: pointer;
    }

    /* ---- PR Detail Slide-out ---- */
    .pr-detail-screen {
      position: fixed; inset: 0; z-index: 500;
      background: var(--bg); display: flex; flex-direction: column;
      opacity: 0; pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
      transform: translateX(100%);
    }
    .pr-detail-screen.active {
      opacity: 1; pointer-events: auto; transform: translateX(0);
    }
    .pr-detail-body { flex: 1; overflow-y: auto; padding: 16px; }
    .pr-detail-title { font-size: 20px; font-weight: 700; color: var(--text); margin-bottom: 8px; line-height: 1.3; }
    .pr-detail-desc {
      font-size: 13px; color: var(--text-secondary); line-height: 1.6;
      margin-bottom: 16px; word-break: break-word;
      padding: 10px; background: var(--hover-bg); border-radius: 6px;
    }
    .pr-detail-section {
      margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-lighter);
    }
    .pr-detail-section:last-child { border-bottom: none; }
    .pr-detail-label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--text-tertiary); margin-bottom: 6px;
    }
    .pr-detail-stat { font-size: 13px; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .pr-detail-reviewer {
      display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: var(--text);
    }
    .pr-detail-reviewer-status {
      font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
    }
    .pr-detail-reviewer-status.approved { background: var(--green-light); color: var(--green); }
    .pr-detail-reviewer-status.changes-requested { background: var(--red-light); color: var(--red); }
    .pr-detail-reviewer-status.pending { background: var(--hover-bg); color: var(--text-muted); }
    .pr-detail-actions { display: flex; gap: 8px; margin-top: 8px; }
    .pr-detail-action-btn {
      flex: 1; padding: 10px 8px; border-radius: 8px; border: 2px solid var(--border);
      background: var(--surface); font-size: 13px; font-weight: 600;
      cursor: pointer; text-align: center; color: var(--primary);
      transition: all 0.15s; text-decoration: none; display: flex;
      align-items: center; justify-content: center; gap: 6px;
    }
    .pr-detail-action-btn:hover { border-color: var(--primary); background: var(--primary-light); }

    /* ---- PR Toolbar Badge ---- */
    .pr-toolbar-badge {
      position: relative;
    }
    .pr-badge-count {
      position: absolute; top: -4px; right: -4px;
      background: #8e24aa; color: #fff; font-size: 9px; font-weight: 700;
      min-width: 14px; height: 14px; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 3px; line-height: 1;
    }
    body.dark .pr-badge-count { background: #ce93d8; color: #1e1e1e; }
    .pr-badge-count:empty { display: none; }

    /* ---- PR Loading Skeleton ---- */
    .pr-skeleton-card { height: 64px; margin-bottom: 4px; border-radius: 6px; }

    /* ---- PR Error ---- */
    .pr-error {
      padding: 8px 12px; background: var(--red-light); border-radius: 6px;
      font-size: 12px; color: var(--red); margin-bottom: 8px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .pr-error-retry {
      background: none; border: 1px solid var(--red); color: var(--red);
      padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    }
    .pr-error-retry:hover { background: var(--red); color: #fff; }
```

- [ ] **Step 2: Add PR toolbar icon button**

In `sidepanel.html`, inside the `.toolbar-actions` div (line 704), add a PR icon button before the existing day summary button (before line 705):

```html
      <button class="toolbar-btn pr-toolbar-badge" id="prToolbarBtn" title="PR Reviews" style="display:none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
          <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
        </svg>
        <span class="pr-badge-count" id="prBadgeCount"></span>
      </button>
```

- [ ] **Step 3: Add PR section container and detail slide-out**

In `sidepanel.html`, after the `weekStatsContainer` (line 795) and before the sign-out button container (line 796), add:

```html
    <div id="prReviewContainer"></div>
```

After the `eventDetailScreen` closing div (after line 818) and before the meeting alert overlay (line 821), add the PR detail slide-out:

```html
  <!-- PR Detail Slide-out -->
  <div class="pr-detail-screen" id="prDetailScreen">
    <div class="detail-header">
      <button class="detail-back-btn" id="prDetailBackBtn" title="Back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="detail-header-title" id="prDetailHeaderTitle">PR Details</div>
      <a class="toolbar-btn" id="prDetailOpenGH" title="Open in GitHub" target="_blank">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>
    </div>
    <div class="pr-detail-body" id="prDetailBody"></div>
  </div>
```

- [ ] **Step 4: Commit**

```bash
git add sidepanel.html
git commit -m "feat: add PR section markup, CSS, and detail slide-out to sidepanel.html"
```

---

### Task 6: Side Panel JS — GitHub Auth State & PR Fetching

**Files:**
- Modify: `sidepanel.js:1-14` (add new state variables)
- Modify: `sidepanel.js:23-43` (update `loadPrefs` / `savePrefs`)
- Add new functions after the existing API functions section

This task adds the GitHub token management and PR data fetching logic.

- [ ] **Step 1: Add state variables**

After line 14 of `sidepanel.js` (after the existing state variables), add:

```javascript
    // ---- GitHub PR State ----
    let githubToken = null;
    let githubUsername = null;
    let prReviews = [];
    let prSectionCollapsed = false;
    let prSettingsOpen = false;
    let prLoading = false;
    let prError = null;
    let enabledPRRepos = null; // null = show all, Set once loaded
    let prPollInterval = null;
    let prConsecutiveFailures = 0;
```

- [ ] **Step 2: Update `loadPrefs` and `savePrefs`**

In `loadPrefs()` (lines 23-34), add inside the `if (saved)` block, after the `enabledCalendarIds` line:

```javascript
          if (p.prSectionCollapsed !== undefined) prSectionCollapsed = p.prSectionCollapsed;
```

In `savePrefs()` (lines 36-43), add `prSectionCollapsed` to the JSON:

```javascript
    function savePrefs() {
      try {
        localStorage.setItem('calPrefs', JSON.stringify({
          darkMode, compactMode, miniCalCollapsed, prSectionCollapsed,
          enabledCalendarIds: enabledCalendarIds ? [...enabledCalendarIds] : null
        }));
      } catch (e) {}
    }
```

- [ ] **Step 3: Add GitHub API helper functions**

Search for the `loadCachedEvents` function in `sidepanel.js`. Add the following code **after** the closing brace of `loadCachedEvents()` and **before** the first rendering function (`function renderDaySummary()`):

```javascript
    // ---- GitHub PR API ----
    async function githubFetch(url) {
      if (!githubToken) return { ok: false, status: 0 };
      const response = await fetch(url, {
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      });
      if (response.status === 401) {
        githubToken = null;
        githubUsername = null;
        await chrome.runtime.sendMessage({ type: 'disconnectGitHub' });
        return { ok: false, status: 401 };
      }
      if (!response.ok) return { ok: false, status: response.status, headers: response.headers };
      const data = await response.json();
      return { ok: true, data, headers: response.headers };
    }

    async function validateGitHubToken() {
      const result = await githubFetch('https://api.github.com/user');
      if (result.ok) {
        githubUsername = result.data.login;
        await chrome.storage.local.set({ githubUsername: githubUsername });
        return true;
      }
      return false;
    }

    async function fetchPRReviews() {
      if (!githubToken || !githubUsername) return;
      prLoading = true;
      prError = null;
      renderPRSection();

      try {
        // Check deduplication
        const cached = await chrome.runtime.sendMessage({ type: 'getCachedPRs' });
        if (cached && cached.cacheTime && Date.now() - cached.cacheTime < 90000) {
          if (cached.prs) prReviews = cached.prs;
          prLoading = false;
          renderPRSection();
          return;
        }

        // Search for PRs requesting review
        const searchResult = await githubFetch(
          `https://api.github.com/search/issues?q=type:pr+review-requested:${githubUsername}+is:open&per_page=100`
        );

        if (searchResult.status === 403) {
          prConsecutiveFailures++;
          if (prConsecutiveFailures >= 3) {
            prError = 'GitHub rate limit exceeded. Try again later.';
          }
          prLoading = false;
          renderPRSection();
          return;
        }

        if (!searchResult.ok) {
          prConsecutiveFailures++;
          if (prConsecutiveFailures >= 3) {
            prError = 'Couldn\'t load PR reviews.';
          }
          prLoading = false;
          renderPRSection();
          return;
        }

        prConsecutiveFailures = 0;
        const items = searchResult.data.items || [];

        // Parallel enrichment with concurrency limit of 5
        const enriched = await enrichPRs(items);

        // Sort: re-reviews first, then by requested time
        enriched.sort((a, b) => {
          if (a.isReReview !== b.isReReview) return a.isReReview ? -1 : 1;
          return new Date(b.reviewRequestedAt || 0) - new Date(a.reviewRequestedAt || 0);
        });

        prReviews = enriched;
        prLoading = false;

        // Cache results
        await chrome.runtime.sendMessage({ type: 'cachePRs', prs: enriched });

        renderPRSection();
      } catch (e) {
        console.error('[PR] Fetch error:', e);
        prError = 'Couldn\'t load PR reviews.';
        prLoading = false;
        renderPRSection();
      }
    }

    async function enrichPRs(searchItems) {
      const results = [];
      const concurrency = 5;
      const oldCache = prReviews; // Previous enriched data

      for (let i = 0; i < searchItems.length; i += concurrency) {
        const batch = searchItems.slice(i, i + concurrency);
        const enrichedBatch = await Promise.all(batch.map(async (item) => {
          const repoUrl = item.repository_url || '';
          const repoFullName = repoUrl.replace('https://api.github.com/repos/', '');
          const [owner, repo] = repoFullName.split('/');

          const basePR = {
            id: item.id,
            repo: `${owner}/${repo}`,
            title: item.title,
            body: item.body || '',
            number: item.number,
            htmlUrl: item.html_url,
            author: { login: item.user?.login, avatarUrl: item.user?.avatar_url },
            reviewRequestedAt: item.updated_at,
          };

          try {
            // Fetch PR details, reviews, and timeline in parallel
            const [detailResult, reviewsResult, timelineResult] = await Promise.all([
              githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${item.number}`),
              githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${item.number}/reviews`),
              githubFetch(`https://api.github.com/repos/${owner}/${repo}/issues/${item.number}/timeline`),
            ]);

            let enrichedPR = { ...basePR };

            if (detailResult.ok) {
              const d = detailResult.data;
              enrichedPR.changedFiles = d.changed_files;
              enrichedPR.additions = d.additions;
              enrichedPR.deletions = d.deletions;
              enrichedPR.labels = (d.labels || []).map(l => ({ name: l.name, color: l.color }));
              enrichedPR.reviewers = (d.requested_reviewers || []).map(r => ({
                login: r.login, state: 'PENDING',
              }));
              enrichedPR.body = d.body || enrichedPR.body;
            }

            if (reviewsResult.ok) {
              // Merge review statuses into reviewer list
              const reviewsByUser = {};
              for (const review of reviewsResult.data) {
                // Keep the latest review per user
                reviewsByUser[review.user.login] = review.state;
              }
              // Check if current user previously reviewed (re-review detection)
              enrichedPR.isReReview = !!reviewsByUser[githubUsername];

              // Add completed reviewers not in requested list
              const existingLogins = new Set((enrichedPR.reviewers || []).map(r => r.login));
              for (const [login, state] of Object.entries(reviewsByUser)) {
                if (!existingLogins.has(login)) {
                  enrichedPR.reviewers = enrichedPR.reviewers || [];
                  enrichedPR.reviewers.push({ login, state });
                } else {
                  const reviewer = enrichedPR.reviewers.find(r => r.login === login);
                  if (reviewer) reviewer.state = state;
                }
              }
            }

            if (timelineResult.ok) {
              // Find the most recent review_requested event for current user
              const events = Array.isArray(timelineResult.data) ? timelineResult.data : [];
              for (let j = events.length - 1; j >= 0; j--) {
                const evt = events[j];
                if (evt.event === 'review_requested' && evt.requested_reviewer?.login === githubUsername) {
                  enrichedPR.reviewRequestedAt = evt.created_at;
                  break;
                }
              }
            }

            return enrichedPR;
          } catch (e) {
            // Enrichment failed — use cached data or base PR
            const cached = oldCache.find(p => p.id === item.id);
            return cached ? { ...cached, ...basePR } : basePR;
          }
        }));
        results.push(...enrichedBatch);
      }
      return results;
    }
```

- [ ] **Step 4: Commit**

```bash
git add sidepanel.js
git commit -m "feat: add GitHub auth state, PR fetching, and enrichment to sidepanel.js"
```

---

### Task 7: Side Panel JS — PR Rendering (Section, Cards, Detail)

**Files:**
- Modify: `sidepanel.js` (add rendering functions after the existing render functions, before `renderAll`)

- [ ] **Step 1: Add helper functions**

Add before the rendering functions:

```javascript
    // ---- PR Helpers ----
    function timeAgo(dateString) {
      if (!dateString) return '';
      const now = Date.now();
      const then = new Date(dateString).getTime();
      const diff = now - then;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days === 1) return 'Yesterday';
      return `${days}d ago`;
    }

    function getEnabledPRRepos() {
      return enabledPRRepos; // null = show all, Set = filter
    }

    function filteredPRReviews() {
      const enabled = getEnabledPRRepos();
      if (!enabled) return prReviews;
      return prReviews.filter(pr => enabled.has(pr.repo));
    }
```

- [ ] **Step 2: Add `renderPRSection()` function**

Add before the `renderAll` function (line 1438):

```javascript
    function renderPRSection() {
      const container = document.getElementById('prReviewContainer');
      if (!container) return;

      // Not connected
      if (!githubToken) {
        container.innerHTML = `
          <div class="pr-section">
            <div class="pr-section-header">
              <div class="pr-section-title">PR Reviews</div>
            </div>
            <div class="pr-connect-prompt">
              <div class="pr-connect-icon">🔀</div>
              <div class="pr-connect-text">Connect GitHub to see PRs awaiting your review</div>
              <button class="pr-connect-btn" id="connectGitHubBtn">Connect GitHub</button>
            </div>
          </div>`;
        document.getElementById('connectGitHubBtn')?.addEventListener('click', connectGitHub);
        return;
      }

      const filtered = filteredPRReviews();
      const count = filtered.length;
      const isCollapsed = prSectionCollapsed && count === 0 ? true : prSectionCollapsed;

      let bodyHTML = '';

      if (prLoading && prReviews.length === 0) {
        bodyHTML = `
          <div class="skeleton pr-skeleton-card"></div>
          <div class="skeleton pr-skeleton-card"></div>`;
      } else if (prError) {
        bodyHTML = `
          <div class="pr-error">
            <span>${escapeHtml(prError)}</span>
            <button class="pr-error-retry" id="prRetryBtn">Retry</button>
          </div>`;
      } else if (count === 0) {
        bodyHTML = `
          <div class="empty-state" style="padding:12px;">
            <div class="empty-state-icon" style="font-size:24px;">✓</div>
            <div class="empty-state-text">No PRs awaiting your review</div>
          </div>`;
      } else {
        bodyHTML = filtered.map(pr => renderPRCard(pr)).join('');
      }

      // Settings panel
      let settingsHTML = '';
      if (prSettingsOpen) {
        const allRepos = [...new Set(prReviews.map(pr => pr.repo))].sort();
        const enabled = getEnabledPRRepos();
        settingsHTML = `
          <div class="pr-settings open">
            <div class="pr-settings-user">Connected as @${escapeHtml(githubUsername || '')}</div>
            <button class="pr-settings-disconnect" id="disconnectGitHubBtn">Disconnect GitHub</button>
            ${allRepos.length > 0 ? `
              <div class="pr-filter-label">
                Filter Repos
                <div class="pr-filter-actions">
                  <button id="prFilterAll">All</button>
                  <button id="prFilterNone">None</button>
                </div>
              </div>
              ${allRepos.map(repo => `
                <label class="pr-filter-item">
                  <input type="checkbox" value="${escapeHtml(repo)}" ${!enabled || enabled.has(repo) ? 'checked' : ''}>
                  <span>${escapeHtml(repo)}</span>
                </label>
              `).join('')}
            ` : ''}
          </div>`;
      }

      container.innerHTML = `
        <div class="pr-section">
          <div class="pr-section-header" id="prSectionHeader">
            <div class="pr-section-title">
              PR Reviews
              ${count > 0 ? `<span class="pr-section-count">${count}</span>` : ''}
            </div>
            <div class="pr-section-actions">
              <button class="pr-section-gear" id="prSettingsBtn" title="GitHub settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
              <span class="pr-section-toggle">${isCollapsed ? '▸' : '▾'}</span>
            </div>
          </div>
          ${settingsHTML}
          <div class="pr-section-body ${isCollapsed ? 'collapsed' : ''}">
            ${bodyHTML}
          </div>
        </div>`;

      // Event listeners
      document.getElementById('prSectionHeader')?.addEventListener('click', (e) => {
        if (e.target.closest('.pr-section-gear')) return;
        prSectionCollapsed = !prSectionCollapsed;
        savePrefs();
        renderPRSection();
      });

      document.getElementById('prSettingsBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        prSettingsOpen = !prSettingsOpen;
        renderPRSection();
      });

      document.getElementById('disconnectGitHubBtn')?.addEventListener('click', disconnectGitHub);

      document.getElementById('prRetryBtn')?.addEventListener('click', () => {
        prConsecutiveFailures = 0;
        fetchPRReviews();
      });

      document.getElementById('prFilterAll')?.addEventListener('click', () => {
        enabledPRRepos = null;
        chrome.storage.local.remove('enabledPRRepos');
        renderPRSection();
      });

      document.getElementById('prFilterNone')?.addEventListener('click', () => {
        enabledPRRepos = new Set();
        chrome.storage.local.set({ enabledPRRepos: [] });
        renderPRSection();
      });

      // Repo filter checkboxes
      container.querySelectorAll('.pr-filter-item input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const allCheckboxes = container.querySelectorAll('.pr-filter-item input[type="checkbox"]');
          const enabled = new Set();
          allCheckboxes.forEach(c => { if (c.checked) enabled.add(c.value); });
          enabledPRRepos = enabled.size === 0 ? new Set() : enabled;
          chrome.storage.local.set({ enabledPRRepos: [...enabled] });
          renderPRSection();
        });
      });

      // PR card clicks
      container.querySelectorAll('.pr-card').forEach(card => {
        card.addEventListener('click', () => {
          const prId = parseInt(card.dataset.prId);
          openPRDetail(prId);
        });
      });

      // Update toolbar badge count
      updatePRToolbarBadge();
    }

    function renderPRCard(pr) {
      const avatarHTML = pr.author?.avatarUrl
        ? `<img src="${escapeHtml(pr.author.avatarUrl)}&s=48" alt="">`
        : (pr.author?.login || '?').charAt(0).toUpperCase();

      const reReviewBadge = pr.isReReview
        ? '<span class="pr-card-rereview">Re-review</span>'
        : '';

      const diffStats = (pr.additions !== undefined)
        ? `<span class="pr-card-diff-add">+${pr.additions}</span> <span class="pr-card-diff-del">-${pr.deletions}</span> · ${pr.changedFiles} files`
        : '';

      const labelsHTML = (pr.labels || []).map(l => {
        const bg = l.color ? `#${l.color}20` : 'var(--hover-bg)';
        const fg = l.color ? `#${l.color}` : 'var(--text-secondary)';
        return `<span class="pr-card-label" style="background:${bg};color:${fg};">${escapeHtml(l.name)}</span>`;
      }).join('');

      const reviewerDots = (pr.reviewers || []).map(r => {
        const cls = r.state === 'APPROVED' ? 'approved'
          : r.state === 'CHANGES_REQUESTED' ? 'changes-requested'
          : 'pending';
        return `<span class="pr-reviewer-dot ${cls}" title="${escapeHtml(r.login)}: ${r.state}"></span>`;
      }).join('');

      return `
        <div class="pr-card" data-pr-id="${pr.id}">
          <div class="pr-card-avatar">${avatarHTML}</div>
          <div class="pr-card-details">
            <div class="pr-card-title-row">
              <span class="pr-card-title">${escapeHtml(pr.title)}</span>
              ${reReviewBadge}
            </div>
            <div class="pr-card-repo">${escapeHtml(pr.repo)}#${pr.number}</div>
            <div class="pr-card-meta">
              <span>${timeAgo(pr.reviewRequestedAt)}</span>
              ${diffStats ? `<span>${diffStats}</span>` : ''}
            </div>
            ${labelsHTML ? `<div class="pr-card-labels">${labelsHTML}</div>` : ''}
            ${reviewerDots ? `<div class="pr-card-reviewers">${reviewerDots}</div>` : ''}
          </div>
        </div>`;
    }
```

- [ ] **Step 3: Add `openPRDetail()` and `closePRDetail()` functions**

```javascript
    function openPRDetail(prId) {
      const pr = prReviews.find(p => p.id === prId);
      if (!pr) return;

      const screen = document.getElementById('prDetailScreen');
      const body = document.getElementById('prDetailBody');
      const title = document.getElementById('prDetailHeaderTitle');
      const openGH = document.getElementById('prDetailOpenGH');

      title.textContent = `${pr.repo}#${pr.number}`;
      openGH.href = pr.htmlUrl;

      const descPreview = pr.body
        ? escapeHtml(pr.body.substring(0, 200)) + (pr.body.length > 200 ? '...' : '')
        : '<em>No description</em>';

      const reviewersHTML = (pr.reviewers || []).map(r => {
        const cls = r.state === 'APPROVED' ? 'approved'
          : r.state === 'CHANGES_REQUESTED' ? 'changes-requested'
          : 'pending';
        const label = r.state === 'APPROVED' ? 'Approved'
          : r.state === 'CHANGES_REQUESTED' ? 'Changes requested'
          : 'Pending';
        return `
          <div class="pr-detail-reviewer">
            <span style="flex:1;">${escapeHtml(r.login)}</span>
            <span class="pr-detail-reviewer-status ${cls}">${label}</span>
          </div>`;
      }).join('');

      const labelsHTML = (pr.labels || []).map(l => {
        const bg = l.color ? `#${l.color}20` : 'var(--hover-bg)';
        const fg = l.color ? `#${l.color}` : 'var(--text-secondary)';
        return `<span class="pr-card-label" style="background:${bg};color:${fg};font-size:11px;padding:2px 8px;">${escapeHtml(l.name)}</span>`;
      }).join(' ');

      const requestedTime = pr.reviewRequestedAt
        ? new Date(pr.reviewRequestedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'Unknown';

      body.innerHTML = `
        <div class="pr-detail-title">${escapeHtml(pr.title)}</div>
        ${pr.isReReview ? '<span class="pr-card-rereview" style="margin-bottom:12px;display:inline-block;">Re-review</span>' : ''}

        <div class="pr-detail-section">
          <div class="pr-detail-label">Description</div>
          <div class="pr-detail-desc">${descPreview}</div>
        </div>

        <div class="pr-detail-section">
          <div class="pr-detail-label">Author</div>
          <div class="pr-detail-stat">
            <div class="pr-card-avatar" style="width:28px;height:28px;">
              ${pr.author?.avatarUrl ? `<img src="${escapeHtml(pr.author.avatarUrl)}&s=56" alt="">` : (pr.author?.login || '?').charAt(0).toUpperCase()}
            </div>
            <span>${escapeHtml(pr.author?.login || 'Unknown')}</span>
          </div>
        </div>

        <div class="pr-detail-section">
          <div class="pr-detail-label">Details</div>
          <div class="pr-detail-stat" style="margin-bottom:4px;">
            <span>Repository:</span> <strong>${escapeHtml(pr.repo)}</strong>
          </div>
          <div class="pr-detail-stat" style="margin-bottom:4px;">
            <span>Requested:</span> <span>${requestedTime}</span>
          </div>
          ${pr.changedFiles !== undefined ? `
            <div class="pr-detail-stat">
              <span>Changes:</span>
              <span class="pr-card-diff-add">+${pr.additions}</span>
              <span class="pr-card-diff-del">-${pr.deletions}</span>
              <span>across ${pr.changedFiles} files</span>
            </div>
          ` : ''}
        </div>

        ${labelsHTML ? `
          <div class="pr-detail-section">
            <div class="pr-detail-label">Labels</div>
            <div class="pr-card-labels" style="gap:4px;">${labelsHTML}</div>
          </div>
        ` : ''}

        ${reviewersHTML ? `
          <div class="pr-detail-section">
            <div class="pr-detail-label">Reviewers</div>
            ${reviewersHTML}
          </div>
        ` : ''}

        <div class="pr-detail-actions">
          <a class="pr-detail-action-btn" href="${escapeHtml(pr.htmlUrl)}" target="_blank">
            Open in GitHub
          </a>
          <a class="pr-detail-action-btn" href="${escapeHtml(pr.htmlUrl)}/files" target="_blank">
            Open Diff
          </a>
        </div>`;

      screen.classList.add('active');
    }

    function closePRDetail() {
      document.getElementById('prDetailScreen').classList.remove('active');
    }
```

- [ ] **Step 4: Add toolbar badge update and connect/disconnect functions**

```javascript
    function updatePRToolbarBadge() {
      const btn = document.getElementById('prToolbarBtn');
      const badge = document.getElementById('prBadgeCount');
      if (!btn || !badge) return;

      if (githubToken) {
        btn.style.display = '';
        const count = filteredPRReviews().length;
        badge.textContent = count > 0 ? count : '';
      } else {
        btn.style.display = 'none';
        badge.textContent = '';
      }
    }

    async function connectGitHub() {
      const btn = document.getElementById('connectGitHubBtn');
      if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }

      const result = await sendMsg({ type: 'startGitHubAuth' });
      if (result && result.token) {
        githubToken = result.token;
        const valid = await validateGitHubToken();
        if (valid) {
          showToast(`Connected as @${githubUsername}`);
          await fetchPRReviews();
          startPRPolling();
        } else {
          githubToken = null;
          showToast('GitHub authentication failed');
        }
      } else {
        showToast('GitHub connection failed');
      }
      renderPRSection();
    }

    async function disconnectGitHub() {
      clearInterval(prPollInterval);
      prPollInterval = null;
      githubToken = null;
      githubUsername = null;
      prReviews = [];
      prSettingsOpen = false;
      enabledPRRepos = null;
      await sendMsg({ type: 'disconnectGitHub' });
      renderPRSection();
      updatePRToolbarBadge();
      showToast('Disconnected from GitHub');
    }

    function startPRPolling() {
      if (prPollInterval) clearInterval(prPollInterval);
      prPollInterval = setInterval(fetchPRReviews, 2 * 60 * 1000);
    }
```

- [ ] **Step 5: Update `renderAll()` to include PR section**

Update the `renderAll` function (line 1438) to include the PR section:

```javascript
    function renderAll() {
      renderCalendarFilter(); renderDaySummary(); renderMeetingWarning();
      renderMiniCalendar(); renderNextMeeting(); renderTimeline();
      renderEvents(); renderWeekStats(); renderPRSection();
    }
```

- [ ] **Step 6: Commit**

```bash
git add sidepanel.js
git commit -m "feat: add PR section rendering, detail slide-out, and connect/disconnect flow"
```

---

### Task 8: Side Panel JS — Init, Event Listeners, Storage Sync

**Files:**
- Modify: `sidepanel.js` — find locations by searching for code patterns (line numbers will have shifted after Tasks 6-7 inserted code)

**Important:** Tasks 6 and 7 added hundreds of lines to `sidepanel.js`. Do NOT rely on original line numbers. Use the search patterns specified below to find each insertion point.

- [ ] **Step 1: Add PR detail back button listener**

Search for `document.getElementById('detailBackBtn').addEventListener('click', closeEventDetail)` and add directly after it:

```javascript
    // PR detail back button
    document.getElementById('prDetailBackBtn').addEventListener('click', closePRDetail);
```

- [ ] **Step 2: Add PR toolbar button click listener**

Search for `document.getElementById('refreshBtn').addEventListener('click', refreshData)` and add directly after it:

```javascript
    // PR toolbar button — scroll to PR section
    document.getElementById('prToolbarBtn').addEventListener('click', () => {
      prSectionCollapsed = false;
      savePrefs();
      renderPRSection();
      document.getElementById('prReviewContainer')?.scrollIntoView({ behavior: 'smooth' });
    });
```

- [ ] **Step 3: Update `clearAllIntervals` to include PR polling**

Search for `function clearAllIntervals()` and add inside the function body, after the existing `clearInterval` calls:

```javascript
      clearInterval(prPollInterval);
      prPollInterval = null;
```

- [ ] **Step 4: Update `init()` to load GitHub state**

Search for `async function init()` — find the `loadPrefs()` call inside it. Add GitHub initialization directly after `loadPrefs()`:

```javascript
      // Load GitHub state
      const ghData = await chrome.storage.local.get(['githubToken', 'githubUsername', 'enabledPRRepos']);
      if (ghData.githubToken) {
        githubToken = ghData.githubToken;
        githubUsername = ghData.githubUsername || null;
        if (ghData.enabledPRRepos) {
          enabledPRRepos = new Set(ghData.enabledPRRepos);
        }
      }

      // Load cached PRs for instant display
      const cachedPRData = await sendMsg({ type: 'getCachedPRs' });
      if (cachedPRData && cachedPRData.prs) {
        prReviews = cachedPRData.prs;
      }
```

Then find the line `refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);` inside `init()` (the one in the `if (authToken)` block after `showScreen('mainContent')`). Add after it:

```javascript
        // Start GitHub PR polling if connected
        if (githubToken) {
          if (githubUsername) {
            fetchPRReviews();
            startPRPolling();
          } else {
            validateGitHubToken().then(valid => {
              if (valid) { fetchPRReviews(); startPRPolling(); }
            });
          }
        }
```

**Additionally**, at the end of `init()`, after the `showScreen('authScreen')` call (the `else` path when no Google token exists), add PR loading for the case where GitHub is connected but Google is not:

```javascript
      // Start GitHub PR polling even without Google auth (they are independent)
      if (githubToken) {
        if (githubUsername) {
          fetchPRReviews();
          startPRPolling();
        } else {
          validateGitHubToken().then(valid => {
            if (valid) { fetchPRReviews(); startPRPolling(); }
          });
        }
      }
```

- [ ] **Step 5: Update `chrome.storage.onChanged` listener for GitHub token sync**

Search for `chrome.storage.onChanged.addListener` in `sidepanel.js`. Inside the callback, find the closing brace of the `if (changes.accessToken)` block. Add after it:

```javascript
      // GitHub token sync
      if (changes.githubToken) {
        const newToken = changes.githubToken.newValue;
        if (newToken && newToken !== githubToken) {
          githubToken = newToken;
          // If username not set, validate
          if (!githubUsername) {
            validateGitHubToken().then(valid => {
              if (valid) { fetchPRReviews(); startPRPolling(); }
              renderPRSection();
            });
          }
        } else if (!newToken && githubToken) {
          // Disconnected from another context
          githubToken = null;
          githubUsername = null;
          prReviews = [];
          clearInterval(prPollInterval);
          prPollInterval = null;
          renderPRSection();
          updatePRToolbarBadge();
        }
      }

      // PR repo filter sync
      if (changes.enabledPRRepos) {
        const newRepos = changes.enabledPRRepos.newValue;
        enabledPRRepos = newRepos ? new Set(newRepos) : null;
        renderPRSection();
      }
```

- [ ] **Step 6: Commit**

```bash
git add sidepanel.js
git commit -m "feat: integrate PR section into init, event listeners, and storage sync"
```

---

### Task 9: Manual Testing & Polish

**Files:**
- All modified files

This task covers manual verification since the project has no automated test framework.

- [ ] **Step 1: Verify extension loads without errors**

1. Open `chrome://extensions` (or `brave://extensions`)
2. Click "Reload" on the extension
3. Open the service worker DevTools (click "Inspect views: service worker")
4. Verify no errors in console
5. Open the side panel and verify no errors in its DevTools console

Expected: Extension loads cleanly, calendar works as before, PR section shows "Connect GitHub" prompt at the bottom.

- [ ] **Step 2: Verify GitHub OAuth flow**

1. Ensure you have a GitHub OAuth App created with the correct redirect URI
2. Ensure the Cloudflare Worker is deployed
3. Click "Connect GitHub" in the PR section
4. Complete the GitHub OAuth flow
5. Verify toast shows "Connected as @yourusername"
6. Verify PR section renders with your pending reviews (or empty state)

Expected: Successful OAuth, token stored, PRs fetched and displayed.

- [ ] **Step 3: Verify PR card display and detail slide-out**

1. With PRs loaded, verify cards show: title, repo, author avatar, time ago, diff stats
2. Verify re-reviews appear at the top with orange "Re-review" badge
3. Click a PR card — verify detail slide-out slides in from right
4. Verify detail shows: full title, description, author, labels, reviewers, diff stats, action buttons
5. Click "Open in GitHub" — verify it opens the correct PR URL
6. Click back button — verify slide-out closes

- [ ] **Step 4: Verify toolbar badge and extension badge**

1. Verify the PR toolbar icon shows in the sidepanel toolbar with the correct count
2. Wait for no upcoming meeting within 30 minutes
3. Verify the extension badge shows a purple number (PR count)
4. When a meeting is within 30 minutes, verify the badge shows the blue "Xm" instead

- [ ] **Step 5: Verify dark mode**

1. Toggle dark mode
2. Verify all PR elements render correctly in dark mode: cards, badges, detail view, connect prompt, settings

- [ ] **Step 6: Verify disconnect and filter**

1. Click the gear icon in the PR section header
2. Verify settings panel shows username and repo list
3. Uncheck a repo — verify its PRs disappear from the list
4. Click "Disconnect GitHub" — verify PR section shows connect prompt again
5. Verify badge and toolbar icon update accordingly

- [ ] **Step 7: Commit final state**

```bash
git add -A
git commit -m "feat: complete GitHub PR review notifications feature"
```
