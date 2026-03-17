# Google Calendar Side Panel - Setup Guide

**IMPORTANT:** Once you load this extension, NEVER remove it and re-add it.
If you need to update files, replace them in the folder and click the
RELOAD button on brave://extensions. Removing it changes the Extension ID
and breaks the Google Cloud connection.

---

## STEP 1: Load the Extension FIRST

1. Open `brave://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `google-calendar-sidepanel` folder
4. Copy your **Extension ID** (the long string of letters under the extension name)
5. KEEP THIS — you'll need it in Step 3

## STEP 2: Create Google Cloud Project + Enable API

1. Go to https://console.cloud.google.com/
2. Create a **New Project** (name: "Calendar Panel"), click Create
3. Make sure it's selected in the dropdown at the top
4. Go to: https://console.cloud.google.com/apis/library
5. Search **Google Calendar API** → click it → click **Enable**

## STEP 3: Set Up OAuth

**A) Consent Screen:**
1. Go to: https://console.cloud.google.com/auth/overview
2. Click **Branding** in the sidebar
   - App name: `Calendar Panel`
   - User support email: your email
   - Developer contact: your email
   - Save
3. Click **Audience** in the sidebar
   - Choose **External** → Save
   - Click **+ Add Users** → add your email address → Save
4. Click **Data Access** in the sidebar
   - Click **Add or Remove Scopes**
   - Find `Google Calendar API` → check `calendar.events`
   - Click Update → Save

**B) Create OAuth Client (for Brave browser):**

> **Brave users need a "Web application" client type** (not "Chrome Extension").
> Chrome Extension clients only work in Google Chrome because they depend
> on Chrome Web Store integration that Brave doesn't have.

1. Go to: https://console.cloud.google.com/auth/clients
2. Click **+ Create Client**
3. Application type: **Web application**
4. Name: `Calendar Panel`
5. Under **Authorized redirect URIs**, click **+ Add URI**
6. Enter: `https://YOUR_EXTENSION_ID.chromiumapp.org/`
   - Replace `YOUR_EXTENSION_ID` with the Extension ID from Step 1
   - Example: `https://jbjnpfnadckdbdlpihfcgjepokiieojj.chromiumapp.org/`
   - Make sure to include the trailing `/`
7. Click **Create**
8. Copy the **Client ID** (looks like `123456-abc.apps.googleusercontent.com`)

> **Already have a "Chrome Extension" client?** You can keep it too — the
> extension tries it first. But the Web application client is needed as a
> fallback for Brave. If you use a different Client ID for the Web app
> client, update the files in Step 4.

## STEP 4: Add Client ID to Extension

Update the Client ID in TWO files:

**File 1: background.js**
- Open in a text editor
- Line 2: replace the Client ID string with yours
- Save

**File 2: manifest.json**
- Open in a text editor
- Find the `client_id` in the `oauth2` section and replace with yours
- Save

> Both files MUST have the SAME Client ID.

## STEP 5: Reload and Use

1. Go to `brave://extensions`
2. Click the **reload** icon (circular arrow) on the extension
   Do NOT remove and re-add — just reload!
3. Click the extension icon in the toolbar to open the side panel
4. Click **Sign in with Google**
5. A Google sign-in window appears — sign in and allow access
6. Your calendar events appear!

## TROUBLESHOOTING

### "redirect_uri_mismatch" error
This means the redirect URI registered in Google Cloud doesn't match what
the extension sends. Fix:
1. Open the service worker console (brave://extensions → Inspect views: service worker)
2. Click "Sign in with Google" — look for the `[Auth] Redirect URL:` log
3. Copy that EXACT URL (including trailing slash)
4. Go to your OAuth client in Google Cloud Console
5. Make sure that EXACT URL is listed under "Authorized redirect URIs"
6. Wait 1-2 minutes for Google to propagate changes, then try again

### Sign-in hangs / nothing happens
Brave may block the auth popup. Check:
1. Brave Shields is not blocking the Google auth popup
2. Try the "Enter token manually" fallback option

### "Token expired" after ~1 hour
OAuth tokens expire after 1 hour. Click "Sign in with Google" again to
get a fresh token. This is normal for OAuth implicit flow.
