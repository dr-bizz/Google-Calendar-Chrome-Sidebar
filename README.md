# Google Calendar Side Panel

A Chrome/Brave/Edge extension that displays your Google Calendar in the browser's side panel — always visible while you browse. Optionally integrates with GitHub to show PRs awaiting your review.

## Features

### Calendar
- **Side panel calendar** — view your agenda without switching tabs
- **Mini calendar** — month view with event indicators, click any date to filter
- **Timeline view** — visual daily schedule with hour blocks, overlapping event columns, and a live "now" line
- **Meeting alerts** — full-screen animated overlay when a meeting is about to start, with a "Join Call" button
- **Desktop notifications** — get notified before meetings start
- **Event detail view** — click any event to see full details: description, guests, attachments, organizer, and meeting link
- **RSVP from the sidebar** — accept, decline, or maybe directly from the event detail screen
- **Needs response indicators** — unresponded events shown with dashed borders and striped backgrounds
- **Next meeting card** — countdown timer with urgency colors
- **Day summary** — at-a-glance stats for meetings, free time, and focus blocks
- **Multi-calendar support** — filter which calendars to show
- **Dark mode** — follows system preference or toggle manually
- **Badge notifications** — extension badge shows minutes until next meeting
- **Offline caching** — cached events for instant loading on reopen

### GitHub PR Reviews
- **PR review tracker** — see all PRs awaiting your review in one place
- **Re-review detection** — re-reviews sorted to the top with orange badge
- **PR detail view** — click any PR to see description, reviewers, diff stats, labels
- **Desktop notifications** — get notified when new review requests come in
- **Smart polling** — 2-minute refresh when panel is open, 10-minute background polling
- **Repo filtering** — choose which repos to show via settings gear
- **Badge integration** — extension badge shows PR count when no meeting is imminent

## Install from Chrome Web Store

> **Status: Pending approval.** The extension has been submitted and is awaiting Chrome Web Store review.

Once approved, install from the [Chrome Web Store listing](https://chromewebstore.google.com/detail/fefpaminbjodcadohglcnikaklhbjfgb/preview):

1. Click **Add to Chrome**
2. Pin the extension to your toolbar (click the puzzle icon, then the pin)
3. Click the extension icon to open the side panel
4. Click **Sign in with Google** — a new tab opens for Google sign-in
5. Approve the calendar permissions and the tab closes automatically
6. Your calendar events appear in the side panel

To connect GitHub PR reviews, scroll to the bottom of the side panel and click **Connect GitHub**.

No configuration, no API keys, no setup required — it just works.

## Install from Source (Developer Setup)

If you want to load the extension directly from the source code (for development or before Web Store approval):

### Step 1: Load the Extension

1. Clone or download this repository
2. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Pin the extension to your toolbar

> **Important:** Never remove and re-add the extension. If you need to update, replace the files and click the **reload** button. Removing it changes the Extension ID and breaks your OAuth configuration.

### Step 2: Deploy the Auth Worker

The extension uses a Cloudflare Worker for OAuth token exchange. You need to deploy your own:

**Prerequisites:**
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- A [Google Cloud](https://console.cloud.google.com/) account (free)
- Node.js installed

**A) Set up Google OAuth:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project and enable **Google Calendar API**
3. Go to [Auth Overview](https://console.cloud.google.com/auth/overview) and configure the consent screen (External, add your email as test user, add `calendar.events` scope)
4. Go to [Auth Clients](https://console.cloud.google.com/auth/clients) → **+ Create Client** → **Web application**
5. Under **Authorized redirect URIs**, add: `https://YOUR-WORKER-NAME.YOUR-ACCOUNT.workers.dev/google/callback`
6. Copy the **Client ID** and **Client Secret**

**B) Set up GitHub OAuth (optional, for PR reviews):**

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → **New OAuth App**
2. Set **Authorization callback URL** to: `https://YOUR-WORKER-NAME.YOUR-ACCOUNT.workers.dev/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**

**C) Deploy the worker:**

```bash
cd worker
npm install -g wrangler       # if not already installed
wrangler login                # authenticate with Cloudflare
wrangler kv namespace create "AUTH_TOKENS"
```

Update `worker/wrangler.toml`:
- Set the KV namespace `id` from the output above
- Set `EXTENSION_ID` to your extension's ID (from `chrome://extensions`)

Then deploy and set secrets:

```bash
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID      # optional
npx wrangler secret put GITHUB_CLIENT_SECRET   # optional
```

**D) Update extension config:**

1. Open `background.js` — update the `WORKER_URL` on line 2 to your deployed worker URL
2. Open `manifest.json` — update the worker domain in `host_permissions`

### Step 3: Reload and Test

1. Go to `chrome://extensions` and click **reload** on the extension
2. Click the extension icon to open the side panel
3. Click **Sign in with Google** — a tab opens, you sign in, and it auto-closes
4. *(If GitHub configured)* Scroll down and click **Connect GitHub**

### Development

There's no build step — edit files directly and reload:

1. Make changes to the source files
2. Click reload on `chrome://extensions`
3. Reopen the side panel to see changes

## Architecture

### Files

| File | Responsibility |
|------|---------------|
| `background.js` | Service worker: OAuth coordination, token lifecycle, alarms (badge, notifications, PR polling), message handling |
| `sidepanel.js` | UI logic: Google Calendar + GitHub API calls, rendering, event handling, RSVP, PR cards |
| `sidepanel.html` | Markup and embedded CSS (light/dark themes via CSS variables) |
| `oauth_callback.js/html` | Multi-provider OAuth redirect handler (Google + GitHub) |
| `worker/auth-token-exchange.js` | Cloudflare Worker: OAuth token exchange, refresh token storage (KV), session management |

### Authentication

Both Google and GitHub use the same pattern — a Cloudflare Worker owns the OAuth redirect URI:

1. Extension opens a tab to `{worker}/google/auth` (or `/github/auth`)
2. Worker redirects to the provider's consent screen
3. Provider redirects back to the worker with an authorization code
4. Worker exchanges code + client secret for tokens
5. Worker stores sensitive tokens (refresh/access) in Cloudflare KV
6. Worker redirects to extension's `oauth_callback.html` with an opaque session token
7. Extension stores the session token locally

This means:
- **Client secrets never leave the worker** — they're Cloudflare secrets
- **Refresh tokens stay server-side** — only the worker can use them
- **Works for all users** — the redirect URI is the worker URL, not per-extension
- **No browser-specific APIs** — works identically in Chrome, Brave, and Edge

### Data Flow

- **Calendar:** `background.js` manages session tokens → refreshes access tokens via worker → `sidepanel.js` fetches events from Google Calendar API → renders timeline, cards, alerts → caches in `chrome.storage.local`
- **GitHub PRs:** `sidepanel.js` retrieves access token from worker → fetches from GitHub Search + PR detail APIs → enriches with review history + timeline → renders PR cards → `background.js` handles background polling + notifications + badge

### Storage

- `chrome.storage.local` — session tokens, cached access tokens, cached events/PRs, notification tracking, repo filter
- `localStorage` — UI preferences (dark mode, collapse states, calendar filter)

## Troubleshooting

### Google Calendar

**Sign-in opens a tab but nothing happens:**
- Check that your worker is deployed and reachable
- Verify the Google OAuth redirect URI matches `https://YOUR-WORKER/google/callback`

**"No refresh token received" error:**
- Go to [Google Account Permissions](https://myaccount.google.com/permissions), revoke access to the app, and try signing in again

**Token expired / session expired:**
The extension automatically refreshes tokens every 55 minutes. If you see a re-auth prompt, your server-side session may have expired (90-day TTL). Click "Sign in" again.

### GitHub PR Reviews

**GitHub sign-in fails:**
Check that the Authorization callback URL in your GitHub OAuth App matches `https://YOUR-WORKER/github/callback`.

**PR reviews not loading:**
- Verify the Cloudflare Worker is deployed and reachable
- Check the worker domain in `manifest.json` `host_permissions`

## Contributing

| What you want to change | Where to look |
|---|---|
| UI layout or styles | `sidepanel.html` (CSS is embedded in `<style>`) |
| Calendar logic, rendering, RSVP | `sidepanel.js` |
| PR review logic, rendering | `sidepanel.js` (search for `PR` or `github`) |
| Auth flow, token refresh, badge | `background.js` |
| OAuth token exchange, KV storage | `worker/auth-token-exchange.js` |
| Permissions, metadata | `manifest.json` |

## Privacy

All calendar data communicates only with Google APIs (`googleapis.com`). The optional GitHub PR feature communicates with GitHub API (`api.github.com`). OAuth token exchange goes through a Cloudflare Worker that stores refresh tokens server-side — no tokens are shared with any other service. No analytics, no tracking, no third-party data sharing.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## License

MIT
