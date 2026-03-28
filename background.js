// ---- CONFIG ----
const WORKER_URL = 'https://auth-token-exchange.dr-bizz.workers.dev';
let _refreshPromise = null;

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
function isSafeUrl(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

async function storeGoogleSession(sessionToken, accessToken) {
  await chrome.storage.local.set({
    googleSessionToken: sessionToken,
    googleAccessToken: accessToken,
    googleTokenTime: Date.now(),
  });
  chrome.alarms.create('tokenRefresh', { delayInMinutes: 55 });
  return accessToken;
}

async function refreshGoogleToken() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = _doRefreshGoogleToken();
  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

async function _doRefreshGoogleToken() {
  const data = await chrome.storage.local.get(['googleSessionToken']);
  if (!data.googleSessionToken) {
    return null;
  }
  try {
    const response = await fetch(`${WORKER_URL}/google/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: data.googleSessionToken }),
    });
    if (response.status === 401 || response.status === 404) {
      console.log('[Auth] Session expired on worker, clearing local session');
      await chrome.storage.local.remove(['googleSessionToken', 'googleAccessToken', 'googleTokenTime']);
      return null;
    }
    const result = await response.json();
    if (result.access_token) {
      await chrome.storage.local.set({
        googleAccessToken: result.access_token,
        googleTokenTime: Date.now(),
      });
      return result.access_token;
    }
    return null;
  } catch (e) {
    console.error('[Auth] Token refresh error:', e);
    return null;
  }
}

async function retrieveGitHubToken() {
  const data = await chrome.storage.local.get(['githubSessionToken']);
  if (!data.githubSessionToken) {
    return null;
  }
  try {
    const response = await fetch(`${WORKER_URL}/github/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: data.githubSessionToken }),
    });
    const result = await response.json();
    return result.access_token || null;
  } catch (e) {
    console.error('[GitHub] Token retrieval error:', e);
    return null;
  }
}

async function revokeSession(provider) {
  const storageKey = provider === 'google' ? 'googleSessionToken' : 'githubSessionToken';
  const data = await chrome.storage.local.get([storageKey]);
  const sessionToken = data[storageKey];
  if (sessionToken) {
    try {
      await fetch(`${WORKER_URL}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: sessionToken, provider }),
      });
    } catch (e) {
      console.log(`[Auth] Revoke ${provider} error (best-effort):`, e.message);
    }
  }
  if (provider === 'google') {
    await chrome.storage.local.remove(['googleSessionToken', 'googleAccessToken', 'googleTokenTime']);
  } else {
    await chrome.storage.local.remove(['githubSessionToken', 'githubUsername']);
  }
}

// ---- ALARMS SETUP ----
// Create alarms on install/update to avoid resetting timers on every worker wake
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create('refreshEvents', { periodInMinutes: 5 });
  chrome.alarms.create('checkToken', { periodInMinutes: 1 });
  chrome.alarms.create('updateBadge', { periodInMinutes: 1 });
  chrome.alarms.create('checkNotifications', { periodInMinutes: 1 });
  chrome.alarms.create('checkPRs', { periodInMinutes: 10 });

  // Clean up old storage keys from pre-v8 auth architecture
  if (details.reason === 'update') {
    chrome.storage.local.remove(['accessToken', 'tokenTime', 'githubToken', 'githubTokenTime']);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshEvents') {
    // Placeholder for event refresh logic — triggered every 5 minutes
    console.log('[Alarms] refreshEvents fired');
  }

  if (alarm.name === 'checkToken' || alarm.name === 'tokenRefresh') {
    try {
      const data = await chrome.storage.local.get(['googleSessionToken', 'googleTokenTime']);
      if (data.googleSessionToken && data.googleTokenTime) {
        const age = Date.now() - data.googleTokenTime;
        // 55 minutes is a safe threshold to refresh before the typical 1-hour expiry, allowing some buffer for delays
        if (age > 3300000) {
          console.log('[Alarms] Token older than 55 min, refreshing via worker');
          const accessToken = await refreshGoogleToken();
          if (accessToken) {
            console.log('[Alarms] Token refresh succeeded');
            chrome.runtime.sendMessage({ type: 'tokenRefreshed', accessToken }).catch(() => {});
          } else {
            console.log('[Alarms] Token refresh failed');
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
      const data = await chrome.storage.local.get(['githubSessionToken', 'githubUsername', 'cachedPRs', 'prCacheTime', 'notifiedPRKeys', 'enabledPRRepos']);
      if (!data.githubSessionToken || !data.githubUsername) {
        return;
      }

      // Deduplication: skip if cache was updated less than 90 seconds ago
      if (data.prCacheTime && Date.now() - data.prCacheTime < 90000) {
        return;
      }

      // Retrieve GitHub token from worker for this poll cycle
      const ghToken = await retrieveGitHubToken();
      if (!ghToken) {
        return;
      }

      // Lightweight search-only fetch (no enrichment)
      const searchUrl = `https://api.github.com/search/issues?q=type:pr+review-requested:${encodeURIComponent(data.githubUsername)}+is:open&per_page=100`;
      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.status === 401) {
        await revokeSession('github');
        await chrome.storage.local.remove(['cachedPRs', 'prCacheTime', 'notifiedPRKeys']);
        return;
      }

      if (response.status === 403) {
        console.warn('[checkPRs] Rate limited, skipping this cycle');
        return;
      }

      if (!response.ok) {
        return;
      }

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
        if (enabledRepos && !enabledRepos.has(pr.repo)) {
          continue;
        }

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
    if (!data.cachedEvents) { 
      callback(null);
      return;
    }
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
      if (event) {
        openEventUrl(event);
      }
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

// ---- AUTH FUNCTIONS ----
async function startGoogleAuth() {
  return new Promise((resolve) => {
    const authUrl = `${WORKER_URL}/google/auth`;
    console.log('[Google Auth] Opening auth tab:', authUrl);

    chrome.tabs.create({ url: authUrl }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ error: 'Failed to open auth tab: ' + chrome.runtime.lastError.message });
        return;
      }

      const listener = async (message, _sender, sendResponse) => {
        if (message.type === 'oauthCallback' && message.provider === 'google') {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          chrome.tabs.onRemoved.removeListener(tabListener);
          try { chrome.tabs.remove(tab.id); } catch (e) {}

          if (message.sessionToken && message.accessToken) {
            await storeGoogleSession(message.sessionToken, message.accessToken);
            resolve({ token: message.accessToken });
          } else {
            resolve({ error: 'No session token received' });
          }
          if (sendResponse) {
            sendResponse({ ok: true });
          }
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(tabListener);
        resolve({ error: 'Auth timed out after 5 minutes' });
      }, 300000);

      const tabListener = (tabId) => {
        if (tabId === tab.id) {
          chrome.tabs.onRemoved.removeListener(tabListener);
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          setTimeout(() => resolve({ error: 'Auth tab was closed' }), 500);
        }
      };
      chrome.tabs.onRemoved.addListener(tabListener);
    });
  });
}

async function startGitHubAuth() {
  return new Promise((resolve) => {
    const authUrl = `${WORKER_URL}/github/auth`;
    console.log('[GitHub Auth] Opening auth tab:', authUrl);

    chrome.tabs.create({ url: authUrl }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ error: 'Failed to open auth tab: ' + chrome.runtime.lastError.message });
        return;
      }

      const listener = (message, _sender, sendResponse) => {
        if (message.type === 'oauthCallback' && message.provider === 'github') {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          chrome.tabs.onRemoved.removeListener(tabListener);
          try { chrome.tabs.remove(tab.id); } catch (e) {}

          if (message.sessionToken) {
            chrome.storage.local.set({ githubSessionToken: message.sessionToken });
            resolve({ sessionToken: message.sessionToken });
          } else {
            resolve({ error: 'No session token received' });
          }
          if (sendResponse) {
            sendResponse({ ok: true });
          }
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(tabListener);
        resolve({ error: 'Auth timed out after 5 minutes' });
      }, 300000);

      const tabListener = (tabId) => {
        if (tabId === tab.id) {
          chrome.tabs.onRemoved.removeListener(tabListener);
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          setTimeout(() => resolve({ error: 'Auth tab was closed' }), 500);
        }
      };
      chrome.tabs.onRemoved.addListener(tabListener);
    });
  });
}

// ---- MESSAGE HANDLING ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Silent token refresh — via worker
  if (message.type === 'silentRefresh') {
    (async () => {
      const token = await refreshGoogleToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }

  if (message.type === 'startAuth') {
    (async () => {
      console.log('[Auth] Starting Google authentication via worker...');
      const result = await startGoogleAuth();
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'getStoredToken') {
    (async () => {
      const data = await chrome.storage.local.get(['googleSessionToken', 'googleAccessToken', 'googleTokenTime']);
      if (!data.googleSessionToken) {
        sendResponse({ token: null });
        return;
      }
      // Return cached token if fresh (under 55 minutes old)
      if (data.googleAccessToken && data.googleTokenTime) {
        const age = Date.now() - data.googleTokenTime;
         // 55 minutes is a safe threshold to refresh before the typical 1-hour expiry, allowing some buffer for delays
        if (age < 3300000) {
          sendResponse({ token: data.googleAccessToken });
          return;
        }
      }
      // Token is stale or missing — refresh via worker
      const token = await refreshGoogleToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }

  if (message.type === 'signOut') {
    (async () => {
      await revokeSession('google');
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'oauthCallback') {
    // Validate sender is our own oauth_callback page
    if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('oauth_callback.html'))) {
      sendResponse({ error: 'Invalid sender' });
      return true;
    }
    (async () => {
      if (message.provider === 'google' && message.sessionToken && message.accessToken) {
        await storeGoogleSession(message.sessionToken, message.accessToken);
        sendResponse({ success: true });
      } else if (message.provider === 'github' && message.sessionToken) {
        await chrome.storage.local.set({ githubSessionToken: message.sessionToken });
        sendResponse({ success: true });
      } else {
        sendResponse({ error: 'Invalid callback data' });
      }
    })();
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
      const result = await startGitHubAuth();
      if (result.sessionToken) {
        const token = await retrieveGitHubToken();
        sendResponse({ token, sessionToken: result.sessionToken });
      } else {
        sendResponse({ error: result.error });
      }
    })();
    return true;
  }

  if (message.type === 'getGitHubToken') {
    (async () => {
      const token = await retrieveGitHubToken();
      sendResponse({ token: token || null });
    })();
    return true;
  }

  if (message.type === 'disconnectGitHub') {
    (async () => {
      await revokeSession('github');
      await chrome.storage.local.remove(['cachedPRs', 'prCacheTime', 'notifiedPRKeys']);
      sendResponse({ success: true });
    })();
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
