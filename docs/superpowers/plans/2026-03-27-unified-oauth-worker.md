# Unified OAuth Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-extension redirect URIs with a unified Cloudflare Worker that owns the OAuth redirect for both Google and GitHub, stores sensitive tokens in KV, and returns opaque session tokens to the extension.

**Architecture:** A single Cloudflare Worker handles all OAuth flows (Google auth code exchange + refresh, GitHub auth code exchange + token retrieval). The worker stores Google refresh tokens and GitHub access tokens in Cloudflare KV, keyed by random session tokens. The extension only persists opaque session tokens in `chrome.storage.local`.

**Tech Stack:** Cloudflare Workers, Cloudflare KV, Chrome Extension Manifest V3, vanilla JavaScript

**Spec:** `docs/superpowers/specs/2026-03-27-unified-oauth-worker-design.md`

---

### Task 0: Merge GitHub PR branch into this branch

**Why:** The `feat/auth-fix-and-notifications` branch contains all GitHub OAuth and PR review code that we need to modify. Our current branch (`feat/unified-oauth-worker`) was created from `main` which doesn't have this code.

- [ ] **Step 1: Merge the feat branch**

```bash
git merge feat/auth-fix-and-notifications --no-edit
```

- [ ] **Step 2: Verify merge succeeded**

```bash
git log --oneline -5
```

Expected: Merge commit at top, followed by commits from both branches.

- [ ] **Step 3: Verify key files exist**

```bash
ls worker/github-token-exchange.js
head -5 background.js
```

Expected: Worker file exists, background.js starts with `const CLIENT_ID =`.

- [ ] **Step 4: Commit if needed**

If there are merge conflicts, resolve them and commit. Otherwise the merge commit is automatic.

---

### Task 1: Create the unified Cloudflare Worker

**Files:**
- Create: `worker/auth-token-exchange.js`
- Delete: `worker/github-token-exchange.js` (replaced by unified worker)

This is the core of the change. The worker handles 7 routes for both Google and GitHub OAuth.

- [ ] **Step 1: Create `worker/auth-token-exchange.js`**

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsOrigin = env.EXTENSION_ID
      ? `chrome-extension://${env.EXTENSION_ID}`
      : '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(corsOrigin),
      });
    }

    // Route dispatch
    try {
      switch (url.pathname) {
        case '/google/auth':
          return handleGoogleAuth(url, env);
        case '/google/callback':
          return handleGoogleCallback(url, env);
        case '/google/refresh':
          return handlePost(request, corsOrigin, (body) => handleGoogleRefresh(body, env));
        case '/github/auth':
          return handleGitHubAuth(url, env);
        case '/github/callback':
          return handleGitHubCallback(url, env);
        case '/github/retrieve':
          return handlePost(request, corsOrigin, (body) => handleGitHubRetrieve(body, env));
        case '/revoke':
          return handlePost(request, corsOrigin, (body) => handleRevoke(body, env));
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: 'Internal error' }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    }
  },
};

// ---- Helpers ----

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handlePost(request, corsOrigin, handler) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
  const body = await request.json();
  const result = await handler(body);
  return Response.json(result.data, {
    status: result.status || 200,
    headers: { 'Access-Control-Allow-Origin': corsOrigin },
  });
}

// ---- Google OAuth ----

function handleGoogleAuth(url, env) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/google/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const headers = new Headers({ Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  // Store state in a short-lived cookie for CSRF validation on callback
  headers.append('Set-Cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=300; Path=/google/callback`);
  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const extensionUrl = `chrome-extension://${env.EXTENSION_ID}/oauth_callback.html`;

  if (error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(error)}&provider=google`);
  }

  if (!code || !state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('Missing code or state')}&provider=google`);
  }

  // Note: state validation via cookie is added in Step 2 when request object is passed

  // Exchange code for tokens
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/google/callback`,
      grant_type: 'authorization_code',
    }),
  });

  const data = await tokenResponse.json();
  if (data.error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(data.error_description || data.error)}&provider=google`);
  }

  // Generate session token and store refresh token in KV
  const sessionToken = crypto.randomUUID();
  await env.AUTH_TOKENS.put(`google:${sessionToken}`, JSON.stringify({
    refreshToken: data.refresh_token,
    createdAt: Date.now(),
  }));

  // Redirect to extension with session token + access token
  const fragment = new URLSearchParams({
    session_token: sessionToken,
    access_token: data.access_token,
    expires_in: String(data.expires_in || 3600),
    provider: 'google',
  });
  return Response.redirect(`${extensionUrl}#${fragment}`);
}

async function handleGoogleRefresh(body, env) {
  const { sessionToken } = body;
  if (!sessionToken) {
    return { status: 400, data: { error: 'Missing sessionToken' } };
  }

  const stored = await env.AUTH_TOKENS.get(`google:${sessionToken}`);
  if (!stored) {
    return { status: 401, data: { error: 'Session not found or expired' } };
  }

  const { refreshToken } = JSON.parse(stored);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  const data = await tokenResponse.json();
  if (data.error) {
    // Refresh token may have been revoked
    if (data.error === 'invalid_grant') {
      await env.AUTH_TOKENS.delete(`google:${sessionToken}`);
    }
    return { status: 401, data: { error: data.error_description || data.error } };
  }

  return { data: { accessToken: data.access_token, expiresIn: data.expires_in || 3600 } };
}

// ---- GitHub OAuth ----

function handleGitHubAuth(url, env) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/github/callback`,
    scope: 'repo',
    state,
  });

  const headers = new Headers({ Location: `https://github.com/login/oauth/authorize?${params}` });
  headers.append('Set-Cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=300; Path=/github/callback`);
  return new Response(null, { status: 302, headers });
}

async function handleGitHubCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const extensionUrl = `chrome-extension://${env.EXTENSION_ID}/oauth_callback.html`;

  if (error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(error)}&provider=github`);
  }

  if (!code || !state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('Missing code or state')}&provider=github`);
  }

  // Exchange code for token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = await tokenResponse.json();
  if (data.error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(data.error_description || data.error)}&provider=github`);
  }

  // Generate session token and store access token in KV
  const sessionToken = crypto.randomUUID();
  await env.AUTH_TOKENS.put(`github:${sessionToken}`, JSON.stringify({
    accessToken: data.access_token,
    createdAt: Date.now(),
  }));

  const fragment = new URLSearchParams({
    session_token: sessionToken,
    provider: 'github',
  });
  return Response.redirect(`${extensionUrl}#${fragment}`);
}

async function handleGitHubRetrieve(body, env) {
  const { sessionToken } = body;
  if (!sessionToken) {
    return { status: 400, data: { error: 'Missing sessionToken' } };
  }

  const stored = await env.AUTH_TOKENS.get(`github:${sessionToken}`);
  if (!stored) {
    return { status: 401, data: { error: 'Session not found or expired' } };
  }

  const { accessToken } = JSON.parse(stored);
  return { data: { accessToken } };
}

// ---- Revoke ----

async function handleRevoke(body, env) {
  const { sessionToken, provider } = body;
  if (!sessionToken || !provider) {
    return { status: 400, data: { error: 'Missing sessionToken or provider' } };
  }

  if (provider !== 'google' && provider !== 'github') {
    return { status: 400, data: { error: 'Invalid provider' } };
  }

  const key = `${provider}:${sessionToken}`;
  const stored = await env.AUTH_TOKENS.get(key);

  if (stored && provider === 'google') {
    // Optionally revoke the refresh token with Google
    try {
      const { refreshToken } = JSON.parse(stored);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (e) {
      // Best-effort revocation
    }
  }

  await env.AUTH_TOKENS.delete(key);
  return { data: { success: true } };
}
```

**Note on state validation:** The `/auth` routes set a cookie, but the `/callback` routes receive it on the request. We need to pass the `request` object to the callback handlers. This is handled in Step 2.

- [ ] **Step 2: Fix the route dispatch to pass `request` to callback handlers for cookie validation**

Update the route dispatch in the `fetch` handler and the callback functions to receive the request object and validate the state cookie:

Replace the route dispatch `switch` block:

```javascript
    // Route dispatch
    try {
      switch (url.pathname) {
        case '/google/auth':
          return handleGoogleAuth(url, env);
        case '/google/callback':
          return handleGoogleCallback(request, url, env);
        case '/google/refresh':
          return handlePost(request, corsOrigin, (body) => handleGoogleRefresh(body, env));
        case '/github/auth':
          return handleGitHubAuth(url, env);
        case '/github/callback':
          return handleGitHubCallback(request, url, env);
        case '/github/retrieve':
          return handlePost(request, corsOrigin, (body) => handleGitHubRetrieve(body, env));
        case '/revoke':
          return handlePost(request, corsOrigin, (body) => handleRevoke(body, env));
        default:
          return new Response('Not found', { status: 404 });
      }
    }
```

Add a cookie parsing helper after the `corsHeaders` function:

```javascript
function getCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match ? match.split('=')[1] : null;
}
```

Update `handleGoogleCallback` signature and add state validation:

```javascript
async function handleGoogleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const extensionUrl = `chrome-extension://${env.EXTENSION_ID}/oauth_callback.html`;

  if (error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(error)}&provider=google`);
  }

  if (!code || !state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('Missing code or state')}&provider=google`);
  }

  // Validate state against cookie
  const savedState = getCookie(request, 'oauth_state');
  if (!savedState || savedState !== state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('State mismatch — possible CSRF')}&provider=google`);
  }
```

(Rest of function stays the same.)

Update `handleGitHubCallback` the same way:

```javascript
async function handleGitHubCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const extensionUrl = `chrome-extension://${env.EXTENSION_ID}/oauth_callback.html`;

  if (error) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent(error)}&provider=github`);
  }

  if (!code || !state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('Missing code or state')}&provider=github`);
  }

  // Validate state against cookie
  const savedState = getCookie(request, 'oauth_state');
  if (!savedState || savedState !== state) {
    return Response.redirect(`${extensionUrl}#error=${encodeURIComponent('State mismatch — possible CSRF')}&provider=github`);
  }
```

(Rest of function stays the same.)

- [ ] **Step 3: Delete the old worker file**

```bash
rm worker/github-token-exchange.js
```

- [ ] **Step 4: Commit**

```bash
git add worker/auth-token-exchange.js
git rm worker/github-token-exchange.js
git commit -m "feat: create unified OAuth worker with Google and GitHub routes"
```

---

### Task 2: Create Wrangler configuration

**Files:**
- Create: `worker/wrangler.toml`

- [ ] **Step 1: Create `worker/wrangler.toml`**

```toml
name = "auth-token-exchange"
main = "auth-token-exchange.js"
compatibility_date = "2024-01-01"

[vars]
EXTENSION_ID = "fefpaminbjodcadohglcnikaklhbjfgb"

[[kv_namespaces]]
binding = "AUTH_TOKENS"
id = "PLACEHOLDER_KV_ID"
```

**Note:** The `id` for the KV namespace must be filled in after running `wrangler kv namespace create "AUTH_TOKENS"`. The `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` should be set as secrets via `wrangler secret put`, not in this file.

- [ ] **Step 2: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore: add wrangler config for unified auth worker"
```

---

### Task 3: Update `oauth_callback.js` for multi-provider support

**Files:**
- Modify: `oauth_callback.js`

The callback page now handles both Google (session_token + access_token) and GitHub (session_token only) redirects from the worker.

- [ ] **Step 1: Rewrite `oauth_callback.js`**

```javascript
(function() {
  const container = document.getElementById('content');
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);

  const provider = params.get('provider');
  const error = params.get('error');
  const sessionToken = params.get('session_token');
  const accessToken = params.get('access_token');
  const expiresIn = params.get('expires_in');

  if (error) {
    const safeError = error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>Error: ' + safeError + '</p>' +
      '<p>You can close this tab and try again.</p>';
    return;
  }

  if (!sessionToken || !provider) {
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>No session received. Please try again.</p>' +
      '<p>You can close this tab.</p>';
    return;
  }

  // Build message based on provider
  const message = { type: 'oauthCallback', provider, sessionToken };
  if (provider === 'google' && accessToken) {
    message.accessToken = accessToken;
    message.expiresIn = parseInt(expiresIn, 10) || 3600;
  }

  chrome.runtime.sendMessage(message, function(response) {
    if (chrome.runtime.lastError) {
      const safeMsg = (chrome.runtime.lastError.message || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      container.innerHTML =
        '<div class="error">&#10007;</div>' +
        '<h2>Error</h2>' +
        '<p>' + safeMsg + '</p>' +
        '<p>You can close this tab and try again.</p>';
      return;
    }

    const label = provider === 'google' ? 'Google Calendar' : 'GitHub';
    container.innerHTML =
      '<div class="success">&#10003;</div>' +
      '<h2>Connected to ' + label + '!</h2>' +
      '<p>This tab will close automatically...</p>';
    setTimeout(function() { window.close(); }, 1500);
  });
})();
```

- [ ] **Step 2: Commit**

```bash
git add oauth_callback.js
git commit -m "feat: update oauth_callback.js for multi-provider session tokens"
```

---

### Task 4: Update `manifest.json`

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Update manifest.json**

Changes:
- Remove `identity` from permissions (no longer using `chrome.identity`)
- Remove `oauth2` section entirely
- Replace GitHub worker URL with unified worker URL in `host_permissions`
- Add unified worker URL to `web_accessible_resources` matches (so the worker can redirect back)

Updated `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Google Calendar Side Panel",
  "version": "8.0",
  "short_name": "Cal Panel",
  "description": "Always-visible Google Calendar in your browser's side panel",
  "permissions": [
    "sidePanel",
    "storage",
    "tabs",
    "alarms",
    "notifications"
  ],
  "host_permissions": [
    "https://www.googleapis.com/*",
    "https://api.github.com/*",
    "https://auth-token-exchange.dr-bizz.workers.dev/*"
  ],
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "Toggle Google Calendar Side Panel",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "web_accessible_resources": [
    {
      "resources": ["oauth_callback.html", "oauth_callback.js"],
      "matches": [
        "https://accounts.google.com/*",
        "https://auth-token-exchange.dr-bizz.workers.dev/*"
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add manifest.json
git commit -m "feat: update manifest for unified worker, remove identity permission and oauth2 section"
```

---

### Task 5: Rewrite `background.js` — Google auth

**Files:**
- Modify: `background.js`

This task replaces the Google OAuth code. We remove all three auth strategies and replace with the worker-based flow.

- [ ] **Step 1: Replace config constants and helper functions at the top of `background.js`**

Replace the Google OAuth constants and helper functions (CLIENT_ID, SCOPES, getRedirectURL, buildAuthURL, extractTokenFromUrl) with:

```javascript
const WORKER_URL = 'https://auth-token-exchange.dr-bizz.workers.dev';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';
```

Keep `storeToken` but update it to store the session token and access token:

```javascript
async function storeGoogleSession(sessionToken, accessToken) {
  await chrome.storage.local.set({
    googleSessionToken: sessionToken,
    googleTokenTime: Date.now(),
  });
  // Schedule proactive refresh at 55 minutes
  chrome.alarms.create('tokenRefresh', { delayInMinutes: 55 });
  return accessToken;
}
```

- [ ] **Step 2: Replace the token refresh alarm handler**

Replace the `checkToken` / `tokenRefresh` alarm handler with:

```javascript
  if (alarm.name === 'checkToken' || alarm.name === 'tokenRefresh') {
    // Proactive token refresh via worker
    try {
      const data = await chrome.storage.local.get(['googleSessionToken', 'googleTokenTime']);
      if (data.googleSessionToken && data.googleTokenTime) {
        const age = Date.now() - data.googleTokenTime;
        if (age > 3300000) { // 55 minutes
          console.log('[Alarms] Token is older than 55 minutes, refreshing via worker');
          try {
            const response = await fetch(`${WORKER_URL}/google/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionToken: data.googleSessionToken }),
            });
            const result = await response.json();
            if (result.accessToken) {
              console.log('[Alarms] Token refresh succeeded');
              await chrome.storage.local.set({ googleTokenTime: Date.now() });
              // Notify open sidepanels about the new token
              chrome.runtime.sendMessage({
                type: 'tokenRefreshed',
                accessToken: result.accessToken,
              }).catch(() => {});
            } else {
              console.log('[Alarms] Token refresh failed:', result.error);
            }
          } catch (e) {
            console.log('[Alarms] Token refresh error:', e.message || e);
          }
        }
      }
    } catch (e) {
      console.error('[Alarms] checkToken error:', e);
    }
  }
```

- [ ] **Step 3: Remove the three old auth strategies**

Delete these functions entirely:
- `authViaGetAuthToken()`
- `authViaWebAuthFlow()`
- `authViaTab()`

- [ ] **Step 4: Add new Google auth function**

```javascript
async function startGoogleAuth() {
  return new Promise((resolve) => {
    const authUrl = `${WORKER_URL}/google/auth`;
    console.log('[Google Auth] Opening auth tab:', authUrl);

    chrome.tabs.create({ url: authUrl }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ error: 'Failed to open auth tab: ' + chrome.runtime.lastError.message });
        return;
      }

      // Listen for the callback message from oauth_callback.js
      const listener = (message, sender, sendResponse) => {
        if (message.type === 'oauthCallback' && message.provider === 'google') {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          try { chrome.tabs.remove(tab.id); } catch (e) {}

          if (message.sessionToken && message.accessToken) {
            storeGoogleSession(message.sessionToken, message.accessToken);
            resolve({ token: message.accessToken });
          } else {
            resolve({ error: 'No session token received' });
          }
          sendResponse({ ok: true });
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      // Timeout after 5 minutes
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ error: 'Auth timed out after 5 minutes' });
      }, 300000);

      // Clean up if tab is closed manually
      const tabListener = (tabId) => {
        if (tabId === tab.id) {
          chrome.tabs.onRemoved.removeListener(tabListener);
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          setTimeout(() => resolve({ error: 'Auth tab was closed' }), 500);
        }
      };
      chrome.tabs.onRemoved.addListener(tabListener);
    });
  });
}
```

- [ ] **Step 5: Add Google token refresh function**

```javascript
async function refreshGoogleToken() {
  const data = await chrome.storage.local.get(['googleSessionToken']);
  if (!data.googleSessionToken) return null;

  try {
    const response = await fetch(`${WORKER_URL}/google/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: data.googleSessionToken }),
    });
    const result = await response.json();
    if (result.accessToken) {
      await chrome.storage.local.set({ googleTokenTime: Date.now() });
      return result.accessToken;
    }
    return null;
  } catch (e) {
    console.error('[Auth] Token refresh error:', e);
    return null;
  }
}
```

- [ ] **Step 6: Add revoke session function**

```javascript
async function revokeSession(provider) {
  const storageKey = provider === 'google' ? 'googleSessionToken' : 'githubSessionToken';
  const data = await chrome.storage.local.get([storageKey]);
  const sessionToken = data[storageKey];

  if (sessionToken) {
    try {
      await fetch(`${WORKER_URL}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken, provider }),
      });
    } catch (e) {
      console.log(`[Auth] Revoke ${provider} error (best-effort):`, e.message);
    }
  }

  if (provider === 'google') {
    await chrome.storage.local.remove(['googleSessionToken', 'googleTokenTime']);
  } else {
    await chrome.storage.local.remove(['githubSessionToken', 'githubUsername']);
  }
}
```

- [ ] **Step 7: Update the `startAuth` message handler**

Replace the existing `startAuth` handler with:

```javascript
  if (message.type === 'startAuth') {
    (async () => {
      console.log('[Auth] Starting Google authentication via worker...');
      const result = await startGoogleAuth();
      sendResponse(result);
    })();
    return true;
  }
```

- [ ] **Step 8: Update the `getStoredToken` message handler**

Replace with a handler that checks the session token and refreshes if needed:

```javascript
  if (message.type === 'getStoredToken') {
    (async () => {
      const data = await chrome.storage.local.get(['googleSessionToken', 'googleTokenTime']);
      if (!data.googleSessionToken) {
        sendResponse({ token: null });
        return;
      }
      // Try to get a fresh token via the worker
      const token = await refreshGoogleToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }
```

- [ ] **Step 9: Update the `signOut` message handler**

Replace with:

```javascript
  if (message.type === 'signOut') {
    (async () => {
      await chrome.storage.local.set({ explicitSignOutTime: Date.now() });
      await revokeSession('google');
      sendResponse({ success: true });
    })();
    return true;
  }
```

- [ ] **Step 10: Update the `silentRefresh` message handler**

Replace with:

```javascript
  if (message.type === 'silentRefresh') {
    (async () => {
      const token = await refreshGoogleToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }
```

- [ ] **Step 11: Update the `oauthToken` handler to handle the new callback format**

Replace the old `oauthToken` handler with a handler for the new `oauthCallback` message type:

```javascript
  if (message.type === 'oauthCallback') {
    (async () => {
      if (message.provider === 'google' && message.sessionToken && message.accessToken) {
        await storeGoogleSession(message.sessionToken, message.accessToken);
        sendResponse({ success: true });
      } else if (message.provider === 'github' && message.sessionToken) {
        await chrome.storage.local.set({
          githubSessionToken: message.sessionToken,
        });
        sendResponse({ success: true });
      } else {
        sendResponse({ error: 'Invalid callback data' });
      }
    })();
    return true;
  }
```

- [ ] **Step 12: Remove `saveManualToken` handler and `getRedirectURLs` handler**

These are no longer needed since auth goes through the worker. Delete the handlers for:
- `saveManualToken`
- `getRedirectURLs`

- [ ] **Step 13: Commit**

```bash
git add background.js
git commit -m "feat: replace Google auth strategies with worker-based OAuth flow"
```

---

### Task 6: Rewrite `background.js` — GitHub auth

**Files:**
- Modify: `background.js`

- [ ] **Step 1: Remove GitHub config constants**

Delete:
```javascript
const GITHUB_CLIENT_ID = 'Ov23liLXcKeNsvuH4dg4';
const GITHUB_WORKER_URL = 'https://github-token-exchange.dr-bizz.workers.dev';
const GITHUB_SCOPE = 'repo';
```

(These are now in the worker's env vars.)

- [ ] **Step 2: Remove `authViaGitHub()` function**

Delete the entire `authViaGitHub()` function.

- [ ] **Step 3: Add new GitHub auth function**

```javascript
async function startGitHubAuth() {
  return new Promise((resolve) => {
    const authUrl = `${WORKER_URL}/github/auth`;
    console.log('[GitHub Auth] Opening auth tab:', authUrl);

    chrome.tabs.create({ url: authUrl }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ error: 'Failed to open auth tab: ' + chrome.runtime.lastError.message });
        return;
      }

      const listener = (message, sender, sendResponse) => {
        if (message.type === 'oauthCallback' && message.provider === 'github') {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          try { chrome.tabs.remove(tab.id); } catch (e) {}

          if (message.sessionToken) {
            chrome.storage.local.set({ githubSessionToken: message.sessionToken });
            resolve({ sessionToken: message.sessionToken });
          } else {
            resolve({ error: 'No session token received' });
          }
          sendResponse({ ok: true });
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ error: 'Auth timed out after 5 minutes' });
      }, 300000);

      const tabListener = (tabId) => {
        if (tabId === tab.id) {
          chrome.tabs.onRemoved.removeListener(tabListener);
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          setTimeout(() => resolve({ error: 'Auth tab was closed' }), 500);
        }
      };
      chrome.tabs.onRemoved.addListener(tabListener);
    });
  });
}
```

- [ ] **Step 4: Add GitHub token retrieval function**

```javascript
async function retrieveGitHubToken() {
  const data = await chrome.storage.local.get(['githubSessionToken']);
  if (!data.githubSessionToken) return null;

  try {
    const response = await fetch(`${WORKER_URL}/github/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: data.githubSessionToken }),
    });
    const result = await response.json();
    return result.accessToken || null;
  } catch (e) {
    console.error('[GitHub] Token retrieval error:', e);
    return null;
  }
}
```

- [ ] **Step 5: Update `startGitHubAuth` message handler**

Replace with:

```javascript
  if (message.type === 'startGitHubAuth') {
    (async () => {
      const result = await startGitHubAuth();
      if (result.sessionToken) {
        // Retrieve the actual token for immediate use
        const token = await retrieveGitHubToken();
        sendResponse({ token, sessionToken: result.sessionToken });
      } else {
        sendResponse({ error: result.error });
      }
    })();
    return true;
  }
```

- [ ] **Step 6: Update `getGitHubToken` message handler**

Replace with:

```javascript
  if (message.type === 'getGitHubToken') {
    (async () => {
      const token = await retrieveGitHubToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }
```

- [ ] **Step 7: Update `disconnectGitHub` message handler**

Replace with:

```javascript
  if (message.type === 'disconnectGitHub') {
    (async () => {
      await revokeSession('github');
      await chrome.storage.local.remove(['cachedPRs', 'prCacheTime', 'notifiedPRKeys']);
      sendResponse({ success: true });
    })();
    return true;
  }
```

- [ ] **Step 8: Update GitHub background polling alarm**

The PR polling alarm (`pollPRs`) currently uses the token from storage. Update it to retrieve the token from the worker:

Find the alarm handler that calls `fetchPRsForBadge` or similar and ensure it uses `retrieveGitHubToken()` to get the token before making API calls. The token should be passed through or stored temporarily for the polling cycle.

- [ ] **Step 9: Commit**

```bash
git add background.js
git commit -m "feat: replace GitHub auth with worker-based OAuth flow"
```

---

### Task 7: Update `sidepanel.js` — Google auth changes

**Files:**
- Modify: `sidepanel.js`

- [ ] **Step 1: Update `init()` function**

In `init()`, remove the `getRedirectURLs` call and debug info display. The init should:
1. Check for a stored Google session token
2. If found, refresh the access token via the worker
3. If successful, proceed to load events

Replace the relevant section of `init()`:

```javascript
    async function init() {
      loadPrefs();

      // Load GitHub state
      const ghData = await chrome.storage.local.get(['githubSessionToken', 'githubUsername', 'enabledPRRepos']);
      if (ghData.githubSessionToken) {
        // Retrieve GitHub token from worker (cached in memory for session)
        const ghToken = await sendMsg({ type: 'getGitHubToken' });
        if (ghToken && ghToken.token) {
          githubToken = ghToken.token;
          githubUsername = ghData.githubUsername || null;
          if (ghData.enabledPRRepos) {
            enabledPRRepos = new Set(ghData.enabledPRRepos);
          }
        }
      }

      // Check for existing Google session
      const stored = await sendMsg({ type: 'getStoredToken' });
      if (stored && stored.token) {
        authToken = stored.token;

        const cached = await loadCachedEvents();
        if (cached && cached.length) {
          events = cached;
          showScreen('mainContent');
          renderAll();
          loadEvents().then(() => { renderAll(); });
        } else {
          showScreen('loadingScreen');
          await loadEvents();
        }

        if (authToken) {
          showScreen('mainContent');
          refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
        }

        // Start PR polling if GitHub is connected
        if (githubToken) {
          await fetchPRReviews();
          startPRPolling();
        }
        return;
      }

      showScreen('authScreen');
    }
```

- [ ] **Step 2: Remove the manual token entry screen and handler**

Remove the sign-in handler code that shows setup/redirect URI debug info.

Remove the manual token entry button handler and the `manualScreen`-related code (the `goManualBtn` click handler, `submitManualTokenBtn` handler).

These are no longer needed since users just click "Sign in" and go through the worker flow.

- [ ] **Step 3: Update `tryReAuth()` to use worker refresh**

The current `tryReAuth` uses `silentRefresh` which still works (we updated the handler in Task 5 Step 10). No changes needed here — it already calls `sendMsg({ type: 'silentRefresh' })` which now goes through the worker.

- [ ] **Step 4: Update `storage.onChanged` listener**

Update the listener to watch for `googleSessionToken` instead of `accessToken`:

```javascript
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      if (changes.googleSessionToken) {
        const newSession = changes.googleSessionToken.newValue;

        if (newSession && !authToken) {
          // Another tab signed in — refresh our token
          console.log('[Sync] Google session added from another tab');
          sendMsg({ type: 'getStoredToken' }).then(stored => {
            if (stored && stored.token) {
              authToken = stored.token;
              clearReAuthBanner();
              showScreen('loadingScreen');
              loadEvents().then(() => {
                showScreen('mainContent');
                if (!refreshInterval) {
                  refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
                }
              });
            }
          });
        } else if (!newSession && authToken) {
          // Session was cleared (sign out from another tab)
          console.log('[Sync] Google session cleared from another tab');
          authToken = null;
          clearAllIntervals();
          events = [];
          showScreen('authScreen');
        }
      }
    });
```

- [ ] **Step 5: Listen for `tokenRefreshed` messages from background**

Add a listener so that when the background alarm refreshes the token, the sidepanel picks it up:

```javascript
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'tokenRefreshed' && message.accessToken) {
        authToken = message.accessToken;
        console.log('[Sync] Token refreshed by background alarm');
      }
    });
```

- [ ] **Step 6: Update `connectGitHub()` function**

Update to use the new auth flow that goes through the worker:

```javascript
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
        showToast(result?.error || 'GitHub connection failed');
      }
      renderPRSection();
    }
```

(This is largely the same since the message handler returns `{ token }` in both old and new flows.)

- [ ] **Step 7: Commit**

```bash
git add sidepanel.js
git commit -m "feat: update sidepanel for worker-based auth and session tokens"
```

---

### Task 8: Clean up removed features

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`

- [ ] **Step 1: Remove manual token entry UI from `sidepanel.html`**

Remove the `manualScreen` div and the "Enter token manually" button from the auth screen, if they exist. Also remove the setup/debug info sections from the auth screen since redirect URIs are no longer user-facing.

- [ ] **Step 2: Remove the `setupScreen` if it only exists for OAuth setup**

Check if `setupScreen` is used for first-time OAuth configuration. If so, remove it — users no longer need to configure redirect URIs.

- [ ] **Step 3: Update `hideAllScreens` to remove references to deleted screens**

If `manualScreen` or `setupScreen` were removed, update the `hideAllScreens` function to remove their IDs from the array.

- [ ] **Step 4: Commit**

```bash
git add sidepanel.html sidepanel.js
git commit -m "chore: remove manual token entry and OAuth setup screens"
```

---

### Task 9: Update `web_accessible_resources` in manifest

**Files:**
- Modify: `manifest.json`

The worker redirects back to `chrome-extension://{EXTENSION_ID}/oauth_callback.html`. For this to work, the callback page must be accessible. The current `web_accessible_resources` only allows `accounts.google.com`. We need to also allow the worker domain.

- [ ] **Step 1: Verify manifest already updated**

This was already done in Task 4. Verify that `manifest.json` has:

```json
  "web_accessible_resources": [
    {
      "resources": ["oauth_callback.html", "oauth_callback.js"],
      "matches": [
        "https://accounts.google.com/*",
        "https://auth-token-exchange.dr-bizz.workers.dev/*"
      ]
    }
  ]
```

- [ ] **Step 2: Commit if any changes needed**

```bash
git add manifest.json
git commit -m "fix: ensure worker domain can access oauth_callback resources"
```

---

### Task 10: Worker deployment steps (manual)

These steps require the user to run commands interactively with Wrangler.

- [ ] **Step 1: Create KV namespace**

```bash
cd worker
npx wrangler kv namespace create "AUTH_TOKENS"
```

Copy the `id` from the output and update `worker/wrangler.toml` with the real KV namespace ID.

- [ ] **Step 2: Set secrets**

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

- [ ] **Step 3: Deploy**

```bash
npx wrangler deploy
```

- [ ] **Step 4: Register redirect URIs**

In Google Cloud Console:
- Create a "Web application" OAuth client (or update existing)
- Add `https://auth-token-exchange.dr-bizz.workers.dev/google/callback` as an Authorized redirect URI

In GitHub OAuth app settings:
- Update the Authorization callback URL to `https://auth-token-exchange.dr-bizz.workers.dev/github/callback`

- [ ] **Step 5: Test end-to-end**

1. Load the extension unpacked
2. Click "Sign in with Google" — should open worker URL, redirect to Google, then back to extension
3. Calendar events should load
4. Click "Connect GitHub" — should open worker URL, redirect to GitHub, then back to extension
5. PR reviews should load
6. Wait 55+ minutes (or manually trigger alarm) — token should refresh silently
7. Sign out of Google — should clear session and show auth screen
8. Disconnect GitHub — should clear session and hide PR section

- [ ] **Step 6: Commit wrangler.toml with real KV ID**

```bash
git add worker/wrangler.toml
git commit -m "chore: set real KV namespace ID in wrangler config"
```
