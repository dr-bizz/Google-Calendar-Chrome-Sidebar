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

## Install

### From the Chrome Web Store

> **Note:** Google OAuth is currently approved for Cru organization accounts. External access is pending Google's verification review. If you're outside Cru, see [Developer Setup](#developer-setup) below to run your own instance.

1. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/fefpaminbjodcadohglcnikaklhbjfgb)
2. Pin the extension to your toolbar (click the puzzle icon, then the pin)
3. Click the extension icon to open the side panel
4. Click **Sign in with Google** — a tab opens for Google sign-in
5. Approve the calendar permissions and the tab closes automatically
6. Your calendar events appear in the side panel

To connect GitHub PR reviews, scroll to the bottom of the side panel and click **Connect GitHub**.

No configuration, no API keys, no setup required.

## Troubleshooting

**Sign-in opens a tab but nothing happens:**
- Make sure you're using a Cru organization Google account (external access is pending approval)
- Try closing the tab and clicking "Sign in" again

**"No refresh token received" error:**
- Go to [Google Account Permissions](https://myaccount.google.com/permissions), revoke access to "Google Calendar Side Panel", and try signing in again

**Session expired:**
The extension automatically refreshes tokens every 55 minutes. If you see a re-auth prompt, your session may have expired (90-day limit). Click "Sign in" again.

**GitHub sign-in fails:**
- Make sure you approve the permissions on the GitHub consent screen
- Try disconnecting and reconnecting from the PR section

**PR reviews not loading:**
- Check your internet connection
- Try clicking the refresh button in the toolbar

## Privacy

Your calendar data goes directly from your browser to Google's servers — it never passes through any third-party server. The only server involved is a Cloudflare Worker that handles OAuth token exchange (signing you in). Refresh tokens are stored server-side on Cloudflare; your browser only holds an opaque session token. No analytics, no tracking, no data sharing.

The optional GitHub integration communicates directly with GitHub's API from your browser.

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## Developer Setup

If you want to contribute to this project or run your own instance (e.g., you're outside the Cru organization), you'll need to set up your own Cloudflare Worker and Google Cloud project.

### Prerequisites

- Chrome, Brave, or Edge browser
- [Node.js](https://nodejs.org) installed
- A [Google Cloud](https://console.cloud.google.com/) account (free)
- A [Cloudflare](https://cloudflare.com) account (free tier)
- *(Optional)* A [GitHub](https://github.com) account for PR review integration

### Step 1: Load the Extension

1. Clone this repository
2. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder

> **Tip:** Never remove and re-add the extension — it changes the Extension ID. Use the **reload** button instead.

### Step 2: Set Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable the **Google Calendar API** in the [API Library](https://console.cloud.google.com/apis/library)
3. Configure the [OAuth consent screen](https://console.cloud.google.com/auth/overview):
   - Set to **External**
   - Add your email as a test user
   - Add the `calendar.events` and `calendar.readonly` scopes
4. Create an [OAuth client](https://console.cloud.google.com/auth/clients) → **Web application**
5. Under **Authorized redirect URIs**, add: `https://YOUR-WORKER.YOUR-ACCOUNT.workers.dev/google/callback`
6. Copy the **Client ID** and **Client Secret**

### Step 3: Set Up GitHub OAuth (Optional)

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → **New OAuth App**
2. Set **Authorization callback URL** to: `https://YOUR-WORKER.YOUR-ACCOUNT.workers.dev/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**

### Step 4: Deploy the Worker

```bash
cd worker
npm install -g wrangler       # if not already installed
wrangler login                # authenticate with Cloudflare
wrangler kv namespace create "AUTH_TOKENS"
```

Update `worker/wrangler.toml` with the KV namespace `id` from the output above.

Deploy and set secrets:

```bash
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID      # optional
npx wrangler secret put GITHUB_CLIENT_SECRET   # optional
```

### Step 5: Update Extension Config

1. Open `background.js` — update `WORKER_URL` on line 2 to your deployed worker URL
2. Open `manifest.json` — update the worker domain in `host_permissions`

### Step 6: Reload and Test

1. Go to `chrome://extensions` and click **reload**
2. Open the side panel and click **Sign in with Google**
3. *(If GitHub configured)* Click **Connect GitHub**

### Development Workflow

No build step — edit files directly and reload:

1. Make changes to the source files
2. Click reload on `chrome://extensions`
3. Reopen the side panel to see changes

## Architecture

### Files

| File | Responsibility |
|------|---------------|
| `background.js` | Service worker: OAuth coordination via tab URL interception, token lifecycle, alarms (badge, notifications, PR polling), message handling |
| `sidepanel.js` | UI logic: Google Calendar + GitHub API calls, rendering, event handling, RSVP, PR cards |
| `sidepanel.html` | Markup and embedded CSS (light/dark themes via CSS variables) |
| `worker/auth-token-exchange.js` | Cloudflare Worker: OAuth flows for both Google and GitHub, KV token storage, session management |

### Authentication

Both Google and GitHub use the same pattern — a Cloudflare Worker owns the OAuth redirect URI:

1. Extension opens a tab to `{worker}/google/auth` (or `/github/auth`)
2. Worker redirects to the provider's consent screen
3. Provider redirects back to the worker with an authorization code
4. Worker exchanges code + client secret for tokens
5. Worker stores sensitive tokens (refresh/access) in Cloudflare KV (90-day TTL)
6. Worker redirects to its own `/auth/complete` page with an opaque session token
7. Extension detects the `/auth/complete` URL via `chrome.tabs.onUpdated`, extracts the session token, and closes the tab

This means:
- **Client secrets never leave the worker** — they're Cloudflare secrets
- **Refresh tokens stay server-side** — only the worker can use them
- **Works for all users** — the redirect URI is the worker URL, not per-extension
- **No browser-specific APIs** — works identically in Chrome, Brave, and Edge
- **Survives service worker restarts** — top-level tab listener re-registers automatically

### Storage

- `chrome.storage.local` — session tokens, cached access tokens, cached events/PRs, notification tracking, repo filter
- `localStorage` — UI preferences (dark mode, collapse states, calendar filter)

## Contributing

| What you want to change | Where to look |
|---|---|
| UI layout or styles | `sidepanel.html` (CSS is embedded in `<style>`) |
| Calendar logic, rendering, RSVP | `sidepanel.js` |
| PR review logic, rendering | `sidepanel.js` (search for `PR` or `github`) |
| Auth flow, token refresh, badge | `background.js` |
| OAuth token exchange, KV storage | `worker/auth-token-exchange.js` |
| Permissions, metadata | `manifest.json` |

## License

MIT
