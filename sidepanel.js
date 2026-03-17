    // ---- State ----
    let authToken = null;
    let events = [];
    let allCalendars = []; // { id, summary, backgroundColor, selected }
    let enabledCalendarIds = null; // null = not yet loaded, Set once loaded
    let calFilterOpen = false;
    let miniCalDate = new Date();
    let selectedDate = null; // clicked date in mini calendar
    let refreshInterval = null;
    let countdownInterval = null;
    let tokenPollInterval = null;
    let showUpcoming = false;
    let miniCalCollapsed = false;
    let compactMode = false;
    let darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;

    const CALENDAR_COLORS = {
      '1':'#7986cb','2':'#33b679','3':'#8e24aa','4':'#e67c73',
      '5':'#f6bf26','6':'#f4511e','7':'#039be5','8':'#616161',
      '9':'#3f51b5','10':'#0b8043','11':'#d50000'
    };

    // ---- Persistence for preferences ----
    function loadPrefs() {
      try {
        const saved = localStorage.getItem('calPrefs');
        if (saved) {
          const p = JSON.parse(saved);
          if (p.darkMode !== undefined) darkMode = p.darkMode;
          if (p.compactMode !== undefined) compactMode = p.compactMode;
          if (p.miniCalCollapsed !== undefined) miniCalCollapsed = p.miniCalCollapsed;
          if (p.enabledCalendarIds) enabledCalendarIds = new Set(p.enabledCalendarIds);
        }
      } catch (e) {}
      applyPrefs();
    }
    function savePrefs() {
      try {
        localStorage.setItem('calPrefs', JSON.stringify({
          darkMode, compactMode, miniCalCollapsed,
          enabledCalendarIds: enabledCalendarIds ? [...enabledCalendarIds] : null
        }));
      } catch (e) {}
    }
    function applyPrefs() {
      document.body.classList.toggle('dark', darkMode);
      document.body.classList.toggle('compact', compactMode);
      const darkBtn = document.getElementById('darkModeBtn');
      if (darkBtn) darkBtn.classList.toggle('active', darkMode);
      const compactBtn = document.getElementById('compactBtn');
      if (compactBtn) compactBtn.classList.toggle('active', compactMode);
      const cal = document.getElementById('miniCalendar');
      const toggle = document.getElementById('miniCalToggle');
      if (cal && toggle) {
        cal.classList.toggle('collapsed', miniCalCollapsed);
        toggle.textContent = miniCalCollapsed ? 'Show calendar ▾' : 'Hide calendar ▴';
      }
    }

    // ---- Screen Management ----
    function hideAllScreens() {
      ['setupScreen','authScreen','manualScreen','loadingScreen','mainContent'].forEach(id => {
        document.getElementById(id).style.display = 'none';
      });
      const toolbarBtns = ['refreshBtn','darkModeBtn','compactBtn','calFilterBtn','daySummaryBtn'];
      toolbarBtns.forEach(id => document.getElementById(id).style.display = 'none');
    }

    function showScreen(screenId) {
      hideAllScreens();
      const el = document.getElementById(screenId);
      el.style.display = 'flex';
      el.classList.add('screen-fade');
      setTimeout(() => el.classList.remove('screen-fade'), 300);
      if (screenId === 'mainContent') {
        ['refreshBtn','darkModeBtn','compactBtn','calFilterBtn','daySummaryBtn'].forEach(id => {
          document.getElementById(id).style.display = 'flex';
        });
      }
    }

    function showError(containerId, msg) {
      const el = document.getElementById(containerId);
      el.textContent = msg;
      el.style.display = 'block';
    }

    function showDebug(containerId, info) {
      const el = document.getElementById(containerId);
      el.innerHTML = info;
      el.style.display = 'block';
    }

    // ---- Messaging ----
    function sendMsg(msg) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve(response || { error: 'No response' });
            }
          });
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    }

    // ---- API ----
    async function fetchCalendarList() {
      if (!authToken) return [];
      try {
        const res = await fetch(
          'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (!res.ok) return [{ id: 'primary', summary: 'Primary', backgroundColor: '#1a73e8' }];
        const data = await res.json();
        const cals = (data.items || []).filter(c => c.selected !== false);
        allCalendars = cals.map(c => ({
          id: c.id,
          summary: c.summary || c.id,
          backgroundColor: c.backgroundColor || '#1a73e8',
          primary: c.primary || false
        }));
        // If no saved filter, default to primary calendar only
        if (!enabledCalendarIds) {
          const primary = allCalendars.find(c => c.primary);
          if (primary) {
            enabledCalendarIds = new Set([primary.id]);
          } else {
            enabledCalendarIds = new Set(allCalendars.length ? [allCalendars[0].id] : []);
          }
          savePrefs();
        }
        return allCalendars;
      } catch (e) {
        return [{ id: 'primary', summary: 'Primary', backgroundColor: '#1a73e8' }];
      }
    }

    let reAuthAttempted = false;

    async function silentReAuth() {
      console.log('[Auth] Attempting silent re-auth...');
      const result = await sendMsg({ type: 'startAuth' });
      if (result && result.token) {
        authToken = result.token;
        console.log('[Auth] Silent re-auth succeeded');
        return true;
      }
      return false;
    }

    async function fetchEventsForCalendar(calendarId, timeMin, timeMax) {
      if (!authToken) return [];
      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '100'
      });

      const doFetch = async () => {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        return res;
      };

      try {
        let res = await doFetch();

        // On 401, try silent re-auth once before giving up
        if (res.status === 401 && !reAuthAttempted) {
          reAuthAttempted = true;
          const refreshed = await silentReAuth();
          if (refreshed) {
            res = await doFetch();
          }
        }

        if (res.status === 401) {
          authToken = null;
          showScreen('authScreen');
          showError('authError', 'Session expired. Please sign in again.');
          return [];
        }
        if (!res.ok) return [];
        reAuthAttempted = false; // reset on success
        const data = await res.json();
        return (data.items || []).map(ev => ({ ...ev, _calendarId: calendarId }));
      } catch (e) {
        console.error('Fetch error:', e);
        return [];
      }
    }

    async function fetchAllEvents(timeMin, timeMax) {
      const calendars = await fetchCalendarList();
      if (!calendars.length) return [];
      // Only fetch enabled calendars
      const enabled = enabledCalendarIds
        ? calendars.filter(c => enabledCalendarIds.has(c.id))
        : calendars;
      if (!enabled.length) return [];
      const results = await Promise.all(
        enabled.map(c => fetchEventsForCalendar(c.id, timeMin, timeMax))
      );
      let all = results.flat();
      // Filter declined events
      all = all.filter(ev => {
        if (!ev.attendees) return true;
        const me = ev.attendees.find(a => a.self);
        return !me || me.responseStatus !== 'declined';
      });
      // Sort by start time
      all.sort((a, b) => {
        const sa = a.start.dateTime ? new Date(a.start.dateTime) : new Date(a.start.date);
        const sb = b.start.dateTime ? new Date(b.start.dateTime) : new Date(b.start.date);
        return sa - sb;
      });
      return all;
    }

    // ---- Helpers ----
    function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function formatTime(s) { return new Date(s).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); }
    function formatDate(d) { return d.toLocaleDateString([], {weekday:'long',month:'long',day:'numeric'}); }
    function isToday(d) { const t=new Date(); return d.getDate()===t.getDate()&&d.getMonth()===t.getMonth()&&d.getFullYear()===t.getFullYear(); }
    function isSameDay(a,b) { return a.getDate()===b.getDate()&&a.getMonth()===b.getMonth()&&a.getFullYear()===b.getFullYear(); }
    function getColor(e) { return CALENDAR_COLORS[e.colorId]||'#1a73e8'; }
    function formatDuration(mins) {
      if (mins < 60) return mins + ' min';
      const h = Math.floor(mins / 60), m = mins % 60;
      return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
    }
    function countdown(start) {
      const diff = start - new Date();
      if (diff<0) return 'Happening now';
      const m=Math.floor(diff/60000);
      if (m<1) return 'Starting now';
      if (m<60) return `In ${m} min${m!==1?'s':''}`;
      const h=Math.floor(m/60), rm=m%60;
      if (h<24) return `In ${h}h ${rm}m`;
      const d=Math.floor(h/24);
      return `In ${d} day${d!==1?'s':''}`;
    }

    // ---- Toast ----
    function showToast(msg, duration = 2000) {
      const t = document.getElementById('toast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), duration);
    }

    function copyToClipboard(text, label) {
      navigator.clipboard.writeText(text).then(() => showToast(label || 'Copied!'));
    }

    // ---- Caching ----
    async function cacheEventsToStorage(evts) {
      try { await sendMsg({ type: 'cacheEvents', events: evts }); } catch (e) {}
    }

    async function loadCachedEvents() {
      try {
        const result = await sendMsg({ type: 'getCachedEvents' });
        if (result && result.events && result.cacheTime) {
          const age = Date.now() - result.cacheTime;
          if (age < 30 * 60 * 1000) return result.events; // use if < 30 min old
        }
      } catch (e) {}
      return null;
    }

    // ---- Day Summary ----
    function renderDaySummary() {
      const c = document.getElementById('daySummaryContainer');
      if (!c) return;
      const now = new Date();

      // Get today's timed events
      const todayTimed = events.filter(ev => {
        if (ev.start.date) return false;
        return isToday(new Date(ev.start.dateTime));
      });

      if (!todayTimed.length) { c.innerHTML = ''; return; }

      // Calculate stats
      let totalMeetingMins = 0;
      const segments = [];
      todayTimed.forEach(ev => {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        const mins = Math.round((e - s) / 60000);
        totalMeetingMins += mins;
        segments.push({ start: s, end: e });
      });

      // Calculate actual busy time (merge overlapping segments)
      segments.sort((a, b) => a.start - b.start);
      const merged = [];
      segments.forEach(seg => {
        if (merged.length && seg.start <= merged[merged.length - 1].end) {
          merged[merged.length - 1].end = new Date(Math.max(merged[merged.length - 1].end, seg.end));
        } else {
          merged.push({ start: new Date(seg.start), end: new Date(seg.end) });
        }
      });
      let actualBusyMins = 0;
      merged.forEach(m => { actualBusyMins += Math.round((m.end - m.start) / 60000); });

      // Work day 8am-5pm = 540 min
      const workDayMins = 540;
      const freeMins = Math.max(0, workDayMins - actualBusyMins);
      const busyPct = Math.min(100, Math.round((actualBusyMins / workDayMins) * 100));

      // Find focus blocks (free time >= 60 min, excluding 12-1pm lunch)
      const focusBlocks = [];
      const dayStart8 = new Date(now); dayStart8.setHours(8, 0, 0, 0);
      const dayEnd5 = new Date(now); dayEnd5.setHours(17, 0, 0, 0);
      const lunchStart = new Date(now); lunchStart.setHours(12, 0, 0, 0);
      const lunchEnd = new Date(now); lunchEnd.setHours(13, 0, 0, 0);

      // Add lunch as a "busy" block so it's excluded from focus time
      const mergedWithLunch = [...merged, { start: lunchStart, end: lunchEnd }].sort((a, b) => a.start - b.start);
      const mergedFinal = [];
      mergedWithLunch.forEach(seg => {
        if (mergedFinal.length && seg.start <= mergedFinal[mergedFinal.length - 1].end) {
          mergedFinal[mergedFinal.length - 1].end = new Date(Math.max(mergedFinal[mergedFinal.length - 1].end, seg.end));
        } else {
          mergedFinal.push({ start: new Date(seg.start), end: new Date(seg.end) });
        }
      });

      let prev = dayStart8;
      mergedFinal.forEach(m => {
        if (m.start > prev) {
          const gap = Math.round((m.start - prev) / 60000);
          if (gap >= 60) focusBlocks.push({ start: new Date(prev), end: new Date(m.start), mins: gap });
        }
        prev = m.end > prev ? m.end : prev;
      });
      if (dayEnd5 > prev) {
        const gap = Math.round((dayEnd5 - prev) / 60000);
        if (gap >= 60) focusBlocks.push({ start: new Date(prev), end: dayEnd5, mins: gap });
      }

      // Back-to-back detection
      let backToBack = 0;
      for (let i = 0; i < todayTimed.length - 1; i++) {
        const end1 = new Date(todayTimed[i].end.dateTime);
        const start2 = new Date(todayTimed[i + 1].start.dateTime);
        if (Math.abs(start2 - end1) < 5 * 60000) backToBack++;
      }

      const barColor = busyPct > 75 ? 'var(--red)' : busyPct > 50 ? '#e37400' : 'var(--primary)';

      let h = '<div class="day-summary"><div class="day-summary-title">Today at a Glance</div>';
      h += '<div class="day-summary-stats">';
      h += `<div class="day-summary-stat"><div class="day-summary-value">${todayTimed.length}</div><div class="day-summary-label">Meetings</div></div>`;
      h += `<div class="day-summary-stat"><div class="day-summary-value busy">${formatDuration(actualBusyMins)}</div><div class="day-summary-label">Busy</div></div>`;
      h += `<div class="day-summary-stat"><div class="day-summary-value free">${formatDuration(freeMins)}</div><div class="day-summary-label">Free</div></div>`;
      h += `<div class="day-summary-stat"><div class="day-summary-value">${busyPct}%</div><div class="day-summary-label">Booked</div></div>`;
      h += '</div>';
      h += `<div class="day-summary-bar"><div class="day-summary-bar-fill" style="width:${busyPct}%;background:${barColor};"></div></div>`;

      if (focusBlocks.length) {
        const best = focusBlocks.sort((a, b) => b.mins - a.mins)[0];
        h += `<div class="day-summary-focus">Best focus block: ${formatTime(best.start.toISOString())} – ${formatTime(best.end.toISOString())} (${formatDuration(best.mins)})</div>`;
      }
      if (backToBack > 0) {
        h += `<div class="day-summary-warning">${backToBack} back-to-back meeting${backToBack > 1 ? 's' : ''}</div>`;
      }

      h += '</div>';
      c.innerHTML = h;
    }

    // ---- Meeting Warning ----
    let warningInterval = null;
    let alertDismissedEventId = null; // track dismissed alert so it doesn't re-show

    function renderMeetingWarning() {
      const c = document.getElementById('meetingWarningContainer');
      if (!c) return;
      const now = new Date();

      const upcoming = events.find(ev => {
        if (ev.start.date) return false;
        const s = new Date(ev.start.dateTime);
        const diff = s - now;
        return diff > 0 && diff <= 2 * 60 * 1000; // within 2 minutes
      });

      if (!upcoming) {
        c.innerHTML = '';
        hideMeetingAlert();
        return;
      }

      // Show the full-screen green/blue overlay (unless user dismissed it for this event)
      if (upcoming.id !== alertDismissedEventId) {
        showMeetingAlert(upcoming);
      }

      // Also keep the small banner as a secondary indicator
      const meetLink = upcoming.hangoutLink
        ? `<a class="meeting-warning-action" href="${upcoming.hangoutLink}" target="_blank">Join now</a>`
        : '';
      c.innerHTML = `<div class="meeting-warning">
        <div class="meeting-warning-text">Starting now: ${escapeHtml(upcoming.summary || '(No title)')}</div>
        ${meetLink}
      </div>`;
    }

    function showMeetingAlert(event) {
      const overlay = document.getElementById('meetingAlertOverlay');
      const titleEl = document.getElementById('meetingAlertTitle');
      const timeEl = document.getElementById('meetingAlertTime');
      const joinBtn = document.getElementById('meetingAlertJoin');
      const closeBtn = document.getElementById('meetingAlertClose');
      if (!overlay) return;

      titleEl.textContent = event.summary || '(No title)';
      timeEl.textContent = formatTime(event.start.dateTime) + ' – ' + formatTime(event.end.dateTime);

      // Set up join button
      joinBtn.onclick = () => {
        if (event.hangoutLink) {
          window.open(event.hangoutLink, '_blank');
        } else if (event.htmlLink) {
          window.open(event.htmlLink, '_blank');
        }
        alertDismissedEventId = event.id;
        overlay.classList.remove('active');
      };

      // Hide join button if no meeting link
      joinBtn.style.display = event.hangoutLink ? 'flex' : 'none';

      // Set up close button
      closeBtn.onclick = () => {
        alertDismissedEventId = event.id;
        overlay.classList.remove('active');
      };

      overlay.classList.add('active');
    }

    function hideMeetingAlert() {
      const overlay = document.getElementById('meetingAlertOverlay');
      if (overlay) overlay.classList.remove('active');
      alertDismissedEventId = null; // reset so next event can trigger
    }

    // ---- Week Stats ----
    function renderWeekStats() {
      const c = document.getElementById('weekStatsContainer');
      if (!c) return;
      const now = new Date();
      const dayOfWeek = now.getDay();
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - dayOfWeek); weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);

      const weekEvents = events.filter(ev => {
        if (ev.start.date) return false;
        const s = new Date(ev.start.dateTime);
        return s >= weekStart && s < weekEnd;
      });

      if (!weekEvents.length) { c.innerHTML = ''; return; }

      let totalMins = 0;
      const dayCounts = [0, 0, 0, 0, 0, 0, 0];
      weekEvents.forEach(ev => {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        totalMins += Math.round((e - s) / 60000);
        dayCounts[s.getDay()]++;
      });

      const totalHours = (totalMins / 60).toFixed(1);
      const busiestDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayCounts.indexOf(Math.max(...dayCounts))];

      c.innerHTML = `<div class="week-stats">
        <div class="week-stats-item"><span class="week-stats-value">${weekEvents.length}</span>This week</div>
        <div class="week-stats-item"><span class="week-stats-value">${totalHours}h</span>Meeting time</div>
        <div class="week-stats-item"><span class="week-stats-value">${busiestDay}</span>Busiest day</div>
      </div>`;
    }

    // ---- Rendering ----
    function renderCalendarFilter() {
      const list = document.getElementById('calFilterList');
      if (!allCalendars.length) { list.innerHTML = ''; return; }
      let h = '<div class="cal-filter-label"><span>My Calendars</span><div class="cal-filter-actions"><button id="calSelectAll">All</button><button id="calSelectNone">None</button></div></div>';
      allCalendars.forEach(cal => {
        const checked = enabledCalendarIds && enabledCalendarIds.has(cal.id) ? 'checked' : '';
        h += `<label class="cal-filter-item">`;
        h += `<input type="checkbox" data-cal-id="${escapeHtml(cal.id)}" ${checked}>`;
        h += `<span class="cal-filter-dot" style="background:${cal.backgroundColor};"></span>`;
        h += `<span class="cal-filter-name">${escapeHtml(cal.summary)}</span>`;
        h += `</label>`;
      });
      list.innerHTML = h;

      // Checkbox change handlers
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const calId = cb.dataset.calId;
          if (cb.checked) {
            enabledCalendarIds.add(calId);
          } else {
            enabledCalendarIds.delete(calId);
          }
          savePrefs();
          loadEvents();
        });
      });

      // Select all / none
      const allBtn = document.getElementById('calSelectAll');
      const noneBtn = document.getElementById('calSelectNone');
      if (allBtn) allBtn.addEventListener('click', () => {
        enabledCalendarIds = new Set(allCalendars.map(c => c.id));
        savePrefs(); loadEvents();
      });
      if (noneBtn) noneBtn.addEventListener('click', () => {
        enabledCalendarIds = new Set();
        savePrefs(); loadEvents();
      });
    }

    function renderMiniCalendar() {
      const c = document.getElementById('miniCalendar');
      const y=miniCalDate.getFullYear(), mo=miniCalDate.getMonth(), today=new Date();
      const firstDay=new Date(y,mo,1).getDay(), dim=new Date(y,mo+1,0).getDate(), dip=new Date(y,mo,0).getDate();
      const mn = miniCalDate.toLocaleDateString([],{month:'long',year:'numeric'});

      // Collect days that have events
      const eventDays = new Set();
      events.forEach(ev => {
        const s = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date);
        if (s.getMonth() === mo && s.getFullYear() === y) eventDays.add(s.getDate());
      });

      let h=`<div class="mini-cal-header"><span class="mini-cal-title">${mn}</span>
        <div class="mini-cal-nav"><button class="mini-cal-btn" id="pm">‹</button>
        <button class="mini-cal-btn" id="tb" style="font-size:11px;">Today</button>
        <button class="mini-cal-btn" id="nm">›</button></div></div><div class="mini-cal-grid">`;
      ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>{h+=`<div class="mini-cal-day-header">${d}</div>`;});
      for(let i=firstDay-1;i>=0;i--) h+=`<div class="mini-cal-day other-month">${dip-i}</div>`;
      for(let d=1;d<=dim;d++){
        const isT=d===today.getDate()&&mo===today.getMonth()&&y===today.getFullYear();
        const isSel=selectedDate&&d===selectedDate.getDate()&&mo===selectedDate.getMonth()&&y===selectedDate.getFullYear();
        const hasEv=eventDays.has(d);
        let cls='mini-cal-day';
        if(isT) cls+=' today';
        if(isSel) cls+=' selected';
        if(hasEv) cls+=' has-events';
        h+=`<div class="${cls}" data-day="${d}">${d}</div>`;
      }
      const tot=firstDay+dim, rem=(7-(tot%7))%7;
      for(let i=1;i<=rem;i++) h+=`<div class="mini-cal-day other-month">${i}</div>`;
      h+='</div>';
      c.innerHTML=h;
      document.getElementById('pm').addEventListener('click',()=>{miniCalDate.setMonth(miniCalDate.getMonth()-1);renderMiniCalendar();});
      document.getElementById('nm').addEventListener('click',()=>{miniCalDate.setMonth(miniCalDate.getMonth()+1);renderMiniCalendar();});
      document.getElementById('tb').addEventListener('click',()=>{miniCalDate=new Date();selectedDate=null;renderMiniCalendar();renderTimeline();renderEvents();});

      // Click on day to select it
      c.querySelectorAll('.mini-cal-day:not(.other-month)').forEach(el => {
        el.addEventListener('click', () => {
          const day = parseInt(el.dataset.day);
          const clicked = new Date(y, mo, day);
          if (selectedDate && isSameDay(selectedDate, clicked)) {
            selectedDate = null; // deselect
          } else {
            selectedDate = clicked;
          }
          renderMiniCalendar();
          renderTimeline();
          renderEvents();
        });
      });
    }

    function buildMeetingCard(ev, now) {
      const s = new Date(ev.start.dateTime), en = new Date(ev.end.dateTime);
      const isNow = s <= now && en > now;
      const ml = ev.hangoutLink ? `<a class="event-meet-link" href="${ev.hangoutLink}" target="_blank">🎥 Join meeting</a>` : '';
      const minsUntil = Math.max(0, Math.floor((s - now) / 60000));
      const urgencyClass = isNow ? '' : (minsUntil <= 2 ? ' urgent' : minsUntil <= 10 ? ' soon' : '');
      const cdId = isNow ? '' : ' id="cd"';
      const cdText = isNow ? 'Happening now' : countdown(s);
      const mcResp = getMyResponse(ev);
      const respNeeded = mcResp === 'needsAction';
      const mcTentative = mcResp === 'tentative';
      const mcRespClass = respNeeded ? ' needs-response' : mcTentative ? ' tentative-response' : '';
      let respBadge = '';
      if (respNeeded) respBadge = '<div class="next-meeting-needs-badge">Needs your response</div>';
      if (mcTentative) respBadge = '<div class="next-meeting-tentative-badge">? Responded maybe</div>';
      return `<div class="next-meeting ${isNow ? 'happening' : ''}${mcRespClass}" data-event-id="${ev.id || ''}" style="cursor:pointer;">
        <div class="next-meeting-label">${isNow ? 'Happening Now' : 'Up Next'}</div>
        <div class="next-meeting-title">${escapeHtml(ev.summary || '(No title)')}</div>
        <div class="next-meeting-time">${formatTime(ev.start.dateTime)} – ${formatTime(ev.end.dateTime)}</div>
        <div class="next-meeting-countdown${urgencyClass}"${cdId}>${cdText}</div>${ml}${respBadge}</div>`;
    }

    function renderNextMeeting() {
      const c = document.getElementById('nextMeetingContainer'), now = new Date();

      // Find current meeting (happening now) and next upcoming
      const timedEvents = events.filter(e => !e.start.date && new Date(e.end.dateTime) > now);
      if (!timedEvents.length) { c.innerHTML = ''; return; }

      const current = timedEvents.find(e => {
        const s = new Date(e.start.dateTime);
        return s <= now;
      });
      const next = timedEvents.find(e => {
        const s = new Date(e.start.dateTime);
        return s > now;
      });

      let h = '';
      let showNext = false;
      if (current && next) {
        // Only show "Up Next" if current meeting ends at or before next one starts (back-to-back)
        const currentEnd = new Date(current.end.dateTime);
        const nextStart = new Date(next.start.dateTime);
        const gap = Math.round((nextStart - currentEnd) / 60000);
        if (gap <= 5) showNext = true; // within 5 minutes = back-to-back
      }
      if (current) {
        h += buildMeetingCard(current, now);
      } else if (next) {
        // No current meeting — show next as "Up Next"
        h += buildMeetingCard(next, now);
        showNext = false; // already showing it
      }
      if (showNext && next) h += buildMeetingCard(next, now);
      if (!h) { c.innerHTML = ''; return; }
      c.innerHTML = h;

      // Make next-meeting cards clickable
      c.querySelectorAll('.next-meeting[data-event-id]').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'A') return;
          const eventId = card.dataset.eventId;
          if (eventId) openEventDetail(eventId);
        });
      });

      // Update countdown for the "Up Next" card
      if (next) {
        const s = new Date(next.start.dateTime);
        clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
          const el = document.getElementById('cd');
          if (!el) return;
          el.textContent = countdown(s);
          const m = Math.max(0, Math.floor((s - new Date()) / 60000));
          el.className = 'next-meeting-countdown' + (m <= 2 ? ' urgent' : m <= 10 ? ' soon' : '');
        }, 15000);
      }
    }

    function renderTimeline() {
      const c = document.getElementById('timelineContainer');
      const now = new Date();
      const viewDate = selectedDate || now;
      const viewIsToday = isToday(viewDate);

      // Get timed events for the view date (including multi-day events that span into this day)
      const dayEvents = events.filter(ev => {
        if (ev.start.date) return false; // skip all-day
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        const dayStart = new Date(viewDate); dayStart.setHours(0,0,0,0);
        const dayEnd = new Date(viewDate); dayEnd.setHours(23,59,59,999);
        // Event overlaps with this day
        return s <= dayEnd && e >= dayStart;
      }).sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

      if (!dayEvents.length) {
        if (selectedDate && !viewIsToday) {
          c.innerHTML = `<div class="timeline"><div class="timeline-header">${formatDate(viewDate)}</div><div class="empty-day">No events this day</div></div>`;
        } else {
          c.innerHTML = '';
        }
        return;
      }

      // Determine hour range
      let minHour = 23, maxHour = 0;
      const dayStart = new Date(viewDate); dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(viewDate); dayEnd.setHours(23,59,59,999);
      dayEvents.forEach(ev => {
        let s = new Date(ev.start.dateTime);
        let e = new Date(ev.end.dateTime);
        // Clamp to this day
        if (s < dayStart) s = dayStart;
        if (e > dayEnd) e = dayEnd;
        minHour = Math.min(minHour, s.getHours());
        maxHour = Math.max(maxHour, e.getHours() + (e.getMinutes() > 0 ? 1 : 0));
      });
      minHour = Math.max(0, minHour - 1);
      maxHour = Math.min(24, maxHour + 1);

      if (viewIsToday) {
        const nowHour = now.getHours();
        minHour = Math.min(minHour, Math.max(0, nowHour - 1));
        maxHour = Math.max(maxHour, Math.min(24, nowHour + 2));
      }

      const pxPerHour = 48;
      const totalHours = maxHour - minHour;
      const totalHeight = totalHours * pxPerHour;

      function timeToY(date) {
        let d = new Date(date);
        if (d < dayStart) d = dayStart;
        if (d > dayEnd) d = new Date(dayEnd);
        const hours = d.getHours() + d.getMinutes() / 60;
        return (hours - minHour) * pxPerHour;
      }

      function formatHourLabel(h) {
        if (h === 0 || h === 24) return '12 AM';
        if (h === 12) return '12 PM';
        return h > 12 ? (h - 12) + ' PM' : h + ' AM';
      }

      // Compute columns for truly overlapping events (not back-to-back)
      function computeColumns(evts) {
        const placed = [];
        evts.forEach(ev => {
          const s = new Date(ev.start.dateTime).getTime();
          const e = new Date(ev.end.dateTime).getTime();
          let col = 0;
          // Only overlap if one starts STRICTLY before the other ends (not at the same instant)
          while (placed.some(p => p.col === col && p.startMs < e && p.endMs > s)) {
            col++;
          }
          placed.push({ ...ev, col, start: ev.start.dateTime, end: ev.end.dateTime, startMs: s, endMs: e });
        });
        // Determine max columns per overlap group
        placed.forEach(ev => {
          const overlapping = placed.filter(p => p.startMs < ev.endMs && p.endMs > ev.startMs);
          ev.totalCols = Math.max(...overlapping.map(p => p.col + 1));
        });
        return placed;
      }

      const headerLabel = viewIsToday ? "Today's Schedule" : formatDate(viewDate);
      let h = `<div class="timeline"><div class="timeline-header">${escapeHtml(headerLabel)}</div>`;
      h += `<div class="timeline-container" id="timelineScroll" style="height:${totalHeight}px;">`;

      // Hour lines
      for (let hr = minHour; hr < maxHour; hr++) {
        const y = (hr - minHour) * pxPerHour;
        h += `<div class="timeline-hour" style="top:${y}px;position:absolute;left:0;right:0;height:${pxPerHour}px;border-bottom:1px solid var(--border-lighter);">`;
        h += `<div class="timeline-hour-label">${formatHourLabel(hr)}</div>`;
        h += '</div>';
      }

      // Free time gaps (only between non-overlapping sequential events)
      const sortedByStart = [...dayEvents].sort((a,b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
      let lastEnd = null;
      sortedByStart.forEach(ev => {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        if (lastEnd) {
          const gapMins = Math.round((s - lastEnd) / 60000);
          if (gapMins >= 15) {
            const y1 = timeToY(lastEnd);
            const y2 = timeToY(s);
            const midY = (y1 + y2) / 2;
            h += `<div class="timeline-free" style="top:${midY - 8}px;height:16px;">`;
            h += `<span class="timeline-free-label">${formatDuration(gapMins)} free</span>`;
            h += '</div>';
          }
        }
        if (!lastEnd || e > lastEnd) lastEnd = e;
      });

      // Event blocks with column layout
      const eventColors = darkMode
        ? ['#1e3a5f','#1b3d2a','#5a2020','#4a3a10','#3a1f5a','#1a3a1a','#4a3010','#1a2a4f']
        : ['#e8f0fe','#e6f4ea','#fce8e6','#fef7e0','#f3e8fd','#e8f5e9','#fff3e0','#e3f2fd'];
      const placed = computeColumns(dayEvents);
      placed.forEach((ev, idx) => {
        const top = timeToY(new Date(ev.start));
        const bottom = timeToY(new Date(ev.end));
        const naturalHeight = bottom - top;
        // Use natural height with a small min so tiny events are still visible
        const height = Math.max(naturalHeight, 14);
        const col = getColor(ev);
        const bgIdx = idx % eventColors.length;
        const isNow = viewIsToday && new Date(ev.start) <= now && new Date(ev.end) > now;
        const durationMins = Math.round((new Date(ev.end) - new Date(ev.start)) / 60000);

        const colWidth = ev.totalCols > 1 ? (100 / ev.totalCols) : 100;
        const colLeft = ev.col * colWidth;
        const leftStyle = `left:calc(8px + ${colLeft}%)`;
        const widthStyle = `width:calc(${colWidth}% - 16px)`;

        let meetLink = '';
        if (ev.hangoutLink) {
          meetLink = `<a class="timeline-event-meet" href="${ev.hangoutLink}" target="_blank">🎥 Join</a>`;
        }

        const bg = isNow ? 'var(--primary-light)' : eventColors[bgIdx];
        const shadow = isNow ? 'box-shadow:0 1px 4px var(--now-shadow);' : '';
        // For short events, use smaller padding and single-line layout
        const isShort = height < 28;
        const padding = isShort ? 'padding:1px 6px;' : 'padding:4px 8px;';
        const titleSize = isShort ? 'font-size:10px;' : '';

        const evMyResp = getMyResponse(ev);
        const evNeedsResp = evMyResp === 'needsAction';
        const evTentative = evMyResp === 'tentative';
        const tlRespClass = evNeedsResp ? ' needs-response' : evTentative ? ' tentative-response' : '';
        const shortFlexRow = isShort ? 'flex-direction:row;align-items:center;justify-content:space-between;gap:4px;' : '';
        h += `<div class="timeline-event${tlRespClass}" data-event-id="${ev.id || ''}" style="top:${top}px;height:${height}px;${leftStyle};${widthStyle};background:${bg};border-left-color:${col};${shadow}${padding}${shortFlexRow}cursor:pointer;">`;
        // For short events, show title + time inline with join link on right
        if (isShort) {
          const shortTime = formatTime(ev.start);
          h += `<div class="timeline-event-title" style="${titleSize}flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ev.summary || '(No title)')}, ${shortTime}</div>`;
          if (ev.hangoutLink) {
            h += `<a class="timeline-event-meet" href="${ev.hangoutLink}" target="_blank" style="flex-shrink:0;">🎥</a>`;
          }
        } else {
          h += `<div class="timeline-event-title">${escapeHtml(ev.summary || '(No title)')}</div>`;
          if (height >= 34) {
            h += `<div class="timeline-event-time">${formatTime(ev.start)} – ${formatTime(ev.end)} (${formatDuration(durationMins)})</div>`;
          }
          if (height >= 48 && meetLink) h += meetLink;
          if (height >= 48 && evNeedsResp) h += '<span class="timeline-needs-badge">RSVP</span>';
          if (height >= 48 && evTentative) h += '<span class="timeline-tentative-badge">Maybe</span>';
        }
        h += '</div>';
      });

      // Now line
      if (viewIsToday && now.getHours() >= minHour && now.getHours() < maxHour) {
        const nowY = timeToY(now);
        h += `<div class="timeline-now-line" style="top:${nowY}px;">`;
        h += `<div class="timeline-now-dot"></div>`;
        h += '</div>';
      }

      h += '</div></div>';
      c.innerHTML = h;

      // Make timeline events clickable
      c.querySelectorAll('.timeline-event').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.tagName === 'A') return;
          const eventId = el.dataset.eventId;
          if (eventId) openEventDetail(eventId);
        });
      });

      // Auto-scroll to current time
      if (viewIsToday) {
        setTimeout(() => {
          const nowLine = c.querySelector('.timeline-now-line');
          if (nowLine) {
            nowLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
    }

    function buildEventCardHtml(ev, now) {
      const ad = !!ev.start.date;
      const s = ev.start.dateTime ? new Date(ev.start.dateTime) : null;
      const e = ev.end.dateTime ? new Date(ev.end.dateTime) : null;
      const isN = s && e && s <= now && e > now;
      const col = getColor(ev);
      let ts = ad ? '<span class="all-day-badge">All day</span>' : `${formatTime(ev.start.dateTime)} – ${formatTime(ev.end.dateTime)}`;
      let loc = ev.location ? `<div class="event-location">${escapeHtml(ev.location)}</div>` : '';
      let ml = ev.hangoutLink ? `<a class="event-meet-link" href="${ev.hangoutLink}" target="_blank">🎥 Join</a>` : '';

      // Expanded details with quick actions
      let expanded = '<div class="event-expanded">';
      if (ev.description) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = ev.description;
        const plainDesc = tempDiv.textContent || tempDiv.innerText || '';
        expanded += `<div class="event-desc">${escapeHtml(plainDesc)}</div>`;
      }
      if (ev.attendees && ev.attendees.length) {
        expanded += '<div class="event-attendees">';
        ev.attendees.forEach(a => {
          const name = a.displayName || a.email || 'Unknown';
          const declined = a.responseStatus === 'declined';
          expanded += `<span class="event-attendee${declined ? ' declined' : ''}">${escapeHtml(name)}</span>`;
        });
        expanded += '</div>';
      }
      // Quick action buttons
      expanded += '<div class="event-actions">';
      if (ev.hangoutLink) {
        expanded += `<button class="event-action-btn" data-copy="${ev.hangoutLink}">Copy link</button>`;
      }
      const detailText = `${ev.summary || '(No title)'}\n${ad ? 'All day' : formatTime(ev.start.dateTime) + ' – ' + formatTime(ev.end.dateTime)}${ev.location ? '\n' + ev.location : ''}`;
      expanded += `<button class="event-action-btn" data-copy="${escapeHtml(detailText)}">Copy details</button>`;
      if (ev.htmlLink) {
        expanded += `<a class="event-action-btn" href="${ev.htmlLink}" target="_blank">Open in Calendar</a>`;
      }
      expanded += '</div>';
      expanded += '</div>';

      const myResp = getMyResponse(ev);
      const needsResp = myResp === 'needsAction';
      const isTentative = myResp === 'tentative';
      const respClass = needsResp ? ' needs-response' : isTentative ? ' tentative-response' : '';
      let h = `<div class="event-card ${isN ? 'happening-now' : ''}${respClass}" data-event-id="${ev.id || ''}">`;
      h += `<div class="event-color" style="background:${col};"></div>`;
      h += `<div class="event-details"><div class="event-title">${escapeHtml(ev.summary || '(No title)')}</div>`;
      h += `<div class="event-time">${ts}</div>${loc}${ml}`;
      if (needsResp) h += '<div class="event-needs-response-badge">! RSVP needed</div>';
      if (isTentative) h += '<div class="event-tentative-badge">? Maybe</div>';
      h += `${expanded}</div></div>`;
      return h;
    }

    function renderEvents() {
      const c = document.getElementById('eventsContainer');
      if (!events.length) {
        c.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">No upcoming events</div><div class="empty-state-hint">Your calendar is clear for the next 2 weeks</div></div>';
        return;
      }
      const now = new Date();
      const grouped = {};
      events.forEach(ev => {
        const s = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date);
        const k = `${s.getFullYear()}-${s.getMonth()}-${s.getDate()}`;
        if (!grouped[k]) grouped[k] = { date: new Date(s.getFullYear(), s.getMonth(), s.getDate()), events: [] };
        grouped[k].events.push(ev);
      });

      const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
      const sorted = Object.values(grouped).sort((a, b) => a.date - b.date).filter(g => g.date >= todayMidnight);

      // If a date is selected in mini calendar, show that day
      if (selectedDate) {
        const selGroup = sorted.find(g => isSameDay(g.date, selectedDate));
        if (selGroup) {
          let h = `<div class="day-section"><div class="day-header">${isToday(selGroup.date) ? 'Today' : formatDate(selGroup.date)}</div>`;
          selGroup.events.forEach(ev => { h += buildEventCardHtml(ev, now); });
          h += '</div>';
          c.innerHTML = h;
          attachEventCardListeners(c);
          return;
        } else {
          c.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No events on this day</div><div class="empty-state-hint">Click a day in the calendar or tap Today</div></div>';
          return;
        }
      }

      const todayGroups = sorted.filter(g => isToday(g.date));
      const futureGroups = sorted.filter(g => !isToday(g.date));

      let h = '';

      // Today's all-day events only (timed events are in the timeline)
      todayGroups.forEach(g => {
        const allDay = g.events.filter(ev => !!ev.start.date);
        if (allDay.length) {
          h += '<div class="day-section">';
          allDay.forEach(ev => { h += buildEventCardHtml(ev, now); });
          h += '</div>';
        }
      });

      // Toggle for upcoming days
      if (futureGroups.length) {
        const count = futureGroups.reduce((n, g) => n + g.events.length, 0);
        h += '<div class="day-section"><button class="btn-secondary" id="toggleUpcoming" style="width:100%;margin:4px 0;">';
        h += showUpcoming ? 'Hide upcoming days ▴' : `Show upcoming days (${count} events) ▾`;
        h += '</button></div>';

        if (showUpcoming) {
          futureGroups.forEach(g => {
            const tom = new Date(); tom.setDate(tom.getDate() + 1);
            const lbl = isSameDay(g.date, tom) ? 'Tomorrow' : formatDate(g.date);
            h += `<div class="day-section"><div class="day-header">${lbl}</div>`;
            g.events.forEach(ev => { h += buildEventCardHtml(ev, now); });
            h += '</div>';
          });
        }
      }

      c.innerHTML = h;

      // Toggle listener
      const toggleBtn = document.getElementById('toggleUpcoming');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          showUpcoming = !showUpcoming;
          renderEvents();
        });
      }

      attachEventCardListeners(c);
    }

    function attachEventCardListeners(container) {
      container.querySelectorAll('.event-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'A') return;
          // Handle copy buttons
          if (e.target.classList.contains('event-action-btn') && e.target.dataset.copy) {
            e.stopPropagation();
            copyToClipboard(e.target.dataset.copy, 'Copied!');
            return;
          }
          // Open full detail screen
          const eventId = card.dataset.eventId;
          if (eventId) {
            openEventDetail(eventId);
          }
        });
      });
    }

    // ---- Event Detail Screen ----
    function openEventDetail(eventId) {
      const ev = events.find(e => e.id === eventId);
      if (!ev) return;

      const screen = document.getElementById('eventDetailScreen');
      const body = document.getElementById('detailBody');
      const headerTitle = document.getElementById('detailHeaderTitle');
      const openCalLink = document.getElementById('detailOpenCal');

      headerTitle.textContent = ev.summary || '(No title)';
      if (ev.htmlLink) {
        openCalLink.href = ev.htmlLink;
        openCalLink.style.display = 'flex';
      } else {
        openCalLink.style.display = 'none';
      }

      const col = getColor(ev);
      const isAllDay = !!ev.start.date;
      let h = '';

      // Color bar
      h += `<div class="detail-color-bar" style="background:${col};"></div>`;

      // Title
      h += `<div class="detail-title">${escapeHtml(ev.summary || '(No title)')}</div>`;

      // RSVP buttons
      const myResponse = getMyResponse(ev);
      if (ev.attendees && ev.attendees.find(a => a.self)) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Your Response</div>';
        h += '<div class="detail-rsvp" id="detailRsvpButtons">';
        h += `<button class="detail-rsvp-btn${myResponse === 'accepted' ? ' active-yes' : ''}" data-rsvp="accepted">Yes</button>`;
        h += `<button class="detail-rsvp-btn${myResponse === 'tentative' ? ' active-maybe' : ''}" data-rsvp="tentative">Maybe</button>`;
        h += `<button class="detail-rsvp-btn${myResponse === 'declined' ? ' active-no' : ''}" data-rsvp="declined">No</button>`;
        h += '</div>';
        h += '<div class="detail-rsvp-status" id="detailRsvpStatus"></div>';
        h += '</div>';
      }

      // Date & Time
      h += '<div class="detail-section">';
      h += '<div class="detail-section-label">Date & Time</div>';
      if (isAllDay) {
        const d = new Date(ev.start.date + 'T00:00:00');
        h += `<div class="detail-datetime">
          <span class="detail-datetime-icon">📅</span>
          <div><div class="detail-date-line">${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
          <div class="detail-time-line">All day</div></div>
        </div>`;
      } else {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        const durationMins = Math.round((e - s) / 60000);
        h += `<div class="detail-datetime">
          <span class="detail-datetime-icon">📅</span>
          <div><div class="detail-date-line">${s.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
          <div class="detail-time-line">${formatTime(ev.start.dateTime)} – ${formatTime(ev.end.dateTime)} (${formatDuration(durationMins)})</div></div>
        </div>`;
      }
      h += '</div>';

      // Meeting link
      if (ev.hangoutLink) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Meeting Link</div>';
        h += `<button class="detail-meet-btn" data-meet-link="${escapeHtml(ev.hangoutLink)}">🎥 Join Meeting</button>`;
        h += '</div>';
      }

      // Location
      if (ev.location) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Location</div>';
        h += `<div class="detail-location"><span class="detail-location-icon">📍</span><span>${escapeHtml(ev.location)}</span></div>`;
        h += '</div>';
      }

      // Description
      if (ev.description) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Description</div>';
        h += `<div class="detail-description">${sanitizeDescription(ev.description)}</div>`;
        h += '</div>';
      }

      // Attachments
      if (ev.attachments && ev.attachments.length) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Attachments</div>';
        ev.attachments.forEach(att => {
          const icon = getAttachmentIcon(att.mimeType || '', att.title || '');
          h += `<a class="detail-attachment" href="${escapeHtml(att.fileUrl || att.fileId || '#')}" target="_blank">
            <span class="detail-attachment-icon">${icon}</span>
            <div class="detail-attachment-info">
              <div class="detail-attachment-name">${escapeHtml(att.title || 'Untitled')}</div>
              <div class="detail-attachment-type">${escapeHtml(getAttachmentTypeLabel(att.mimeType || ''))}</div>
            </div>
          </a>`;
        });
        h += '</div>';
      }

      // Organizer / Creator
      const organizer = ev.organizer || ev.creator;
      if (organizer) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Organized by</div>';
        const name = organizer.displayName || organizer.email || 'Unknown';
        const initial = name.charAt(0).toUpperCase();
        h += `<div class="detail-organizer">
          <div class="detail-organizer-avatar">${initial}</div>
          <div><div style="font-weight:500;color:var(--text);">${escapeHtml(name)}</div>
          ${organizer.email ? `<div style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(organizer.email)}</div>` : ''}
          </div></div>`;
        h += '</div>';
      }

      // Guests
      if (ev.attendees && ev.attendees.length) {
        h += '<div class="detail-section">';
        h += '<div class="detail-section-label">Guests</div>';
        const accepted = ev.attendees.filter(a => a.responseStatus === 'accepted').length;
        const total = ev.attendees.length;
        h += `<div class="detail-guests-header" id="detailGuestsToggle">
          <span class="detail-guests-count">${total} guest${total !== 1 ? 's' : ''} (${accepted} accepted)</span>
          <span class="detail-guests-toggle" id="detailGuestsArrow">▾</span>
        </div>`;
        h += '<div class="detail-guests-list" id="detailGuestsList">';

        // Sort: organizer first, then accepted, tentative, needsAction, declined
        const order = { accepted: 0, tentative: 1, needsAction: 2, declined: 3 };
        const sorted = [...ev.attendees].sort((a, b) => {
          if (a.organizer) return -1;
          if (b.organizer) return 1;
          return (order[a.responseStatus] || 4) - (order[b.responseStatus] || 4);
        });

        const avatarColors = ['#1a73e8','#34a853','#e37400','#8e24aa','#e67c73','#039be5','#f6bf26'];
        sorted.forEach((att, i) => {
          const name = att.displayName || att.email || 'Unknown';
          const initial = name.charAt(0).toUpperCase();
          const status = att.responseStatus || 'needsAction';
          const statusLabels = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', needsAction: 'Pending' };
          const bg = avatarColors[i % avatarColors.length];
          h += `<div class="detail-guest">
            <div class="detail-guest-avatar" style="background:${bg}20;color:${bg};">${initial}</div>
            <div class="detail-guest-info">
              <div class="detail-guest-name">${escapeHtml(name)}${att.organizer ? ' (organizer)' : ''}${att.self ? ' (you)' : ''}</div>
              ${att.email ? `<div class="detail-guest-email">${escapeHtml(att.email)}</div>` : ''}
            </div>
            <span class="detail-guest-status ${status}">${statusLabels[status] || status}</span>
          </div>`;
        });
        h += '</div>';
        h += '</div>';
      }

      body.innerHTML = h;

      // Attach listeners
      const meetBtn = body.querySelector('.detail-meet-btn');
      if (meetBtn) {
        meetBtn.addEventListener('click', () => window.open(meetBtn.dataset.meetLink, '_blank'));
      }

      const guestsToggle = document.getElementById('detailGuestsToggle');
      const guestsList = document.getElementById('detailGuestsList');
      const guestsArrow = document.getElementById('detailGuestsArrow');
      if (guestsToggle && guestsList) {
        guestsToggle.addEventListener('click', () => {
          const isOpen = guestsList.classList.contains('open');
          guestsList.classList.toggle('open');
          if (guestsArrow) guestsArrow.textContent = isOpen ? '▾' : '▴';
        });
      }

      // RSVP button listeners
      const rsvpContainer = document.getElementById('detailRsvpButtons');
      if (rsvpContainer) {
        rsvpContainer.querySelectorAll('.detail-rsvp-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const response = btn.dataset.rsvp;
            await handleRsvp(ev, response);
          });
        });
      }

      // Show screen
      screen.classList.add('active');
    }

    function closeEventDetail() {
      document.getElementById('eventDetailScreen').classList.remove('active');
    }

    async function handleRsvp(ev, responseStatus) {
      const statusEl = document.getElementById('detailRsvpStatus');
      const btns = document.querySelectorAll('#detailRsvpButtons .detail-rsvp-btn');

      // Disable buttons while updating
      btns.forEach(b => b.disabled = true);
      if (statusEl) statusEl.textContent = 'Updating...';

      try {
        const calendarId = ev._calendarId || 'primary';
        const eventId = ev.id;
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`;

        // Build updated attendees list with new response
        const updatedAttendees = ev.attendees.map(a => {
          if (a.self) {
            return { ...a, responseStatus };
          }
          return a;
        });

        const res = await fetch(url, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ attendees: updatedAttendees })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        // Update local event data
        const me = ev.attendees.find(a => a.self);
        if (me) me.responseStatus = responseStatus;

        // Update button states
        btns.forEach(b => {
          b.classList.remove('active-yes', 'active-no', 'active-maybe');
          if (b.dataset.rsvp === responseStatus) {
            const cls = responseStatus === 'accepted' ? 'active-yes' : responseStatus === 'declined' ? 'active-no' : 'active-maybe';
            b.classList.add(cls);
          }
        });

        const labels = { accepted: 'Accepted', declined: 'Declined', tentative: 'Maybe' };
        if (statusEl) statusEl.textContent = `Response updated to "${labels[responseStatus]}"`;
        showToast(`RSVP: ${labels[responseStatus]}`);

        // Refresh the main views in the background
        renderAll();
      } catch (err) {
        if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
      } finally {
        btns.forEach(b => b.disabled = false);
      }
    }

    function getMyResponse(ev) {
      if (!ev.attendees) return null;
      const me = ev.attendees.find(a => a.self);
      return me ? me.responseStatus : null;
    }

    function needsMyResponse(ev) {
      return getMyResponse(ev) === 'needsAction';
    }

    function sanitizeDescription(html) {
      // Allow basic formatting but strip scripts
      const div = document.createElement('div');
      div.innerHTML = html;
      div.querySelectorAll('script,style,iframe,object,embed').forEach(el => el.remove());
      // Make links open in new tab
      div.querySelectorAll('a').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      return div.innerHTML;
    }

    function getAttachmentIcon(mimeType, title) {
      if (mimeType.includes('spreadsheet') || title.endsWith('.xlsx') || title.endsWith('.csv')) return '📊';
      if (mimeType.includes('document') || mimeType.includes('word') || title.endsWith('.docx')) return '📄';
      if (mimeType.includes('presentation') || title.endsWith('.pptx')) return '📽️';
      if (mimeType.includes('pdf')) return '📕';
      if (mimeType.includes('image')) return '🖼️';
      return '📎';
    }

    function getAttachmentTypeLabel(mimeType) {
      if (mimeType.includes('spreadsheet')) return 'Google Sheets';
      if (mimeType.includes('document')) return 'Google Docs';
      if (mimeType.includes('presentation')) return 'Google Slides';
      if (mimeType.includes('pdf')) return 'PDF';
      if (mimeType.includes('image')) return 'Image';
      if (mimeType.includes('word')) return 'Word Document';
      return 'File';
    }

    // ---- Data Loading ----
    function renderAll() {
      renderCalendarFilter(); renderDaySummary(); renderMeetingWarning();
      renderMiniCalendar(); renderNextMeeting(); renderTimeline();
      renderEvents(); renderWeekStats();
    }

    async function loadEvents() {
      const now = new Date(), tMin = new Date(now), tMax = new Date(now);
      tMin.setHours(0, 0, 0, 0); tMax.setDate(tMax.getDate() + 14);
      events = await fetchAllEvents(tMin, tMax);

      // If token was lost during fetch, don't render — auth screen is already showing
      if (!authToken) return;

      // Cache for badge/offline use
      if (events.length) cacheEventsToStorage(events);
      renderAll();
      // Start meeting warning check every 30s
      clearInterval(warningInterval);
      warningInterval = setInterval(renderMeetingWarning, 30000);
    }

    async function refreshData() {
      const btn = document.getElementById('refreshBtn');
      btn.classList.add('spinning');
      await loadEvents();
      setTimeout(() => btn.classList.remove('spinning'), 500);
    }

    // ---- Cleanup ----
    function clearAllIntervals() {
      clearInterval(refreshInterval);
      clearInterval(countdownInterval);
      clearInterval(tokenPollInterval);
      clearInterval(warningInterval);
      refreshInterval = null;
      countdownInterval = null;
      tokenPollInterval = null;
      warningInterval = null;
    }

    // ---- Init ----
    async function init() {
      loadPrefs();

      const urls = await sendMsg({ type: 'getRedirectURLs' });

      const stored = await sendMsg({ type: 'getStoredToken' });
      if (stored && stored.token) {
        authToken = stored.token;

        // Try cached events for instant display
        const cached = await loadCachedEvents();
        if (cached && cached.length) {
          events = cached;
          showScreen('mainContent');
          renderAll();
          // Refresh in background
          loadEvents().then(() => {
            renderAll();
          });
        } else {
          showScreen('loadingScreen');
          await loadEvents();
        }

        if (authToken) {
          showScreen('mainContent');
          refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
        }
        return;
      }

      showScreen('authScreen');

      if (urls && urls.redirectUrl) {
        showDebug('authDebug',
          `<b>Setup info</b> (add these as Authorized redirect URIs in Google Cloud):<br>
          <code>${escapeHtml(urls.redirectUrl)}</code>
          <button class="copy-btn" id="copyRedirectBtn">Copy</button>
          <br><br>Extension ID: <code>${urls.extensionId || 'unknown'}</code>`
        );
        setTimeout(() => {
          const copyBtn = document.getElementById('copyRedirectBtn');
          if (copyBtn) copyBtn.addEventListener('click', () => navigator.clipboard.writeText(urls.redirectUrl));
        }, 0);
      }
    }

    // ---- Event Listeners ----

    // Event detail back button
    document.getElementById('detailBackBtn').addEventListener('click', closeEventDetail);

    // Sign in
    document.getElementById('signInBtn').addEventListener('click', async () => {
      const btn = document.getElementById('signInBtn');
      btn.textContent = 'Signing in...';
      btn.disabled = true;
      document.getElementById('authError').style.display = 'none';

      const result = await sendMsg({ type: 'startAuth' });

      if (result && result.token) {
        authToken = result.token;
        showScreen('loadingScreen');
        await loadEvents();
        showScreen('mainContent');
        refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
      } else {
        btn.textContent = 'Sign in with Google';
        btn.disabled = false;
        const errMsg = result ? (result.error || 'Unknown error') : 'No response from extension';
        showError('authError', `Sign-in failed: ${errMsg}`);
      }
    });

    // Manual token entry
    document.getElementById('showManualBtn').addEventListener('click', () => {
      showScreen('manualScreen');
      sendMsg({ type: 'getRedirectURLs' }).then(urls => {
        if (urls && urls.redirectUrl) {
          showDebug('manualDebug',
            `<b>Redirect URI for Google Cloud:</b><br>
            <code>${escapeHtml(urls.redirectUrl)}</code>
            <button class="copy-btn" id="copyRedirectBtn2">Copy</button>`
          );
          setTimeout(() => {
            const copyBtn = document.getElementById('copyRedirectBtn2');
            if (copyBtn) copyBtn.addEventListener('click', () => navigator.clipboard.writeText(urls.redirectUrl));
          }, 0);
        }
      });
    });

    document.getElementById('openAuthPageBtn').addEventListener('click', async () => {
      const urls = await sendMsg({ type: 'getRedirectURLs' });
      const redirectUri = urls ? urls.redirectUrl : '';
      const clientId = urls ? urls.clientId : '';
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'token',
        redirect_uri: redirectUri,
        scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
        prompt: 'consent'
      });
      window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, '_blank');
    });

    document.getElementById('saveManualTokenBtn').addEventListener('click', async () => {
      const token = document.getElementById('manualTokenInput').value.trim();
      if (!token) { showError('manualError', 'Please paste a token first.'); return; }
      const result = await sendMsg({ type: 'saveManualToken', token });
      if (result && !result.error) {
        authToken = token;
        showScreen('loadingScreen');
        await loadEvents();
        if (authToken) {
          showScreen('mainContent');
          refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
        } else {
          showScreen('manualScreen');
          showError('manualError', 'Token appears to be invalid.');
        }
      }
    });

    document.getElementById('backToAuthBtn').addEventListener('click', () => showScreen('authScreen'));

    // Sign out — clean up all intervals
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      clearAllIntervals();
      await sendMsg({ type: 'signOut' });
      authToken = null;
      events = [];
      showScreen('authScreen');
    });

    // Refresh
    document.getElementById('refreshBtn').addEventListener('click', refreshData);

    // Dark mode toggle
    document.getElementById('darkModeBtn').addEventListener('click', () => {
      darkMode = !darkMode;
      applyPrefs();
      savePrefs();
      renderTimeline(); // re-render with correct colors
    });

    // Compact mode toggle
    document.getElementById('compactBtn').addEventListener('click', () => {
      compactMode = !compactMode;
      applyPrefs();
      savePrefs();
    });

    // Close specific panels (pass the one to keep open)
    function closeOtherPanels(keep) {
      if (keep !== 'summary') {
        document.getElementById('daySummaryContainer').classList.remove('open');
        document.getElementById('daySummaryBtn').classList.remove('active');
      }
      if (keep !== 'filter') {
        calFilterOpen = false;
        document.getElementById('calFilterPanel').classList.remove('open');
        document.getElementById('calFilterBtn').classList.remove('active');
      }
      if (keep !== 'calendar') {
        miniCalCollapsed = true;
        applyPrefs();
      }
    }

    // Day summary toggle
    document.getElementById('daySummaryBtn').addEventListener('click', () => {
      const panel = document.getElementById('daySummaryContainer');
      const isOpen = panel.classList.contains('open');
      closeOtherPanels('summary');
      if (isOpen) {
        panel.classList.remove('open');
        document.getElementById('daySummaryBtn').classList.remove('active');
      } else {
        panel.classList.add('open');
        document.getElementById('daySummaryBtn').classList.add('active');
      }
    });

    // Calendar filter toggle
    document.getElementById('calFilterBtn').addEventListener('click', () => {
      const wasOpen = calFilterOpen;
      closeOtherPanels('filter');
      if (wasOpen) {
        calFilterOpen = false;
        document.getElementById('calFilterPanel').classList.remove('open');
        document.getElementById('calFilterBtn').classList.remove('active');
      } else {
        calFilterOpen = true;
        document.getElementById('calFilterPanel').classList.add('open');
        document.getElementById('calFilterBtn').classList.add('active');
      }
    });

    // Mini calendar collapse toggle
    document.getElementById('miniCalToggle').addEventListener('click', () => {
      if (miniCalCollapsed) {
        closeOtherPanels('calendar');
        miniCalCollapsed = false;
      } else {
        miniCalCollapsed = true;
      }
      applyPrefs();
      savePrefs();
    });

    // Token polling (with proper cleanup)
    tokenPollInterval = setInterval(async () => {
      if (!authToken) {
        const stored = await sendMsg({ type: 'getStoredToken' });
        if (stored && stored.token) {
          authToken = stored.token;
          showScreen('loadingScreen');
          await loadEvents();
          showScreen('mainContent');
          refreshInterval = setInterval(loadEvents, 5 * 60 * 1000);
        }
      }
    }, 2000);

    // Start
    init();
