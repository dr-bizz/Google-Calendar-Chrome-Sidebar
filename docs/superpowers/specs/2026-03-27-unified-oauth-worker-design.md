# Unified OAuth Worker Design

## Problem

Google OAuth fails for Chrome Web Store users with `Error 400: redirect_uri_mismatch`. The current implicit flow uses `chrome.identity.launchWebAuthFlow` which generates a redirect URI containing the extension ID (`https://{extension-id}.chromiumapp.org/`). This ID is unique per install, so only the developer's redirect URI is registered in Google Cloud Console.

The same problem will affect GitHub OAuth once the extension is distributed via the Web Store.

Additionally, both flows currently store raw access tokens in `chrome.storage.local`, which is less secure than server-side token storage.

## Solution

Replace both Google and GitHub OAuth flows with a unified Cloudflare Worker that:

1. Owns the redirect URI (fixed worker URL, same for all users)
2. Handles server-side token exchange (client secrets never in the extension)
3. Stores sensitive tokens in Cloudflare KV (refresh tokens for Google, access tokens for GitHub)
4. Returns opaque session tokens to the extension

## Architecture

### Worker Routes

| Route | Method | Purpose |
|---|---|---|
| `/google/auth` | GET | Redirect to Google consent screen |
| `/google/callback` | GET | Receive auth code from Google, exchange for tokens, store refresh token in KV, redirect to extension |
| `/google/refresh` | POST | Accept session token, use stored refresh token to get fresh access token |
| `/github/auth` | GET | Redirect to GitHub consent screen |
| `/github/callback` | GET | Receive auth code from GitHub, exchange for access token, store in KV, redirect to extension |
| `/github/retrieve` | POST | Accept session token, return stored GitHub access token |
| `/revoke` | POST | Accept session token + provider, delete KV entry |

### KV Structure

- Namespace: `AUTH_TOKENS`
- Key: `google:{sessionToken}` -> Value: `{ refreshToken, createdAt }` (JSON)
- Key: `github:{sessionToken}` -> Value: `{ accessToken, createdAt }` (JSON)

### Worker Environment Variables

- `GOOGLE_CLIENT_ID` — Google OAuth "Web application" client ID
- `GOOGLE_CLIENT_SECRET` — Google OAuth client secret
- `GITHUB_CLIENT_ID` — GitHub OAuth app client ID
- `GITHUB_CLIENT_SECRET` — GitHub OAuth app client secret
- `EXTENSION_ID` — Chrome extension ID (for redirect back to extension)
- KV binding: `AUTH_TOKENS`

## Auth Flows

### Google OAuth (New — Authorization Code Flow)

**Initial sign-in:**

1. User clicks "Sign In" in sidepanel
2. Extension opens a tab to `https://auth-worker.dr-bizz.workers.dev/google/auth`
3. Worker builds Google OAuth URL with:
   - `response_type=code`
   - `client_id` from env
   - `redirect_uri=https://auth-worker.dr-bizz.workers.dev/google/callback`
   - `scope=calendar.events calendar.readonly`
   - `access_type=offline` (to get refresh token)
   - `prompt=consent` (force consent to ensure refresh token is issued)
   - `state={random}` (CSRF protection)
4. Worker redirects browser to Google consent screen
5. User approves, Google redirects to `/google/callback?code=XXX&state=YYY`
6. Worker validates state, exchanges code + client_secret with Google token endpoint
7. Google returns `{ access_token, refresh_token, expires_in }`
8. Worker generates random session token via `crypto.randomUUID()`
9. Worker stores `google:{sessionToken} -> { refreshToken, createdAt }` in KV
10. Worker redirects to `chrome-extension://{EXTENSION_ID}/oauth_callback.html#session_token={sessionToken}&access_token={accessToken}&expires_in={expiresIn}&provider=google`
11. Extension's `oauth_callback.js` extracts session token + access token, sends to background.js
12. background.js stores `googleSessionToken` in `chrome.storage.local`, caches access token with timestamp

**Token refresh (background alarm at ~55 minutes):**

1. Background alarm fires or API call returns 401
2. Extension sends `POST /google/refresh` with `{ sessionToken }`
3. Worker looks up `google:{sessionToken}` in KV, gets refresh token
4. Worker exchanges refresh token with Google token endpoint using client_secret
5. Google returns `{ access_token, expires_in }`
6. Worker returns `{ accessToken, expiresIn }` to extension
7. Extension updates cached access token and timestamp

**Sign-out:**

1. Extension sends `POST /revoke` with `{ sessionToken, provider: "google" }`
2. Worker optionally revokes refresh token with Google
3. Worker deletes `google:{sessionToken}` from KV
4. Extension clears `googleSessionToken` from storage and access token from memory

### GitHub OAuth (Updated — Server-Side Token Storage)

**Initial sign-in:**

1. User clicks "Connect GitHub" in sidepanel
2. Extension opens a tab to `https://auth-worker.dr-bizz.workers.dev/github/auth`
3. Worker builds GitHub OAuth URL with:
   - `client_id` from env
   - `redirect_uri=https://auth-worker.dr-bizz.workers.dev/github/callback`
   - `scope=repo`
   - `state={random}` (CSRF protection)
4. Worker redirects browser to GitHub consent screen
5. User approves, GitHub redirects to `/github/callback?code=XXX&state=YYY`
6. Worker validates state, exchanges code + client_secret with GitHub token endpoint
7. GitHub returns `{ access_token }`
8. Worker generates random session token
9. Worker stores `github:{sessionToken} -> { accessToken, createdAt }` in KV
10. Worker redirects to `chrome-extension://{EXTENSION_ID}/oauth_callback.html#session_token={sessionToken}&provider=github`
11. Extension's `oauth_callback.js` extracts session token, sends to background.js
12. background.js stores `githubSessionToken` in `chrome.storage.local`

**On panel open (fetch token once per session):**

1. Extension sends `POST /github/retrieve` with `{ sessionToken }`
2. Worker looks up `github:{sessionToken}` in KV
3. Worker returns `{ accessToken }`
4. Extension caches access token in memory for the session
5. All GitHub API calls use this in-memory token

**Sign-out:**

1. Extension sends `POST /revoke` with `{ sessionToken, provider: "github" }`
2. Worker deletes `github:{sessionToken}` from KV
3. Extension clears `githubSessionToken` from storage and access token from memory

## Extension Changes

### `background.js`

- Remove: `authViaGetAuthToken`, `authViaWebAuthFlow`, `authViaTab` (all three Google auth strategies)
- Remove: `authViaGitHub` (current GitHub flow with direct `launchWebAuthFlow`)
- Remove: Silent refresh via `launchWebAuthFlow({ interactive: false })`
- Add: `WORKER_URL` constant pointing to the unified worker
- Add: `startGoogleAuth()` — opens tab to `{WORKER_URL}/google/auth`
- Add: `refreshGoogleToken()` — calls `POST /google/refresh` with session token
- Add: `startGitHubAuth()` — opens tab to `{WORKER_URL}/github/auth`
- Add: `retrieveGitHubToken()` — calls `POST /github/retrieve` with session token
- Add: `revokeSession(provider)` — calls `POST /revoke`
- Update: `startAuth` message handler to use `startGoogleAuth()`
- Update: `startGitHubAuth` message handler to use new flow
- Update: Token refresh alarm to call `refreshGoogleToken()` instead of silent `launchWebAuthFlow`
- Update: `signOut` handler to call `revokeSession('google')`
- Update: `disconnectGitHub` handler to call `revokeSession('github')`

### `oauth_callback.js`

- Update to handle both providers via URL fragment params
- Extract `session_token`, `access_token` (Google only), `expires_in` (Google only), `provider`
- Send appropriate message to background.js based on provider

### `sidepanel.js`

- Google API calls continue using in-memory `authToken` (populated from worker on sign-in and refresh)
- GitHub API calls use in-memory `githubToken` (fetched once on panel open via worker)
- Add: On panel open, if `githubSessionToken` exists, fetch access token from worker
- Remove: Direct storage of raw tokens

### `chrome.storage.local` Changes

| Old Key | New Key | Notes |
|---|---|---|
| `accessToken` | removed | No longer persisted; cached in memory |
| `tokenTime` | `googleTokenTime` | Tracks when access token was last refreshed |
| — | `googleSessionToken` | Opaque session token for Google refresh |
| `githubToken` | removed | Stored server-side in KV |
| `githubTokenTime` | removed | No longer needed |
| — | `githubSessionToken` | Opaque session token for GitHub retrieve |

### `manifest.json` Changes

- Add worker URL to `host_permissions`
- Remove `oauth2` section (no longer using Chrome identity OAuth)
- `identity` permission can be removed

### Worker Deployment

- Rename existing worker or deploy new worker as `auth-token-exchange`
- Create KV namespace: `wrangler kv namespace create "AUTH_TOKENS"`
- Add KV binding and env vars to `wrangler.toml`
- Set secrets via `wrangler secret put`
- Register `https://auth-worker.dr-bizz.workers.dev/google/callback` as redirect URI in Google Cloud Console "Web application" client
- Register `https://auth-worker.dr-bizz.workers.dev/github/callback` as callback URL in GitHub OAuth app settings

## Security

- **Client secrets** never leave the worker
- **Refresh tokens** (Google) stored server-side in KV, never sent to extension
- **Access tokens** (GitHub) stored server-side in KV, only sent to extension on demand and held in memory
- **Session tokens** are opaque random UUIDs, useless without the worker
- **CSRF protection** via `state` parameter on both flows
- **CORS** restricted to extension origin
- **State parameter** validated via signed cookie: the `/auth` route generates a random state, sets it as an `HttpOnly` cookie on the worker domain, and passes it to the OAuth provider. When the `/callback` fires, the worker compares the `state` query param against the cookie. This works because both `/auth` and `/callback` share the same worker domain. The cookie is short-lived (5 min max-age) and cleared after use.

## Error Handling

- **Worker down**: Extension shows "Authentication service unavailable, try again later"
- **KV lookup fails** (session expired/revoked): Return 401, extension clears session and shows sign-in screen
- **Google refresh token revoked**: `/google/refresh` returns error, extension clears session and prompts re-auth
- **GitHub token revoked**: `/github/retrieve` returns token, but GitHub API returns 401 — extension clears session and prompts reconnect
