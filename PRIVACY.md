# Privacy Policy — Google Calendar Side Panel

**Last updated:** March 16, 2026

## What this extension does
Google Calendar Side Panel displays your Google Calendar events in your browser's side panel for quick reference while browsing.

## Data collected
- **Google Calendar data**: Event titles, times, locations, descriptions, attendees, and meeting links are fetched from the Google Calendar API using the `calendar.events` scope. This data is used to display your calendar in the side panel and to update your RSVP responses to events.
- **OAuth access token**: A temporary access token is obtained through Google's OAuth 2.0 flow to authenticate API requests. Tokens expire after approximately 1 hour.
- **User preferences**: Your display preferences (dark mode, compact mode, calendar visibility, calendar collapse state) are stored locally in your browser.

## How data is stored
- All data is stored **locally in your browser** using `chrome.storage.local` and `localStorage`.
- Cached calendar events are stored locally to enable faster loading. Cache is refreshed every 5 minutes.
- **No data is sent to any external server** other than Google's APIs.
- **No analytics, tracking, or telemetry** is collected.

## Data sharing
- This extension does **not** share, sell, or transmit your data to any third party.
- The only external communication is between your browser and Google's Calendar API (`googleapis.com`) and authentication servers (`accounts.google.com`).

## Data retention
- OAuth tokens are automatically cleared after expiry (~1 hour) or when you sign out.
- Cached events are refreshed every 5 minutes and replaced on each fetch.
- All local data is removed when you uninstall the extension.

## Permissions used
| Permission | Purpose |
|---|---|
| `sidePanel` | Display the calendar in the browser's side panel |
| `storage` | Store your preferences and cached events locally |
| `tabs` | Detect page loads to enable the side panel |
| `identity` | Authenticate with Google OAuth |
| `alarms` | Schedule background refresh and token management |

## Your rights
- You can sign out at any time to clear your token.
- You can uninstall the extension to remove all stored data.
- You can revoke access at https://myaccount.google.com/permissions

## Contact
For questions about this privacy policy, contact: daniel.bisgrove@cru.org
