# Google Calendar Side Panel

A Chrome/Brave extension that displays your Google Calendar in the browser's side panel — always visible while you browse. Optionally integrates with GitHub to show PRs awaiting your review.

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
- **Compact mode** — denser layout for smaller screens
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

Once approved, install from the [Chrome Web Store listing](https://chromewebstore.google.com/detail/fefpaminbjodcadohglcnikaklhbjfgb/preview). Click "Add to Chrome", pin the extension, and sign in with Google. That's it.

## Developer Setup (Load Unpacked)

If you want to use the extension right away (without waiting for Web Store approval) or contribute to development, follow these steps.

### Prerequisites

- Chrome, Brave, or Edge browser
- A Google account with Google Calendar
- A [Google Cloud](https://console.cloud.google.com/) account (free)
- *(Optional, for PR reviews)* A [GitHub](https://github.com) account and a [Cloudflare](https://cloudflare.com) account (free tier)

### Step 1: Load the Extension

1. Clone or download this repository
2. Open `chrome://extensions` (or `brave://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Copy your **Extension ID** (the long string under the extension name) — you'll need it later

> **Important:** Never remove and re-add the extension. If you need to update, replace the files and click the **reload** button. Removing it changes the Extension ID and breaks your OAuth configuration.

### Step 2: Set Up Google Calendar API

**A) Create a Google Cloud Project:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "Calendar Panel")
3. Go to [API Library](https://console.cloud.google.com/apis/library) and enable **Google Calendar API**

**B) Configure OAuth Consent Screen:**

1. Go to [Auth Overview](https://console.cloud.google.com/auth/overview)
2. Under **Branding**: set app name, support email, developer contact email
3. Under **Audience**: choose **External**, then add your email as a test user
4. Under **Data Access**: add the `calendar.events` scope

**C) Create OAuth Client:**

1. Go to [Auth Clients](https://console.cloud.google.com/auth/clients)
2. Click **+ Create Client**
3. Application type: **Web application** (not "Chrome Extension" — required for Brave compatibility)
4. Name: `Calendar Panel`
5. Under **Authorized redirect URIs**, add: `https://YOUR_EXTENSION_ID.chromiumapp.org/` (replace with your actual Extension ID, include the trailing `/`)
6. Click **Create** and copy the **Client ID**

**D) Update Extension Config:**

1. Open `background.js` — replace the `CLIENT_ID` value on line 2 with your Client ID
2. Open `manifest.json` — replace the `client_id` value in the `oauth2` section with the same Client ID

> Both files must have the same Client ID.

### Step 3: Set Up GitHub PR Reviews (Optional)

The calendar features work without this step. If you want the PR review tracker:

**A) Create a GitHub OAuth App:**

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name:** `Google Calendar Side Panel`
   - **Homepage URL:** `https://github.com/dr-bizz/Google-Calendar-Chrome-Sidebar`
   - **Authorization callback URL:** `https://YOUR_EXTENSION_ID.chromiumapp.org/` (same Extension ID)
4. Click **Register application**
5. Copy the **Client ID**
6. Click **Generate a new client secret** and copy the **Client Secret**

> **Scope note:** The GitHub integration requests the `repo` scope, which grants read/write access to repositories. This is unfortunately the minimum scope GitHub offers to read PR data on private repos. There is no read-only-PRs scope available. If you only need public repo PRs, the integration works without any scope, but private repos require `repo`.

**B) Deploy the Cloudflare Worker:**

```bash
cd worker
npm install -g wrangler    # if not already installed
wrangler login             # authenticate with Cloudflare
```

Update `worker/wrangler.toml` with your values:
- `GITHUB_CLIENT_ID` — your GitHub OAuth App's Client ID
- `EXTENSION_ID` — your browser extension's ID

Then deploy:

```bash
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET
# paste your GitHub Client Secret when prompted
```

Note the deployed worker URL (e.g., `https://github-token-exchange.your-account.workers.dev`).

**C) Update Extension Config:**

1. Open `background.js`:
   - Set `GITHUB_CLIENT_ID` to your GitHub OAuth App's Client ID
   - Set `GITHUB_WORKER_URL` to your deployed worker URL
2. Open `manifest.json`:
   - Update the worker domain in `host_permissions` to match your worker URL

### Step 4: Reload and Test

1. Go to `chrome://extensions` and click the **reload** button on the extension
2. Click the extension icon to open the side panel
3. Click **Sign in with Google** — complete the OAuth flow
4. *(If GitHub is configured)* Scroll to the bottom and click **Connect GitHub**

### Development

There's no build step — edit files directly and reload:

1. Make changes to the source files
2. Click reload on `chrome://extensions`
3. Reopen the side panel to see changes

## Troubleshooting

### Google Calendar

**"redirect_uri_mismatch" error:**
1. Open the service worker console (`chrome://extensions` → Inspect views: service worker)
2. Click "Sign in" — look for the `[Auth] Redirect URL:` log
3. Copy that exact URL (including trailing `/`)
4. Add it as an Authorized redirect URI in your Google Cloud OAuth client
5. Wait 1-2 minutes for Google to propagate, then retry

**Sign-in hangs or nothing happens:**
- Brave Shields may block the popup — try disabling shields temporarily
- Try the "Enter token manually" fallback option

**Token expired after ~1 hour:**
This is normal for OAuth implicit flow. Click "Sign in with Google" again.

### GitHub PR Reviews

**"GitHub integration not configured" error:**
The placeholder values haven't been replaced. Update `GITHUB_CLIENT_ID` and `GITHUB_WORKER_URL` in `background.js`.

**GitHub sign-in fails:**
Check that the Authorization callback URL in your GitHub OAuth App matches `https://YOUR_EXTENSION_ID.chromiumapp.org/` exactly.

**PR reviews not loading:**
- Verify the Cloudflare Worker is deployed and reachable (visit the URL in a browser — it should return "Method not allowed")
- Check the worker domain in `manifest.json` `host_permissions` matches your deployed URL

## Architecture

### Files

| File | Responsibility |
|------|---------------|
| `background.js` | Service worker: Google + GitHub OAuth, token management, alarms (badge, notifications, PR polling), message handling |
| `sidepanel.js` | UI logic: API calls to Google Calendar + GitHub, rendering, event handling, RSVP, PR cards |
| `sidepanel.html` | Markup and embedded CSS (light/dark themes via CSS variables) |
| `oauth_callback.js/html` | Google OAuth redirect handler |
| `worker/github-token-exchange.js` | Cloudflare Worker: exchanges GitHub OAuth codes for access tokens |

### Authentication

**Google Calendar** — Three strategies for cross-browser compatibility:
1. `launchWebAuthFlow` — primary, works in Chrome and Brave
2. Tab-based auth — fallback that opens auth in a regular tab
3. Manual token entry — last resort for blocked popups

**GitHub** — OAuth via Cloudflare Worker:
1. `launchWebAuthFlow` opens GitHub authorization
2. GitHub redirects back with an authorization code
3. Extension sends the code to the Cloudflare Worker
4. Worker exchanges code + client secret for an access token
5. Token stored locally in `chrome.storage.local`

### Data Flow

- **Calendar:** `background.js` manages auth → `sidepanel.js` fetches events from Google Calendar API → renders timeline, cards, alerts → caches in `chrome.storage.local`
- **GitHub PRs:** `sidepanel.js` fetches from GitHub Search + PR detail APIs → enriches with review history + timeline → renders PR cards → `background.js` handles background polling + notifications + badge

### Storage

- `chrome.storage.local` — tokens, cached events, cached PRs, notification tracking, repo filter
- `localStorage` — UI preferences (dark mode, compact mode, collapse states)

## Contributing

| What you want to change | Where to look |
|---|---|
| UI layout or styles | `sidepanel.html` (CSS is embedded in `<style>`) |
| Calendar logic, rendering, RSVP | `sidepanel.js` |
| PR review logic, rendering | `sidepanel.js` (search for `PR` or `github`) |
| Auth flow, token refresh, badge | `background.js` |
| GitHub token exchange | `worker/github-token-exchange.js` |
| Permissions, metadata | `manifest.json` |

## Privacy

All calendar data communicates only with Google APIs (`googleapis.com`, `accounts.google.com`). The optional GitHub PR feature communicates with GitHub API (`api.github.com`) and a Cloudflare Worker for token exchange. No analytics, no tracking, no third-party data sharing. All cached data stays in your browser's local storage.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## License

MIT
