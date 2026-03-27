# GitHub PR Review Notifications — Design Spec

## Problem

When working heads-down, it's easy to miss GitHub notifications that a PR needs your review. This feature adds a PR review tracker directly into the side panel so pending reviews are always visible alongside your calendar.

## Decisions

| Decision | Choice |
|----------|--------|
| GitHub auth | GitHub OAuth App via Cloudflare Worker token exchange |
| Repo scope | Fetch all repos, user filters in UI |
| Layout | Sidepanel toolbar icon with count + PR section at bottom of side panel + detail slide-out |
| Polling | Smart: 2 min when panel visible, 10 min background, desktop notifications on new requests |
| Re-review handling | Badge + sorted to top + emphasized notifications |
| PR card info | Full context: repo, title, author, time, re-review badge, diff size, labels, reviewer statuses |
| Badge behavior | PR count (purple) shown when no meeting within 30 min |

---

## 1. GitHub OAuth Flow

### Registration

- Create a GitHub OAuth App at `github.com/settings/developers`
- Authorization callback URL: `https://<EXTENSION_ID>.chromiumapp.org/`
- Client ID stored in `background.js` as `GITHUB_CLIENT_ID`
- Client Secret stored as a Cloudflare Worker environment secret (never in the extension)

### OAuth Scope

Use `scope=repo`. This grants read/write access to repositories, which is broader than strictly needed (we only read PR metadata). However, `repo` scope is required to see review requests on **private repositories** — without it, the Search API only returns results from public repos. There is no narrower scope that grants read-only access to private PR data with GitHub OAuth Apps.

**Note:** GitHub Apps (not OAuth Apps) support fine-grained permissions (e.g., read-only pull requests), but they require a different auth flow (installation-based, not user-based) and are significantly more complex to set up. If scope concerns become a blocker for Chrome Web Store review, migrating to a GitHub App is the fallback.

### Flow

1. User clicks "Connect GitHub" in the PR section
2. Extension generates a random `state` parameter (e.g., `crypto.randomUUID()`) and stores it temporarily
3. Extension calls `chrome.identity.launchWebAuthFlow` → `github.com/login/oauth/authorize` with `scope=repo`, `state=<random>`, and `redirect_uri=<chromiumapp.org>`
4. GitHub redirects back with `?code=XXXX&state=<random>`
5. Extension verifies the `state` parameter matches the stored value (CSRF protection)
6. Extension sends the code from `background.js` (service worker) to `https://<your-worker>.workers.dev/github/token`
7. Cloudflare Worker exchanges code + client secret with GitHub → receives access token
8. Worker returns token to extension
9. Extension stores `githubToken` + `githubTokenTime` in `chrome.storage.local`

### Token Lifecycle

- GitHub OAuth tokens don't expire unless revoked
- Validate token by calling `GET /user` once per session (on panel load) and once every 30 minutes thereafter — not on every poll cycle
- On 401 from any GitHub API call (including search): clear token, show "Reconnect GitHub" prompt
- Sign out clears GitHub token independently from Google token

### Cloudflare Worker

Single endpoint: `POST /github/token`

- Accepts `{ code }` in request body
- Calls `https://github.com/login/oauth/access_token` with code + client_id + client_secret
- Returns `{ access_token }` to the extension
- The token exchange call is made from `background.js` (service worker context), which is not subject to CORS restrictions. The worker does not need CORS headers for this use case, but should include them as a safety net for future flexibility (`Access-Control-Allow-Origin: *` is acceptable since the endpoint requires a valid one-time code)
- Client secret stored as a Worker secret via `wrangler secret put`
- ~30 lines of code, deployed to Cloudflare Workers free tier

---

## 2. GitHub API Integration

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /user` | Validate token, get authenticated username |
| `GET /search/issues?q=type:pr+review-requested:{username}+is:open` | Find all open PRs requesting your review |
| `GET /repos/{owner}/{repo}/pulls/{number}` | Full PR details (changed files, labels, reviewers) |
| `GET /repos/{owner}/{repo}/pulls/{number}/reviews` | Review history (for re-review detection) |
| `GET /repos/{owner}/{repo}/issues/{number}/timeline` | Review request events with timestamps (for `reviewRequestedAt`) |

### Known Limitation: Team-based Review Requests

The `review-requested:{username}` search qualifier only matches PRs where the user is directly requested. It does **not** match PRs where a team the user belongs to is requested. Many organizations use team-based review requests. This is a known limitation for v1. A future enhancement could fetch the user's teams via `GET /user/teams` and add `team-review-requested:{team}` queries, at the cost of additional API calls.

### Data Model

Per PR stored in cache:

```
{
  id,
  repo,                    // "owner/name"
  title,
  body,                    // PR description (full text, truncated to 200 chars for display)
  author: { login, avatarUrl },
  reviewRequestedAt,       // ISO timestamp — from Timeline API review_requested event
  url,                     // API URL
  htmlUrl,                 // Browser URL
  changedFiles,            // number
  additions,               // number
  deletions,               // number
  labels: [{ name, color }],
  reviewers: [{ login, state }],  // PENDING, APPROVED, CHANGES_REQUESTED
  isReReview,              // boolean — true if user previously submitted a review
  number
}
```

### `reviewRequestedAt` Source

The exact timestamp of the review request comes from the Timeline API (`GET /repos/{owner}/{repo}/issues/{number}/timeline`). Look for the most recent `review_requested` event where `requested_reviewer.login` matches the authenticated user. If the Timeline API call fails or returns no matching event, fall back to the PR's `updated_at` timestamp (approximate).

### Re-review Detection

A PR is a re-review if the authenticated user has previously submitted a review (any state: APPROVED, CHANGES_REQUESTED, or COMMENTED) on that PR, and they are currently listed as a requested reviewer again. Determined by checking `GET /repos/{owner}/{repo}/pulls/{number}/reviews` for any review by the authenticated user.

### Fetching Strategy

- Initial load: search query → list of PRs → parallel enrichment (details + review history + timeline) with concurrency limit of 5
- If any enrichment call fails, the PR uses its previously cached data (if available) or is shown with partial information (title/repo from search results, enrichment fields blank). Failed enrichment does not block rendering of other PRs.
- Results cached in `chrome.storage.local` as `cachedPRs` + `prCacheTime`
- Cache staleness threshold: 30 minutes (matches calendar cache)

### Rate Limits

- GitHub authenticated API: 5,000 requests/hour
- Search API: 30 requests/minute
- Worst case at 2-min polling with 10 PRs to enrich: 30 polls/hour × (1 search + 10 detail + 10 reviews + 10 timeline) = **930 requests/hour** + 2 `/user` calls/hour = **932 requests/hour** — within the 5,000/hour limit. Search API usage is 0.5 requests/minute — within the 30/minute limit.
- If the Search API returns 403 with a `Retry-After` header, respect it by delaying the next poll. Log a warning but do not surface an error to the user unless consecutive failures exceed 3.
- Background-only polling (panel closed, 10-min interval): 6 polls/hour × 1 search = 6 requests/hour (enrichment skipped, uses cached details)

---

## 3. Smart Polling

### When Panel is Visible

- Poll every 2 minutes via `setInterval` in `sidepanel.js`
- Interval created when panel loads and GitHub token exists
- Cleared on disconnect or panel unload

### Background Polling

- New alarm in `background.js`: `checkPRs` with `periodInMinutes: 10`
- Created in `chrome.runtime.onInstalled` alongside existing alarms
- Reads `githubToken` from storage, calls search API, updates `cachedPRs`
- Compares new results against previous cache to detect new review requests
- **Background polling does lightweight search-only fetches** (no enrichment) — used for new request detection and badge count. Full enrichment happens when the sidepanel polls.

### Deduplication

- Before fetching, check `prCacheTime` in `chrome.storage.local`
- If the cache was updated less than 90 seconds ago (by either sidepanel or background), skip the poll
- This prevents the background alarm and sidepanel interval from doubling up when both are active

### New Request Detection

- On each poll, compare new PR IDs against previous cached PR IDs
- Any PR ID present in new results but absent from previous cache = new review request
- Trigger desktop notification for each new request
- Also detect re-review transitions: PR was in cache as `isReReview: false`, now `isReReview: true`

---

## 4. UI — PR Section

### Placement

- Below `weekStatsContainer`, above the sign-out button in `sidepanel.html`
- New container: `<div id="prReviewContainer"></div>`

### Section Header

- "PR Reviews" label with count badge: "PR Reviews (3)"
- Collapsible (click header to toggle), same pattern as day summary
- Collapse state persisted in `localStorage` via `calPrefs`
- Auto-expanded when PRs exist, collapsed when empty
- Small gear icon for GitHub settings (filter, disconnect)

### PR Card Layout

Each card displays:

- **Left column:** Author avatar (24px circle)
- **Line 1:** PR title (ellipsis truncated) + orange "Re-review" badge if applicable
- **Line 2:** `owner/repo#123` in secondary text color
- **Line 3:** Relative time ("2h ago") + diff stats (`+42 -18 · 5 files`)
- **Line 4:** Label pills (colored) + reviewer status dots (green=approved, red=changes requested, gray=pending)

Click → opens PR detail slide-out.

### Sort Order

1. Re-reviews first (newest requested time first)
2. First-time reviews (newest requested time first)

### PR Detail Slide-out

- Mirrors `eventDetailScreen` — slides in from right, back button returns to calendar
- Content:
  - Full title
  - Description preview (first 200 characters of `body`)
  - Author with avatar
  - All labels
  - Complete reviewer list with statuses
  - Diff stats (files, additions, deletions)
  - Requested time (absolute)
  - Repo name + PR number
- Action buttons:
  - "Open in GitHub" → opens `htmlUrl` in new tab
  - "Open Diff" → opens `htmlUrl/files` in new tab

### Sidepanel Toolbar Icon

- New button in the sidepanel's `.toolbar-actions` div (not the Chrome browser toolbar): Git PR icon (branching/merge icon)
- Count badge overlay (small circle with number, purple `#8e24aa` / dark `#ce93d8`)
- Click scrolls to PR section and expands if collapsed
- Hidden until GitHub is connected

### Loading, Error, and Empty States

- **Loading:** Skeleton shimmer cards (same pattern as calendar loading screen) — 2 skeleton PR cards shown while initial fetch is in progress
- **Error:** Inline error banner in the PR section: "Couldn't load PR reviews. [Retry]" — styled like the existing `.error-box` but inline
- **Empty:** "No PRs awaiting your review" message with a subtle icon, styled like the existing `.empty-state` class
- **Disconnected:** Inline connect prompt (see Section 6)

### Dark Mode

All new UI elements must support both light and dark themes using existing CSS custom properties (`var(--surface)`, `var(--border)`, `var(--text)`, etc.). The re-review badge uses the same orange `#e37400` / dark `#f6bf26` as existing needs-response indicators. PR cards follow the same styling pattern as `.event-card`. Status dots and label pills use their own colors but with dark-mode-appropriate backgrounds.

---

## 5. Notifications & Badge

### Desktop Notifications

- Triggered when polling detects a new PR not in previous cache
- First-time review:
  - Title: `owner/repo #123`
  - Message: `Review requested: <PR title>`
  - `priority: 1`
- Re-review:
  - Title: `owner/repo #123`
  - Message: `Re-review requested: <PR title>`
  - `priority: 2`
  - `requireInteraction: true`
- Click notification → `chrome.tabs.create({ url: htmlUrl })`
- Tracked in `chrome.storage.local` as `notifiedPRKeys` (Set of PR IDs)
- Cleanup runs on each poll cycle: any PR ID in `notifiedPRKeys` that is absent from the latest poll results is removed

### Notification ID Convention

PR notification IDs are prefixed with `pr::` (e.g., `pr::123456`). Calendar event notification IDs use the existing `eventId::startMs` format. This prefix is used for routing in three places:

**Click handlers** (`chrome.notifications.onClicked` and `onButtonClicked`):
- IDs starting with `pr::` → open the PR's `htmlUrl`
- All other IDs → existing calendar event handler (`findEventFromNotification`)

**Auto-dismiss logic** (existing code in `checkNotifications` alarm handler, lines 160-168 of `background.js`): The existing auto-dismiss loop parses notification IDs by splitting on `::` and treating the last segment as an epoch timestamp. PR notification IDs (`pr::123456`) would be misinterpreted, causing immediate dismissal. **The auto-dismiss loop must be updated to skip notification IDs starting with `pr::`** (or more precisely, only process IDs matching the calendar `eventId::startMs` pattern). PR notifications are dismissed only when the PR is no longer requesting the user's review (handled by `notifiedPRKeys` cleanup).

### Extension Badge

Updated priority chain in `updateBadge` alarm handler:

1. **`NOW`** (red `#FF0000`) — meeting happening now
2. **`Xm`** (blue `#0000FF`) — meeting within 30 minutes
3. **`X`** (purple `#8e24aa`) — PR review count (when count > 0)
4. **Empty** — nothing needs attention

Reads both `cachedEvents` and `cachedPRs` from storage. PR count for the badge respects the repo filter (see Section 6 — filter is stored in `chrome.storage.local` so background script can access it).

---

## 6. GitHub Connection UX

### Connect Prompt

When GitHub is not connected, the PR section shows an inline prompt:

- Icon + "Connect GitHub to see PRs awaiting your review"
- "Connect GitHub" button (primary style)
- Same visual language as the auth screen but smaller/inline

### Post-connection

- Toast notification: "Connected as @username"
- PR section immediately fetches and renders

### Settings (gear icon)

Clicking the gear in the PR section header shows:

- Connected GitHub username
- "Disconnect GitHub" button
- Repo filter: checkbox list of `owner/repo` with "Select All / None" (same pattern as calendar filter)
- Filter state saved in `chrome.storage.local` as `enabledPRRepos` (in `chrome.storage.local`, not `localStorage`, so the background script can read it for accurate badge counts and notification filtering)
- Filtered PRs hidden from list, excluded from badge count and notifications

### Sign-out Behavior

- Existing "Sign out" button → Google only (unchanged)
- GitHub disconnect via gear icon in PR section
- Each auth is independent

---

## 7. File Changes

### Modified Files

**`manifest.json`**
- Add `https://api.github.com/*` to `host_permissions`
- Add `https://<your-worker>.workers.dev/*` to `host_permissions` (for Cloudflare Worker token exchange)

**`background.js`**
- Add `GITHUB_CLIENT_ID` and `GITHUB_WORKER_URL` constants
- Add `authViaGitHub()` — `launchWebAuthFlow` + worker token exchange
- Add message handlers: `startGitHubAuth`, `getGitHubToken`, `disconnectGitHub`, `cachePRs`, `getCachedPRs`
- Add `checkPRs` alarm (10 min) in `onInstalled`
- Add PR polling logic in alarm handler (lightweight search-only)
- Add PR notification logic (new requests, re-reviews) with `pr::` prefixed notification IDs
- Update `chrome.notifications.onClicked` and `onButtonClicked` to route based on `pr::` prefix
- Update `checkNotifications` auto-dismiss loop to skip `pr::` prefixed notification IDs
- Update `updateBadge` handler to include PR count fallback (purple badge)

**`sidepanel.js`**
- Add state: `githubToken`, `prReviews`, `enabledPRRepos`, `prSectionCollapsed`
- Add `fetchPRReviews()` — search API + parallel enrichment (details + reviews + timeline)
- Add `renderPRSection()` — section with header, cards, connect prompt, loading/error/empty states
- Add `renderPRCards()` — individual PR card rendering
- Add `openPRDetail(prId)` — slide-out detail view
- Add `renderPRFilter()` — repo filter checkboxes
- Add GitHub connection management (connect, disconnect, token polling)
- Add 2-min PR polling interval when panel visible (with deduplication check)
- Add PR cache read/write via background messages
- Update `loadPrefs()` / `savePrefs()` for PR-related preferences (collapse state in `localStorage`, filter in `chrome.storage.local`)

**`sidepanel.html`**
- Add PR section container: `<div id="prReviewContainer"></div>` below `weekStatsContainer`
- Add PR detail slide-out screen (mirrors `eventDetailScreen` structure)
- Add sidepanel toolbar PR icon button with badge
- Add GitHub connect inline prompt markup
- Add GitHub settings mini-panel markup
- Add all associated CSS (PR cards, re-review badges, detail slide-out, purple badge, filter panel, loading/error/empty states) with light and dark theme support

### New File

**`worker/github-token-exchange.js`**
- Cloudflare Worker: `POST /github/token` endpoint
- Exchanges authorization code for access token
- CORS headers included as safety net
- ~30 lines, deployed separately to Cloudflare

---

## 8. Setup Instructions (for developers)

1. Create a GitHub OAuth App at `github.com/settings/developers`
   - Application name: "Google Calendar Side Panel"
   - Homepage URL: your extension's Chrome Web Store URL (or placeholder)
   - Authorization callback URL: `https://<EXTENSION_ID>.chromiumapp.org/`
2. Note the Client ID and Client Secret
3. Deploy the Cloudflare Worker:
   - `cd worker && npx wrangler deploy`
   - `npx wrangler secret put GITHUB_CLIENT_SECRET` (paste the secret)
4. Update `background.js`:
   - Set `GITHUB_CLIENT_ID` to your OAuth App's client ID
   - Set `GITHUB_WORKER_URL` to your deployed worker URL
5. Update `manifest.json`:
   - Add your worker domain to `host_permissions`
6. Reload the extension
7. Click "Connect GitHub" in the PR Reviews section
