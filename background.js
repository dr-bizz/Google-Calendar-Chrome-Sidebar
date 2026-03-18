// ---- CONFIG ----
const CLIENT_ID = '213142139393-3e1ihmchu6h0etig6p9olgbj1hhc9oak.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

// ---- SIDE PANEL SETUP ----
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    try {
      await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    } catch (e) {}
  }
});

// ---- HELPERS ----
function getRedirectURL() {
  try {
    return chrome.identity.getRedirectURL();
  } catch (e) {
    return `https://${chrome.runtime.id}.chromiumapp.org/`;
  }
}

function buildAuthURL(redirectUri, { silent = false } = {}) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: 'online'
  });
  if (!silent) params.set('prompt', 'select_account');
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function isSafeUrl(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

function extractTokenFromUrl(url) {
  try {
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) return null;
    const hash = url.substring(hashIndex + 1);
    const params = new URLSearchParams(hash);
    return params.get('access_token');
  } catch (e) {
    console.error('[Auth] Token extraction error:', e);
    return null;
  }
}

async function storeToken(token) {
  await chrome.storage.local.set({ accessToken: token, tokenTime: Date.now() });
  // Schedule a proactive token refresh at 45 minutes
  chrome.alarms.create('tokenRefresh', { delayInMinutes: 45 });
}

// ---- ALARMS SETUP ----
// Create alarms on install/update to avoid resetting timers on every worker wake
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refreshEvents', { periodInMinutes: 5 });
  chrome.alarms.create('checkToken', { periodInMinutes: 1 });
  chrome.alarms.create('updateBadge', { periodInMinutes: 1 });
  chrome.alarms.create('checkNotifications', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshEvents') {
    // Placeholder for event refresh logic — triggered every 5 minutes
    console.log('[Alarms] refreshEvents fired');
  }

  if (alarm.name === 'checkToken' || alarm.name === 'tokenRefresh') {
    // Proactive token refresh: if token is older than 45 minutes, silently re-auth
    try {
      const data = await chrome.storage.local.get(['tokenTime']);
      if (data.tokenTime) {
        const age = Date.now() - data.tokenTime;
        if (age > 2700000) { // 45 minutes
          console.log('[Alarms] Token is older than 45 minutes, attempting silent re-auth');
          try {
            const redirectUri = getRedirectURL();
            const authUrl = buildAuthURL(redirectUri, { silent: true });

            chrome.identity.launchWebAuthFlow(
              { url: authUrl, interactive: false },
              (responseUrl) => {
                if (chrome.runtime.lastError || !responseUrl) {
                  console.log('[Alarms] Silent re-auth failed, letting token expire naturally');
                  return;
                }
                const token = extractTokenFromUrl(responseUrl);
                if (token) {
                  console.log('[Alarms] Silent re-auth succeeded');
                  storeToken(token);
                }
              }
            );
          } catch (e) {
            console.log('[Alarms] Silent re-auth error, letting token expire naturally');
          }
        }
      }
    } catch (e) {
      console.error('[Alarms] checkToken error:', e);
    }
  }

  if (alarm.name === 'checkNotifications') {
    try {
      const data = await chrome.storage.local.get(['cachedEvents', 'notifPrefs', 'notifiedEventKeys']);
      const prefs = data.notifPrefs || { enabled: true, minutesBefore: 5 };
      if (!prefs.enabled) return;

      // Load persisted notification tracking (survives service worker termination)
      const notifiedKeys = new Set(data.notifiedEventKeys || []);

      if (data.cachedEvents && Array.isArray(data.cachedEvents)) {
        const now = Date.now();
        const minutesBefore = prefs.minutesBefore || 5;
        const windowMs = minutesBefore * 60 * 1000;
        let changed = false;

        const upcoming = [];
        for (const event of data.cachedEvents) {
          if (!event.start || !event.start.dateTime || !event.end || !event.end.dateTime) continue;
          const startMs = new Date(event.start.dateTime).getTime();
          const timeUntil = startMs - now;
          if (timeUntil > 0 && timeUntil <= windowMs) {
            upcoming.push({ event, startMs });
          }
        }

        for (const { event, startMs } of upcoming) {
          const notifKey = `${event.id}::${startMs}`;
          if (notifiedKeys.has(notifKey)) continue;
          notifiedKeys.add(notifKey);
          changed = true;

          const minutesUntil = Math.round((startMs - now) / 60000);
          const timeText = minutesUntil <= 1 ? 'Starting now' : `In ${minutesUntil} minutes`;
          const startTime = new Date(event.start.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const endTime = new Date(event.end.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

          const notifOptions = {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: event.summary || '(No title)',
            message: `${timeText} — ${startTime} to ${endTime}`,
            priority: 2,
            requireInteraction: minutesUntil <= 2
          };

          chrome.notifications.create(notifKey, notifOptions);

          // Auto-dismiss after 10 minutes
          setTimeout(() => {
            chrome.notifications.clear(notifKey);
          }, 10 * 60 * 1000);
        }

        // Clean up old notified keys (older than 1 hour)
        for (const key of notifiedKeys) {
          const parts = key.split('::');
          const ts = parseInt(parts[parts.length - 1]);
          if (ts && now - ts > 3600000) {
            notifiedKeys.delete(key);
            changed = true;
          }
        }

        // Persist tracking to survive service worker termination
        if (changed) {
          await chrome.storage.local.set({ notifiedEventKeys: [...notifiedKeys] });
        }
      }
    } catch (e) {
      console.error('[Alarms] checkNotifications error:', e);
    }
  }

  if (alarm.name === 'updateBadge') {
    // Badge support: show upcoming event info on the extension badge
    try {
      const data = await chrome.storage.local.get(['cachedEvents']);
      if (data.cachedEvents && Array.isArray(data.cachedEvents)) {
        const now = Date.now();
        // Find the next upcoming timed event (has dateTime, not all-day)
        const upcoming = data.cachedEvents
          .filter(event => event.start && event.start.dateTime)
          .map(event => ({
            ...event,
            startMs: new Date(event.start.dateTime).getTime()
          }))
          .filter(event => event.startMs > now)
          .sort((a, b) => a.startMs - b.startMs);

        if (upcoming.length > 0) {
          const next = upcoming[0];
          const minutesUntil = Math.round((next.startMs - now) / 60000);

          if (minutesUntil <= 2) {
            chrome.action.setBadgeText({ text: 'NOW' });
            chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
          } else if (minutesUntil <= 30) {
            chrome.action.setBadgeText({ text: `${minutesUntil}m` });
            chrome.action.setBadgeBackgroundColor({ color: '#0000FF' });
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
        } else {
          chrome.action.setBadgeText({ text: '' });
        }
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    } catch (e) {
      console.error('[Alarms] updateBadge error:', e);
    }
  }
});

// ---- NOTIFICATION HANDLERS ----
function findEventFromNotification(notificationId, callback) {
  chrome.storage.local.get(['cachedEvents'], (data) => {
    if (!data.cachedEvents) { callback(null); return; }
    const delimIdx = notificationId.lastIndexOf('::');
    const eventId = delimIdx !== -1 ? notificationId.substring(0, delimIdx) : notificationId;
    const event = data.cachedEvents.find(e => e.id === eventId);
    callback(event || null);
  });
}

function openEventUrl(event) {
  const url = event.hangoutLink || event.htmlLink;
  if (url && isSafeUrl(url)) {
    chrome.tabs.create({ url });
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  findEventFromNotification(notificationId, (event) => {
    if (event) openEventUrl(event);
  });
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    findEventFromNotification(notificationId, (event) => {
      if (event && event.hangoutLink && isSafeUrl(event.hangoutLink)) {
        chrome.tabs.create({ url: event.hangoutLink });
      }
    });
  }
  chrome.notifications.clear(notificationId);
});

// ---- AUTH STRATEGY 1: chrome.identity.getAuthToken() ----
// Works in Chrome with "Chrome Extension" client type.
// Requires manifest.json oauth2 section with correct client_id.
// May not work in Brave (Brave doesn't connect to Chrome Web Store).
async function authViaGetAuthToken() {
  return new Promise((resolve) => {
    console.log('[Auth Strategy 1] getAuthToken (Chrome standard)');

    if (!chrome.identity || !chrome.identity.getAuthToken) {
      console.warn('[Auth Strategy 1] getAuthToken not available');
      resolve({ error: 'getAuthToken not available in this browser' });
      return;
    }

    // Set a timeout — getAuthToken can hang in Brave
    const timeout = setTimeout(() => {
      console.warn('[Auth Strategy 1] Timed out after 10s');
      resolve({ error: 'getAuthToken timed out (not supported in this browser)' });
    }, 10000);

    try {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('[Auth Strategy 1] Failed:', chrome.runtime.lastError.message);
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        if (token) {
          console.log('[Auth Strategy 1] Success!');
          storeToken(token);
          resolve({ token });
        } else {
          resolve({ error: 'No token returned' });
        }
      });
    } catch (e) {
      clearTimeout(timeout);
      console.warn('[Auth Strategy 1] Exception:', e.message);
      resolve({ error: e.message });
    }
  });
}

// ---- AUTH STRATEGY 2: launchWebAuthFlow ----
// Works with a "Web application" OAuth client that has the chromiumapp.org
// redirect URI registered. This is the recommended approach for Brave/Edge.
async function authViaWebAuthFlow() {
  return new Promise((resolve) => {
    const redirectUri = getRedirectURL();
    const authUrl = buildAuthURL(redirectUri);

    console.log('[Auth Strategy 2] launchWebAuthFlow');
    console.log('[Auth Strategy 2] Redirect URI:', redirectUri);
    console.log('[Auth Strategy 2] Full auth URL:', authUrl);

    try {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (responseUrl) => {
          if (chrome.runtime.lastError) {
            console.warn('[Auth Strategy 2] Failed:', chrome.runtime.lastError.message);
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          if (!responseUrl) {
            console.warn('[Auth Strategy 2] No response URL');
            resolve({ error: 'No response from Google' });
            return;
          }

          const token = extractTokenFromUrl(responseUrl);
          if (token) {
            console.log('[Auth Strategy 2] Success!');
            storeToken(token);
            resolve({ token });
          } else {
            console.warn('[Auth Strategy 2] No token in response:', responseUrl);
            resolve({ error: 'No token in Google response' });
          }
        }
      );
    } catch (e) {
      console.warn('[Auth Strategy 2] Exception:', e.message);
      resolve({ error: e.message });
    }
  });
}

// ---- AUTH STRATEGY 3: Tab-based with chromiumapp.org interception ----
// Opens auth in a regular tab. Watches for redirect to chromiumapp.org
// and extracts token. Works as fallback when launchWebAuthFlow fails
// but the OAuth client is properly configured.
async function authViaTab() {
  return new Promise((resolve) => {
    const redirectUri = getRedirectURL();
    const authUrl = buildAuthURL(redirectUri);

    console.log('[Auth Strategy 3] Tab-based auth');
    console.log('[Auth Strategy 3] Redirect URI:', redirectUri);

    chrome.tabs.create({ url: authUrl }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ error: 'Failed to open auth tab: ' + chrome.runtime.lastError.message });
        return;
      }

      const tabUpdatedListener = (tabId, changeInfo) => {
        if (tabId !== tab.id) return;

        // Check both changeInfo.url and try to get the full URL
        const url = changeInfo.url || '';
        if (url.startsWith(redirectUri) || url.includes('chromiumapp.org')) {
          cleanup();
          const token = extractTokenFromUrl(url);
          if (token) {
            console.log('[Auth Strategy 3] Success!');
            storeToken(token);
            try { chrome.tabs.remove(tab.id); } catch (e) {}
            resolve({ token });
          } else {
            resolve({ error: 'No token in redirect URL' });
          }
        }
      };

      const tabRemovedListener = (tabId) => {
        if (tabId === tab.id) {
          cleanup();
          setTimeout(() => resolve({ error: 'Auth tab was closed' }), 500);
        }
      };

      function cleanup() {
        chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
        chrome.tabs.onRemoved.removeListener(tabRemovedListener);
        clearTimeout(timer);
      }

      chrome.tabs.onUpdated.addListener(tabUpdatedListener);
      chrome.tabs.onRemoved.addListener(tabRemovedListener);

      const timer = setTimeout(() => {
        cleanup();
        resolve({ error: 'Auth timed out after 5 minutes' });
      }, 300000);
    });
  });
}

// ---- MESSAGE HANDLING ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Silent token refresh — non-interactive, no popup, with timeout
  if (message.type === 'silentRefresh') {
    (async () => {
      try {
        const redirectUri = getRedirectURL();
        const authUrl = buildAuthURL(redirectUri, { silent: true });

        const timeout = setTimeout(() => {
          sendResponse({ token: null });
        }, 10000);

        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: false },
          (responseUrl) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError || !responseUrl) {
              sendResponse({ token: null });
              return;
            }
            const token = extractTokenFromUrl(responseUrl);
            if (token) {
              storeToken(token).then(() => sendResponse({ token }));
            } else {
              sendResponse({ token: null });
            }
          }
        );
      } catch (e) {
        sendResponse({ token: null });
      }
    })();
    return true;
  }

  if (message.type === 'startAuth') {
    (async () => {
      console.log('[Auth] Starting authentication...');
      console.log('[Auth] Extension ID:', chrome.runtime.id);
      console.log('[Auth] Redirect URL:', getRedirectURL());

      // Strategy 1: launchWebAuthFlow (primary — works in both Chrome and Brave
      // with a "Web application" OAuth client)
      let result = await authViaWebAuthFlow();
      if (result.token) {
        sendResponse(result);
        return;
      }
      console.log('[Auth] launchWebAuthFlow failed:', result.error);

      // Strategy 2: Tab-based (fallback)
      console.log('[Auth] Trying tab-based auth...');
      result = await authViaTab();
      if (result.token) {
        sendResponse(result);
        return;
      }
      console.log('[Auth] Tab-based failed:', result.error);

      // All strategies failed — return last error with setup guidance
      sendResponse({
        error: result.error + '\n\nSetup tip: Make sure you have a "Web application" OAuth client in Google Cloud with this redirect URI:\n' + getRedirectURL()
      });
    })();
    return true;
  }

  if (message.type === 'getStoredToken') {
    chrome.storage.local.get(['accessToken', 'tokenTime'], (data) => {
      if (data.accessToken && data.tokenTime) {
        const age = Date.now() - data.tokenTime;
        if (age < 3500000) {
          sendResponse({ token: data.accessToken });
        } else {
          chrome.storage.local.remove(['accessToken', 'tokenTime']);
          sendResponse({ token: null });
        }
      } else {
        sendResponse({ token: null });
      }
    });
    return true;
  }

  if (message.type === 'signOut') {
    // Also revoke the token with Google if possible
    chrome.storage.local.get(['accessToken'], (data) => {
      if (data.accessToken) {
        // Try to revoke the cached Chrome identity token
        try {
          chrome.identity.removeCachedAuthToken({ token: data.accessToken }, () => {});
        } catch (e) {}
      }
      chrome.storage.local.remove(['accessToken', 'tokenTime'], () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.type === 'getRedirectURLs') {
    const redirectUrl = getRedirectURL();
    const callbackUrl = chrome.runtime.getURL('oauth_callback.html');
    sendResponse({ redirectUrl, callbackUrl, extensionId: chrome.runtime.id, clientId: CLIENT_ID });
    return false;
  }

  if (message.type === 'saveManualToken') {
    if (message.token) {
      storeToken(message.token);
      sendResponse({ success: true });
    } else {
      sendResponse({ error: 'No token provided' });
    }
    return false;
  }

  if (message.type === 'oauthToken') {
    if (message.token) {
      storeToken(message.token);
      sendResponse({ success: true });
    }
    return false;
  }

  // ---- EVENT CACHING MESSAGE HANDLERS ----
  if (message.type === 'cacheEvents') {
    chrome.storage.local.set({
      cachedEvents: message.events,
      cacheTime: Date.now()
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'getCachedEvents') {
    chrome.storage.local.get(['cachedEvents', 'cacheTime'], (data) => {
      sendResponse({
        events: data.cachedEvents || null,
        cacheTime: data.cacheTime || null
      });
    });
    return true;
  }
});
