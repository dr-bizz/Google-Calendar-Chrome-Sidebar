<!--
USAGE: /pr-review

You can also specify if the review is for a Senior or an Experienced engineer.
/pr-review senior
/pr-review experienced

-->

## Stage 0 — Confirm Developer Experience Level

**STOP HERE FIRST**

**IF $ARGUMENTS is empty or not "senior" or "experienced":**

**YOU MUST** ask this question and **WAIT FOR USER RESPONSE** before proceeding to any other stages.

**DO NOT** start Stage 1, git commands, or any review work until answered.

Ask exactly:

"What experience level should I tailor this review for?

- **Senior**: Concise feedback, focus on architecture/performance
- **Experienced**: Detailed explanations with mentoring notes"

**WAIT FOR ANSWER. DO NOT CONTINUE WITHOUT RESPONSE.**

**IF $ARGUMENTS is "senior" or "experienced":** Proceed directly to Stage 1 using that level.

---

Dev experience level: $ARGUMENTS

Before the review, print exactly: Operating in review-only mode (with .ai-review.json exception).

MODE

- REVIEW ONLY of the current PR diff; do NOT modify existing files or stage/commit.
- Single exception: you MAY create ONE untracked file at repo root: `.ai-review.json`. Do not modify other files; do not stage/commit.

---

=== Stage 1 — Setup Knowledge ===

First, read these files to understand project conventions:
- `CLAUDE.md` — architecture, coding standards, behavior instructions

Then use **concrete** search commands to build context for reuse analysis. Run these in parallel where possible:

```bash
# Understand existing patterns in areas relevant to the PR
cat manifest.json                  # Extension manifest and permissions
ls icons/                          # Extension icons
ls .claude/commands/               # AI review/command definitions
```

Additionally, based on what the PR touches:
- If PR touches background.js: Read it fully to understand service worker patterns, auth flow, alarm setup, and notification logic
- If PR touches sidepanel.js: Read it fully to understand API calls, rendering, event handling, and RSVP logic
- If PR touches sidepanel.html: Read it fully to understand markup structure and embedded CSS
- If PR touches OAuth files: Read `oauth_callback.html` and `oauth_callback.js` for auth redirect handling
- If PR touches manifest.json: Read it fully to understand permissions, CSP, and extension configuration

Note common patterns for later reuse identification in Stages 4-5.

**Repo heuristics to enforce:**

_Architecture:_
- Service worker (background.js) handles auth, token management, alarms, badge updates, and notifications
- Side panel (sidepanel.js) handles UI logic, API calls, rendering, and event handling
- Message passing between background and sidepanel uses `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`
- Background script must not reference DOM — it runs in a service worker context

_API:_
- Google Calendar API calls require valid OAuth 2.0 access tokens
- Token is obtained via implicit OAuth flow and stored in `chrome.storage.local`
- API error responses (401, 403, etc.) must be handled gracefully with token refresh or re-auth
- All fetch calls to Google Calendar API must include `Authorization: Bearer <token>` header

_Data integrity:_
- Token lifecycle: tokens expire and must be refreshed or re-obtained before API calls
- Event data cached in `chrome.storage.local` must be kept consistent with API responses
- `chrome.storage` operations are async and may race — use callbacks or await properly
- Cross-tab state sync via `chrome.storage.onChanged` listener where applicable

_Testing:_
- No `console.log` statements left in production code (use conditional debug logging if needed)
- No `debugger` statements
- No hardcoded OAuth client secrets in source files
- Code should be linted for clean JS (no unused variables, no unreachable code)

_Code quality:_
- Vanilla JavaScript — no frameworks or build tools
- Clean, readable functions with clear responsibility
- Proper error handling with try/catch around async operations
- Constants and configuration values should not be hardcoded inline

---

=== Stage 2 — File Index (completeness gate) ===

**IMPORTANT**: Before running ANY git commands, you MUST print this exact message:
"NOTE: The following git commands are read-only operations that will not modify your codebase.
They're being run to determine what code has changed so that the code review can apply to the changes"

**Step 1: Get the diff**

- `git branch --show-current` - Get current branch name
- `gh pr view --json baseRefName --jq '.baseRefName'` - Get the PR's actual base branch (may not be `main` for stacked PRs)
- `gh pr diff` - Get the actual diff as GitHub sees it (use this for file list, diff content, and position calculation — NOT `git diff`)
- `gh pr diff | grep '^diff --git' | sed 's|diff --git a/||;s| b/.*||'` - Get files changed in the PR

**IMPORTANT**: Always use `gh pr diff` instead of `git diff main...HEAD`. The PR may target a feature branch, not `main`. Using `git diff main...HEAD` would include changes from the parent branch that are NOT part of this PR.

**Step 2: File inventory**

List EVERY file changed in this PR (relative path). For each file, include:

- Kind: {manifest | service-worker | ui-markup | ui-logic | auth | icon | config | doc | other}
- Risk: {low | med | high}
- Why (1 sentence)

Do not skip any file. If any file can't be read, state it and continue.

---

=== Stage 3 — PR Risk Assessment ===

Analyze the PR changes and display a risk assessment report.

**Step 1: Calculate Risk Score**

Start with a base score of 0, then add points:

**Critical File Patterns (+3 points each):**
- `manifest.json` — Extension manifest (permissions, CSP, API declarations)
- `background.js` (auth/token sections) — OAuth token management, credential handling
- `oauth_callback.html` / `oauth_callback.js` — OAuth redirect handler
- `.claude/commands/*.md` — Review process definitions (controls how AI reviews behave)

**High-Risk File Patterns (+2 points each):**
- `sidepanel.js` — Core UI logic, API interactions, event handling, RSVP
- `sidepanel.html` — UI markup and embedded CSS
- `background.js` (non-auth sections) — Alarms, badge updates, notifications, message passing

**Medium-Risk File Patterns (+1 point each):**
- `icons/*` — Extension icons (visual identity)
- `CLAUDE.md` — AI behavior instructions
- `SETUP.md` — Setup documentation

**Low-Risk Files (0 points):**
- `*.md` (not `.claude/commands/*.md` or `CLAUDE.md`) — General documentation
- `LICENSE`, `.gitignore` — Standard repo files

**Change Volume Modifier:**
- <50 lines total: +0
- 50-200 lines: +1
- 200-500 lines: +2
- 500+ lines: +3

**Scope Multiplier** (apply after base score):
- Single domain (e.g., only icons, or only docs): x1.0
- Multiple domains (e.g., manifest + sidepanel + background): x1.3
- Cross-cutting (e.g., auth flow + manifest permissions + UI + background): x1.7

**Special Pattern Detection (additional points):**
- New permission added to `manifest.json`: +2
- OAuth scope changes: +3
- New Chrome API usage (e.g., `chrome.alarms`, `chrome.notifications`): +1
- New `content_security_policy` in manifest: +2
- Changes to `.claude/commands/*.md`: +2

Cap the final score at 10.

**Risk Level Mapping (from final score):**
- **0-3**: LOW
- **4-6**: MEDIUM
- **7-8**: HIGH
- **9-10**: CRITICAL

**Step 2: Determine Day of Week**
```bash
date +%A
```

**Step 3: Determine Reviewer Level**

Monday-Thursday:
- Score 1-3: Any team member can review
- Score 4-6: Mid-level recommended, senior optional
- Score 7-8: Senior recommended
- Score 9-10: Senior required

Friday:
- Score 1-3: Any team member, but suggest waiting until Monday to merge
- Score 4-6: Senior recommended for Friday merge
- Score 7-10: Senior required, strongly suggest waiting until Monday

Saturday/Sunday:
- All scores: Treat as Friday + add weekend deployment warning

**Step 4: Display Risk Report**

Print this report before the deep review:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 PR RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Risk Score: [X]/10
Risk Level: [LOW | MEDIUM | HIGH | CRITICAL]

Files Changed: [N]
Lines Changed: +[X] -[Y]

Risk Factors Detected:
• [e.g., "Extension manifest (manifest.json): +3"]
• [e.g., "OAuth handler (oauth_callback.js): +3"]
• [e.g., "Large changeset (350+ lines): +2"]
• [e.g., "Cross-cutting scope: x1.3"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 REVIEW RECOMMENDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Required Reviewer Level: [ANY | MID-LEVEL/SENIOR | SENIOR]

Reasoning: [1-2 sentence explanation]

[IF FRIDAY AND SCORE >= 4]
⚠️  FRIDAY DEPLOYMENT NOTICE
Consider waiting until Monday for safer publish window.

[IF FRIDAY AND SCORE >= 7]
⚠️  HIGH-RISK FRIDAY DEPLOYMENT WARNING
Senior review required. Strongly consider waiting until Monday.
If urgent, ensure monitoring plan is in place (Chrome Web Store reviews + error tracking).

[IF WEEKEND]
⚠️  WEEKEND DEPLOYMENT WARNING
Consider waiting until Monday unless this is an urgent hotfix.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

=== Stage 4 — Deep Review (file-by-file) ===

IMPORTANT: Only review files that appear in the git diff from Stage 2. Do not review files that are not part of this PR.

**Issue Severity Guidelines:**
- **Must-fix**: Bugs, security issues, breaking changes, performance problems, data integrity risks
- **Nice-to-have**: Style improvements, minor refactoring, following precedent patterns, better naming

For EACH changed file from Stage 2, review using the checklists below. Then document:

- Must-fix: file:line → issue → fix (unified diff if trivial)
    - Evidence (file:line-range quote)
    - Impact (correctness/perf/clarity)
- Nice-to-have (same format)
- Suggested tests (anchor to this file's code)
- Inline mentoring notes (only for Dev experience level: experienced)
- Quick patches (tiny unified diffs only; do not apply)

RULE: If no issues found for a file, state: "No issues found after deep check" AND explain the checks you ran.

**Review Checklists by File Type:**

_Manifest (manifest.json):_
- Valid Manifest V3 structure (manifest_version: 3)
- Permissions are minimal — only request what is actually used
- `host_permissions` are scoped correctly (not overly broad)
- `content_security_policy` is present and restrictive (no `unsafe-eval`, no `unsafe-inline` unless justified)
- `oauth2` section has correct `client_id` and `scopes`
- `side_panel` and `action` configuration are correct
- Icons reference valid files at correct sizes (16, 48, 128)
- No deprecated Manifest V2 fields present

_Service Worker (background.js):_
- No DOM access (service worker context has no `document` or `window`)
- `chrome.runtime.onInstalled` listener sets up initial state correctly
- `chrome.alarms` used instead of `setTimeout`/`setInterval` (service workers can be terminated)
- Token management: tokens stored securely in `chrome.storage.local`, not in global variables
- Token refresh logic handles expiry and 401 responses correctly
- `chrome.identity.launchWebAuthFlow` or equivalent used correctly for OAuth
- Message listeners (`chrome.runtime.onMessage`) return `true` for async responses
- Badge updates (`chrome.action.setBadgeText`) handle edge cases (empty, error states)
- Notification creation (`chrome.notifications.create`) uses valid parameters
- Error handling in all async operations (fetch, chrome API calls)

_UI Markup (sidepanel.html):_
- No inline `<script>` tags (CSP violation in Manifest V3)
- External scripts loaded via `<script src="...">`, not inline
- No inline event handlers (`onclick`, `onload`, etc.) — use `addEventListener` in JS
- CSS is well-structured (embedded `<style>` is acceptable)
- Accessible markup: proper labels, ARIA attributes, semantic HTML
- No external CDN resources loaded (must be bundled for extensions)

_UI Logic (sidepanel.js):_
- XSS prevention: No `innerHTML` with unsanitized user data — use `textContent`, `createElement`, or `escapeHtml()`
- Proper event listener cleanup to prevent memory leaks (especially on dynamic content)
- API calls include `Authorization: Bearer <token>` header
- Fetch error handling: check `response.ok`, handle network errors, handle token expiry (401)
- RSVP / event mutation calls use correct Google Calendar API endpoints and methods
- Date/time handling accounts for timezones correctly
- Loading states shown during async operations
- No references to `chrome.storage.sync` where `chrome.storage.local` is expected (or vice versa)
- DOM queries are scoped properly (no stale references after re-render)

_OAuth Files (oauth_callback.html / oauth_callback.js):_
- Token extraction from URL hash is safe (handles missing/malformed fragments)
- Token is passed to background script via `chrome.runtime.sendMessage`, not stored in page variables
- Redirect URI matches what is configured in Google Cloud Console
- Error states handled (user denies permission, network failure)
- Page closes itself after successful token handoff

_Icons:_
- Correct dimensions (16x16, 48x48, 128x128)
- PNG format
- Consistent visual style across sizes
- No unnecessary large file sizes

---

=== Stage 4.5 — Cross-Cutting Consistency Check ===

**This stage catches bugs that file-by-file review misses.** Do NOT skip this stage.

After completing Stage 4, step back and analyze the PR as a whole:

**Operation inventory:**
List every distinct operation the PR implements (e.g., "fetch calendar events", "RSVP to event", "refresh auth token", "update badge count"). For each operation, identify ALL code paths that perform it — including background script triggers, sidepanel user actions, alarm callbacks, and message handlers.

**Safeguard parity check:**
For each operation with multiple code paths, build a comparison table:

| Code path | Auth check | Error handling | Storage update | User feedback | Token refresh |
|-----------|-----------|----------------|----------------|---------------|---------------|

Flag any row that is missing a safeguard present in another row for the same operation. These are must-fix — if one path protects an operation, all paths must.

**Common misses this stage should catch:**
- Background alarm handler missing auth check that sidepanel action has
- Message handler missing error response that direct call provides
- API calls in one file handling 401 with token refresh while another file does not
- Event listeners registered but never cleaned up (memory leak on repeated sidepanel opens)
- State stored in JS variables instead of `chrome.storage` (lost on service worker termination)

**"Fix one, fix all" check:**
If the PR fixes a pattern in one place (e.g., replacing `innerHTML` with `textContent`), search for ALL other instances of that same pattern in the PR. Flag any remaining instances.

---

=== Stage 5 — Reuse & Consistency Sweep (repo-wide) ===

Search for reuse opportunities in the PR changes.

**Targeted searches based on PR content:**

Run only the searches relevant to what the PR touches:

- If PR has API calls: `Grep "fetch(" sidepanel.js background.js` and check for consistent patterns (headers, error handling)
- If PR has token handling: `Grep "token|access_token|Authorization" background.js sidepanel.js oauth_callback.js` for consistent auth patterns
- If PR has Chrome storage operations: `Grep "chrome.storage" background.js sidepanel.js` for consistent read/write patterns
- If PR has message passing: `Grep "sendMessage|onMessage" background.js sidepanel.js` for consistent message formats
- If PR has DOM manipulation: `Grep "innerHTML|textContent|createElement|appendChild" sidepanel.js` for consistent rendering patterns
- If PR has event listeners: `Grep "addEventListener|removeEventListener" sidepanel.js` for proper setup/cleanup

**Code Duplication Detection:**
- Look for similar code patterns across changed files that could be consolidated
- Identify repeated logic that could be extracted to a shared utility function

**Behavioral Consistency Detection:**

This is different from code duplication. Look for multiple code paths that serve the same PURPOSE (e.g., "make an authenticated API call") even if they share zero code. Verify they have equivalent:
- Authorization header inclusion
- Error handling (network errors, 401, 403, rate limits)
- Token refresh on expiry
- User feedback (loading states, error messages)
- Storage updates after mutations

Flag inconsistencies as must-fix when one path has protections another lacks.

For each reuse/consistency candidate found:

- Evidence: existing method/logic location + where it applies in PR (file:line)
- Impact: consistency/maintainability/security
- Patch: minimal unified diff to adopt existing solution or create shared utility
- Consolidation opportunity: if creating new shared code, suggest location (e.g., utility function in sidepanel.js or background.js)

---

=== Stage 6 — Pattern Sweep ===

Search ONLY the files changed in this PR (from Stage 2 git diff) for these patterns; for each hit, either propose a fix or mark "N/A" with reason. Cite exact lines.

**XSS & injection patterns:**
- `innerHTML` with unsanitized data: Any `element.innerHTML = <variable>` where the variable contains user-provided or API-provided data. Use `textContent` for plain text or sanitize/escape before insertion
- Missing `escapeHtml()`: HTML constructed via string concatenation with dynamic values
- `eval()` or `new Function()`: Never use these in extension code
- Template literals in HTML construction: `` `<div>${userInput}</div>` `` without escaping

**Authorization & security:**
- Token exposure: Access tokens logged, stored in `localStorage` (should use `chrome.storage.local`), or passed in URL query params (should be in headers or hash fragments only)
- Missing auth headers: Fetch calls to Google Calendar API without `Authorization: Bearer` header
- OAuth scope changes: Scopes broadened without justification
- Hardcoded secrets: Client secrets, API keys, or tokens in source code
- CSP violations: Inline scripts, `eval()`, loading external resources not declared in manifest

**Storage & state patterns:**
- `chrome.storage` race conditions: Multiple read-modify-write cycles without using `chrome.storage.local.get` callback properly
- Missing error handling on `chrome.storage` operations: `chrome.runtime.lastError` not checked
- Global variables in service worker: State stored in JS variables will be lost when the service worker terminates — must use `chrome.storage`
- `chrome.storage.sync` vs `chrome.storage.local` mismatch: Ensure the correct storage area is used consistently

**Debug & cleanup:**
- `console.log` / `console.debug` / `console.info` — debug output left in production code
- `console.error` — acceptable for genuine error logging, but verify it is intentional
- `debugger` — debugging breakpoint left in
- `alert()` — should not be in production extension code
- `TODO` / `FIXME` / `HACK` comments — should these be addressed before merge?

**Code smell patterns:**
- Broad `catch` blocks: `catch (e) {}` or `catch (e) { console.log(e) }` — should handle errors meaningfully or rethrow
- Unused variables: Variables declared but never referenced
- Memory leaks: Event listeners added without corresponding removal, intervals without cleanup
- `setTimeout`/`setInterval` in service worker: These do not persist — use `chrome.alarms` instead
- `var` instead of `const`/`let`: Prefer block-scoped declarations
- Missing `await` on async operations: Promises that should be awaited but are not (fire-and-forget without error handling)
- Hardcoded magic numbers/strings that should be constants
- Empty `catch` blocks that silently swallow errors

---

=== Stage 6.5 — Deep Investigation (prove, don't speculate) ===

**This stage goes beyond surface-level pattern matching.** Stages 4-6 catch what's wrong in the diff. This stage catches what's wrong *about* the diff — assumptions the code makes about the rest of the system that may not hold.

**IMPORTANT:** Do not speculate. For every potential issue, read the actual source code to confirm or disprove it before reporting. A finding is only valid if you can cite the exact file and line that proves the problem.

Use subagents (Task tool with subagent_type=Explore) to investigate in parallel when multiple areas need checking.

**1. Chrome API contract verification:**
For every Chrome API call added or modified in the PR:
- Verify the API is available in the correct context (service worker vs sidepanel page)
- Verify required permissions are declared in `manifest.json`
- Verify callback signatures match the Chrome API documentation (e.g., `chrome.storage.local.get` returns an object, not individual values)
- **Example catch:** PR uses `chrome.tabs.query()` in background.js but `tabs` permission is not in manifest.json

**2. Message passing integrity:**
For every `chrome.runtime.sendMessage` or `chrome.runtime.onMessage` usage:
- Verify the message format (action name, payload structure) is consistent between sender and receiver
- Verify async message handlers return `true` to keep the message channel open for `sendResponse`
- Verify `sendResponse` is actually called in all code paths (including error paths)
- **Example catch:** PR adds a new message type `{ action: "refreshToken" }` in sidepanel.js but background.js handler checks for `{ type: "refreshToken" }` — different key name

**3. Token & auth flow tracing:**
For key auth operations introduced in the PR, trace the full lifecycle:
- **Token acquisition:** Where is the token obtained? (OAuth flow, storage retrieval) Follow it through storage, message passing, and API usage. Verify each step handles missing/expired tokens
- **Token usage:** Where is the token used? (API calls in sidepanel, background fetch) Verify all usage sites handle 401 responses consistently
- **Token refresh:** When the token expires, verify all code paths that detect expiry trigger the same refresh mechanism. A fetch in sidepanel.js might refresh via message to background.js, but an alarm-triggered fetch in background.js might not
- **Token storage:** Verify tokens are written and read from the same storage key. A write to `chrome.storage.local.set({ token: ... })` but read from `chrome.storage.local.get("access_token")` is a bug

**4. Service worker lifecycle awareness:**
For all state management in background.js:
- Identify any state stored in module-level variables (outside of functions)
- Verify this state is either re-initialized on service worker wake-up or stored in `chrome.storage`
- Check that `chrome.alarms` are used instead of `setTimeout`/`setInterval` for recurring tasks
- **Example catch:** PR stores a `nextRefreshTime` in a global variable, but after service worker termination and restart, this variable is undefined

**5. Removed/changed code ripple effects:**
For every function, message handler, or storage key that was removed or renamed:
- Search the entire codebase (not just changed files) for references to the old name
- Check background.js, sidepanel.js, oauth_callback.js, and HTML files
- **Example catch:** PR renames message action from `"getToken"` to `"fetchToken"` in background.js, but sidepanel.js still sends `{ action: "getToken" }`

---

=== Stage 7 — Generate Review Report ===

Print a detailed report with findings count at the top, grouped by confidence level:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 REVIEW SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Must-fix: [X] issues
Nice-to-have: [Y] suggestions
Test suggestions: [Z] items

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Summary** (3-7 bullets covering key findings)

**High Confidence — Must Fix** (bugs, security issues, data integrity risks — very likely needs to change)
For each issue:
- The concern
- The filename and line numbers
- Why the code is wrong/unsafe
- How to fix it

**High Confidence — Nice-to-Have** (clear improvements — should probably change)
For each issue:
- The suggestion
- The filename and line numbers
- Why it would be better
- How to change it

**Medium Confidence** (probably should be changed, but reviewer judgment needed)
For each issue:
- The concern
- The filename and line numbers
- Why the code might be suboptimal
- How to fix it

**Low Confidence** (consider changing — subjective or minor)
For each suggestion:
- The suggestion
- The filename and line numbers
- Why it might be better

**Architecture & Performance** (high-level concerns)

**Deep Investigation Findings** (from Stage 6.5 — proven issues beyond the diff surface)

**Cross-Cutting Consistency Issues** (from Stage 4.5 — safeguard parity failures)

**Reuse Opportunities** (existing utilities/components that could be used)

**Testing Suggestions** (missing tests, test improvements)

---

=== Stage 8 — Create `.ai-review.json` and Deliver ===

**Step 1: Get PR metadata**
```bash
COMMIT_SHA=$(gh pr view --json commits --jq '.commits[-1].oid' 2>/dev/null)
PR_NUM=$(gh pr view --json number --jq '.number' 2>/dev/null)
```

If no PR exists, skip to "Print to Terminal" delivery.

**Step 2: Create `.ai-review.json` in GitHub-compatible format**

Create a single new untracked file at repo root named `.ai-review.json`. Valid JSON only (no code fences). Include ALL findings as position-anchored comments.

**JSON Schema:**
```json
{
  "commit_id": "COMMIT_SHA_FROM_STEP_1",
  "event": "COMMENT",
  "body": "<Summary: 3-7 bullets covering key findings>",
  "comments": [
    {
      "path": "relative/path/to/file.js",
      "line": 36,
      "side": "RIGHT",
      "body": "[Must-fix] <Issue>. Evidence: <frag>. Impact: <why>. Fix: <one-liner>."
    },
    {
      "path": "relative/path/to/file.js",
      "line": 45,
      "side": "RIGHT",
      "body": "[Nice-to-have] <Issue>. Evidence: <frag>. Suggestion: <change>."
    }
  ]
}
```

**JSON Rules:**

- **commit_id**: REQUIRED — Use the commit SHA from Step 1
- **event**: Must be "COMMENT"
- **body**: Summary of review (3-7 bullets or short paragraph)
- **comments**: Array of all findings

**Comment Format:**
- **path**: Relative file path from repo root
- **line**: The actual line number in the file (NOT a diff position). Use the line number from the NEW version of the file for added/context lines, or the OLD version for deleted lines.
- **side**: `"RIGHT"` for added lines or context lines (commenting on the new version). `"LEFT"` for deleted lines (commenting on the old version).
  - **Validation**: Before finalizing the JSON, re-read the diff for each file and manually verify that each line number falls within a valid hunk range. This is the #1 cause of 422 errors.
- **body**: Comment text with label prefix
  - Start with: `[Must-fix]` | `[Nice-to-have]` | `[Deep]` | `[Suggested tests]` | `[Mentoring]` | `[Reuse]` | `[Pattern]` | `[Consistency]`
  - Keep to 1-2 sentences, ≤ 220 characters
  - Use collaborative phrasing: "Could we...", "Consider..."
  - Include tiny diff (≤5 lines) only if trivial

**Line Number Determination:**
Use the `+N` side of `@@` hunk headers from `gh pr diff` to determine line numbers. For example:
```
@@ -56,6 +57,7 @@ function fetchEvents    <- new file lines start at 57

   function renderEvent                       <- line 58
     const container = ...                    <- line 59
+    container.textContent = event.summary    <- line 60 (use line: 60, side: "RIGHT")
```
The `+57` means the new file starts this hunk at line 57. Count down from there.

**IMPORTANT**: The `line` must fall within the diff hunk range for that file. You can only comment on lines that appear in the diff output (added, removed, or context lines). You CANNOT comment on arbitrary lines that are outside the diff hunks.

For an existing file with context:
```
@@ -10,6 +10,8 @@
 unchanged line      <- line 10
 unchanged line      <- line 11
+new line            <- line 12 (use line: 12, side: "RIGHT")
+new line            <- line 13 (use line: 13, side: "RIGHT")
 unchanged line      <- line 14
```

**Content Requirements:**
- Every Must-fix, Nice-to-have, Deep, Suggested test, Mentoring, Reuse, Consistency, and Pattern Sweep finding MUST appear
- Only reference files and line numbers from the PR diff
- One issue per comment — be specific, actionable, kind
- No long praise, hedging, or walls of text

**Step 3: Select delivery method**
Ask "How would you like your feedback?"

- **Post to GitHub**: Comments will be left on your GitHub PR
- **Print to Terminal**: Comments will be printed here in terminal
- **Both**: Post to GitHub AND print to terminal

**Instructions for Post to GitHub:**
```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  "/repos/dr-bizz/Google-Calendar-Chrome-Sidebar/pulls/${PR_NUM}/reviews" \
  --input .ai-review.json || echo "Failed to post review"
```

**Instructions for Print to Terminal:**
Format and display all comments from the JSON file:
- Group comments by file path
- Show line numbers with each comment
- Display the review body/summary at the top
- Use clear formatting with markdown

**Step 4: Clean up**
```bash
rm .ai-review.json
```

If GitHub posting was selected:
```bash
echo "Review posted to PR #${PR_NUM}"
```

If Terminal printing was selected:
```bash
echo "Review completed for PR #${PR_NUM}"
```

**Troubleshooting:**
- **422 "Path could not be resolved"**: A file path in comments doesn't exist in the GitHub PR diff, or a line number is outside the diff hunk range. Verify all paths exist in `gh pr diff` output and all line numbers fall within diff hunks.
- **422 "Unprocessable Entity"**: Line numbers are outside the diff range — recheck line numbers against `gh pr diff` hunk headers
- **File creation blocked**: Print the JSON object to chat (no prose, no code fences)
- **Empty response**: Verify `gh` CLI is authenticated and PR exists
- **Stacked PRs**: If the PR targets a feature branch (not `main`), always use `gh pr diff` — never `git diff main...HEAD` which would include parent branch changes

**Action Items:**
- After creating `.ai-review.json`, print exactly: `Created .ai-review.json (untracked)`
- After posting review, print exactly: `Review posted to PR #${PR_NUM}`
