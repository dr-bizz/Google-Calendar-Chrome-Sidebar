# Google Calendar Side Panel

A Chrome/Brave extension that displays your Google Calendar in the browser's side panel — always visible while you browse.

## Features

- **Side panel calendar** — view your agenda without switching tabs
- **Mini calendar** — month view with event indicators, click any date to filter
- **Timeline view** — visual daily schedule with hour blocks, overlapping event columns, and a live "now" line
- **Meeting alerts** — full-screen green/blue animated overlay when a meeting is about to start, with a "Join Call" button
- **Event detail view** — click any event to see full details: description, guests, attachments, organizer, and meeting link
- **RSVP from the sidebar** — accept, decline, or maybe directly from the event detail screen
- **Needs response indicators** — unresponded events are visually distinct with dashed borders and striped backgrounds; tentative/maybe events shown with reduced opacity
- **Next meeting card** — countdown timer with urgency colors
- **Day summary** — at-a-glance stats for meetings, free time, and focus blocks
- **Multi-calendar support** — filter which calendars to show
- **Dark mode** — follows system preference or toggle manually
- **Compact mode** — denser layout for smaller screens
- **Badge notifications** — extension badge shows minutes until next meeting
- **Offline caching** — cached events for instant loading on reopen

## Project Structure

```
google-calendar-sidepanel/
  manifest.json          # Extension manifest (Manifest V3)
  background.js          # Service worker: auth strategies, token management, alarms, badge updates
  sidepanel.html         # Side panel UI: markup and all CSS styles
  sidepanel.js           # Side panel logic: API calls, rendering, event handling, RSVP
  oauth_callback.html    # OAuth redirect handler page
  oauth_callback.js      # Extracts token from OAuth redirect URL
  icons/                 # Extension icons (16, 48, 128px)
  SETUP.md               # Step-by-step setup guide for new developers
  PRIVACY.md             # Privacy policy for Chrome Web Store
```

## Architecture

### Authentication
The extension supports multiple OAuth strategies to work across Chrome and Brave:
1. **`launchWebAuthFlow`** — primary method, works in both browsers with a "Web application" OAuth client
2. **Tab-based auth** — fallback that opens auth in a regular tab and intercepts the redirect
3. **Manual token entry** — last resort for environments where popups are blocked

Tokens are stored in `chrome.storage.local` and automatically refreshed via alarms before expiry.

### API Scopes
- `calendar.events` — read events and update RSVP responses
- `calendar.readonly` — list available calendars

### Data Flow
1. `background.js` handles auth and token lifecycle
2. `sidepanel.js` fetches events from all enabled calendars, merges and sorts them
3. Events are rendered into timeline, event cards, and next meeting widgets
4. RSVP updates are sent via `PATCH` to the Calendar API and reflected locally immediately
5. Events are cached in `chrome.storage.local` for badge updates and fast reloads

## Getting Started

### Prerequisites
- A Google Cloud project with the **Google Calendar API** enabled
- An OAuth 2.0 client configured with the correct redirect URI

### Setup
See [SETUP.md](SETUP.md) for detailed step-by-step instructions.

**Quick version:**
1. Load the extension unpacked in `chrome://extensions` (developer mode)
2. Copy your Extension ID
3. Create a Google Cloud project, enable Calendar API, set up OAuth
4. Add `https://YOUR_EXTENSION_ID.chromiumapp.org/` as an authorized redirect URI
5. Update the `CLIENT_ID` in `background.js` and `manifest.json`
6. Reload the extension and sign in

### Development
There's no build step — edit the files directly and reload the extension:
1. Make your changes to the source files
2. Go to `chrome://extensions`
3. Click the reload button on the extension
4. Reopen the side panel to see changes

### Publishing
A GitHub Action is available for automated publishing to the Chrome Web Store. See `.github/workflows/publish.yml` (requires Chrome Web Store API credentials as repository secrets).

## Key Files for Contributors

| What you want to change | Where to look |
|---|---|
| UI layout or styles | `sidepanel.html` (CSS is embedded in `<style>`) |
| Calendar logic, rendering, RSVP | `sidepanel.js` |
| Auth flow, token refresh, badge | `background.js` |
| Permissions, metadata | `manifest.json` |

## Privacy

All data stays local in your browser. No external servers, no analytics, no tracking. See [PRIVACY.md](PRIVACY.md) for the full policy.

## License

MIT
