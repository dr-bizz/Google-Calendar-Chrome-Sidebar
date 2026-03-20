// ---- CONFIG ----
const CLIENT_ID = '213142139393-3e1ihmchu6h0etig6p9olgbj1hhc9oak.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

// ---- GITHUB CONFIG ----
const GITHUB_CLIENT_ID = 'Ov23liLXcKeNsvuH4dg4';
const GITHUB_WORKER_URL = 'https://github-token-exchange.dr-bizz.workers.dev';
// 'repo' scope is required to access private repository PRs via the GitHub API.
// GitHub does not offer a narrower scope for read-only PR access on private repos.
const GITHUB_SCOPE = 'repo';

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
  chrome.alarms.create('checkPRs', { periodInMinutes: 10 });
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
        }

        // Auto-dismiss notifications for events that started 10+ minutes ago
        chrome.notifications.getAll((active) => {
          for (const id of Object.keys(active)) {
            if (id.startsWith('pr::')) continue; // Skip PR notifications
            const parts = id.split('::');
            const ts = parseInt(parts[parts.length - 1]);
            if (ts && now - ts > 10 * 60 * 1000) {
              chrome.notifications.clear(id);
            }
          }
        });

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
    try {
      const data = await chrome.storage.local.get(['cachedEvents', 'cachedPRs', 'enabledPRRepos']);

      // Helper: get filtered PR count
      function getPRCount() {
        if (!data.cachedPRs || !Array.isArray(data.cachedPRs)) return 0;
        const enabledRepos = data.enabledPRRepos ? new Set(data.enabledPRRepos) : null;
        return data.cachedPRs.filter(pr => !enabledRepos || enabledRepos.has(pr.repo)).length;
      }

      if (data.cachedEvents && Array.isArray(data.cachedEvents)) {
        const now = Date.now();
        const upcoming = data.cachedEvents
          .filter(event => event.start && event.start.dateTime)
          .map(event => ({ ...event, startMs: new Date(event.start.dateTime).getTime() }))
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
            const prCount = getPRCount();
            if (prCount > 0) {
              chrome.action.setBadgeText({ text: `${prCount}` });
              chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
            } else {
              chrome.action.setBadgeText({ text: '' });
            }
          }
        } else {
          const prCount = getPRCount();
          if (prCount > 0) {
            chrome.action.setBadgeText({ text: `${prCount}` });
            chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
        }
      } else {
        const prCount = getPRCount();
        if (prCount > 0) {
          chrome.action.setBadgeText({ text: `${prCount}` });
          chrome.action.setBadgeBackgroundColor({ color: '#8e24aa' });
        } else {
          chrome.action.setBadgeText({ text: '' });
        }
      }
    } catch (e) {
      console.error('[Alarms] updateBadge error:', e);
    }
  }

  if (alarm.name === 'checkPRs') {
    try {
      const data = await chrome.storage.local.get(['githubToken', 'githubUsername', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys', 'enabledPRRepos']);
      if (!data.githubToken || !data.githubUsername) return;

      // Deduplication: skip if cache was updated less than 90 seconds ago
      if (data.prCacheTime && Date.now() - data.prCacheTime < 90000) return;

      // Lightweight search-only fetch (no enrichment)
      const searchUrl = `https://api.github.com/search/issues?q=type:pr+review-requested:${encodeURIComponent(data.githubUsername)}+is:open&per_page=100`;
      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${data.githubToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.status === 401) {
        await chrome.storage.local.remove(['githubToken', 'githubTokenTime', 'githubUsername', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys']);
        return;
      }

      if (response.status === 403) {
        console.warn('[checkPRs] Rate limited, skipping this cycle');
        return;
      }

      if (!response.ok) return;

      const searchData = await response.json();
      const newPRs = (searchData.items || []).map(item => {
        const repoFullName = (item.repository_url || '').replace('https://api.github.com/repos/', '');
        return {
          id: item.id,
          repo: repoFullName,
          title: item.title,
          number: item.number,
          htmlUrl: item.html_url,
          author: { login: item.user?.login, avatarUrl: item.user?.avatar_url },
        };
      });

      // Detect new review requests
      const oldIds = new Set((data.cachedPRs || []).map(pr => pr.id));
      const notifiedKeys = new Set(data.notifiedPRKeys || []);
      const enabledRepos = data.enabledPRRepos ? new Set(data.enabledPRRepos) : null;
      let notifiedChanged = false;

      for (const pr of newPRs) {
        // Respect repo filter
        if (enabledRepos && !enabledRepos.has(pr.repo)) continue;

        if (!oldIds.has(pr.id) && !notifiedKeys.has(`pr::${pr.id}`)) {
          const oldPR = (data.cachedPRs || []).find(p => p.id === pr.id);
          const isReReview = oldPR ? oldPR.isReReview : false;

          const notifOptions = {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `${pr.repo} #${pr.number}`,
            message: `${isReReview ? 'Re-review' : 'Review'} requested: ${pr.title}`,
            priority: isReReview ? 2 : 1,
            requireInteraction: isReReview,
          };

          chrome.notifications.create(`pr::${pr.id}`, notifOptions);
          notifiedKeys.add(`pr::${pr.id}`);
          notifiedChanged = true;
        }
      }

      // Cleanup: remove notified keys for PRs no longer requesting review
      const currentIds = new Set(newPRs.map(pr => pr.id));
      for (const key of notifiedKeys) {
        if (key.startsWith('pr::')) {
          const prId = parseInt(key.substring(4));
          if (!currentIds.has(prId)) {
            notifiedKeys.delete(key);
            notifiedChanged = true;
          }
        }
      }

      // Merge new lightweight data with existing enriched cache
      const mergedPRs = newPRs.map(newPR => {
        const existing = (data.cachedPRs || []).find(p => p.id === newPR.id);
        return existing ? { ...existing, ...newPR } : newPR;
      });

      const updates = { cachedPRs: mergedPRs, prCacheTime: Date.now() };
      if (notifiedChanged) updates.notifiedPRKeys = [...notifiedKeys];
      await chrome.storage.local.set(updates);

    } catch (e) {
      console.error('[Alarms] checkPRs error:', e);
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
  if (notificationId.startsWith('pr::')) {
    // PR notification — look up the htmlUrl from cached PRs
    chrome.storage.local.get(['cachedPRs'], (data) => {
      const prId = parseInt(notificationId.substring(4));
      const pr = (data.cachedPRs || []).find(p => p.id === prId);
      if (pr && pr.htmlUrl && isSafeUrl(pr.htmlUrl)) {
        chrome.tabs.create({ url: pr.htmlUrl });
      }
    });
  } else {
    // Calendar event notification
    findEventFromNotification(notificationId, (event) => {
      if (event) openEventUrl(event);
    });
  }
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId.startsWith('pr::')) {
    // PR notification button — open in GitHub
    if (buttonIndex === 0) {
      chrome.storage.local.get(['cachedPRs'], (data) => {
        const prId = parseInt(notificationId.substring(4));
        const pr = (data.cachedPRs || []).find(p => p.id === prId);
        if (pr && pr.htmlUrl) {
          chrome.tabs.create({ url: pr.htmlUrl });
        }
      });
    }
  } else if (buttonIndex === 0) {
    // Calendar event button
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

// ---- GITHUB AUTH ----
async function authViaGitHub() {
  if (GITHUB_CLIENT_ID === 'YOUR_GITHUB_CLIENT_ID' || GITHUB_WORKER_URL.includes('YOUR_SUBDOMAIN')) {
    return { error: 'GitHub integration not configured. Update GITHUB_CLIENT_ID and GITHUB_WORKER_URL in background.js.' };
  }
  return new Promise((resolve) => {
    const redirectUri = getRedirectURL();
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: GITHUB_SCOPE,
      state,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    console.log('[GitHub Auth] Starting OAuth flow');
    console.log('[GitHub Auth] Redirect URI:', redirectUri);

    try {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        async (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            console.warn('[GitHub Auth] Failed:', chrome.runtime.lastError?.message);
            resolve({ error: chrome.runtime.lastError?.message || 'No response' });
            return;
          }

          try {
            const url = new URL(responseUrl);
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');

            if (!code) {
              resolve({ error: 'No authorization code in response' });
              return;
            }

            if (returnedState !== state) {
              resolve({ error: 'State mismatch — possible CSRF attack' });
              return;
            }

            // Exchange code for token via Cloudflare Worker
            const tokenResponse = await fetch(`${GITHUB_WORKER_URL}/github/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code }),
            });

            const data = await tokenResponse.json();
            if (data.error) {
              resolve({ error: data.error });
              return;
            }

            if (data.access_token) {
              console.log('[GitHub Auth] Success!');
              await chrome.storage.local.set({
                githubToken: data.access_token,
                githubTokenTime: Date.now(),
              });
              resolve({ token: data.access_token });
            } else {
              resolve({ error: 'No access token in worker response' });
            }
          } catch (e) {
            console.error('[GitHub Auth] Token exchange error:', e);
            resolve({ error: e.message });
          }
        }
      );
    } catch (e) {
      console.warn('[GitHub Auth] Exception:', e.message);
      resolve({ error: e.message });
    }
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
        let responded = false;

        const timeout = setTimeout(() => {
          if (!responded) { responded = true; sendResponse({ token: null }); }
        }, 10000);

        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: false },
          (responseUrl) => {
            clearTimeout(timeout);
            if (responded) return;
            responded = true;
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
          // Token expired — return null but do NOT remove from storage.
          // Removing it triggers storage.onChanged across all tabs,
          // causing a sign-out cascade. The stale token sits inert until
          // overwritten by a successful refresh or cleared by explicit sign-out.
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
      storeToken(message.token).then(() => sendResponse({ success: true }));
    } else {
      sendResponse({ error: 'No token provided' });
    }
    return true;
  }

  if (message.type === 'oauthToken') {
    if (message.token) {
      storeToken(message.token).then(() => sendResponse({ success: true }));
    } else {
      sendResponse({ success: false });
    }
    return true;
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

  // ---- GITHUB AUTH MESSAGE HANDLERS ----
  if (message.type === 'startGitHubAuth') {
    (async () => {
      const result = await authViaGitHub();
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'getGitHubToken') {
    chrome.storage.local.get(['githubToken'], (data) => {
      sendResponse({ token: data.githubToken || null });
    });
    return true;
  }

  if (message.type === 'disconnectGitHub') {
    chrome.storage.local.remove(['githubToken', 'githubTokenTime', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys', 'githubUsername'], () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // ---- PR CACHING MESSAGE HANDLERS ----
  if (message.type === 'cachePRs') {
    chrome.storage.local.set({
      cachedPRs: message.prs,
      prCacheTime: Date.now(),
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'getCachedPRs') {
    chrome.storage.local.get(['cachedPRs', 'prCacheTime'], (data) => {
      sendResponse({
        prs: data.cachedPRs || null,
        cacheTime: data.prCacheTime || null,
      });
    });
    return true;
  }
});
