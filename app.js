// ====== CONFIG ======
// Paste your Apps Script /exec URL here once deployed.
const API_URL = 'https://script.google.com/macros/s/AKfycbwwB94GWz7lxHIlL8YjGotKuetc7oaHjTOfYQxRcVJfEnCGpW7MPQPNw-8l73ZMXOmF/exec';

// Challenge window (DD/MM/YY)
const CHALLENGE_START = { d: 10, m: 8, y: 26 };
const CHALLENGE_END = { d: 9, m: 11, y: 26 };
const TOTAL_CHALLENGE_DAYS = 92;

// Cache of latest data
let currentUserData = null;
let currentLeaderboard = [];
let currentWeeklyRecap = null;
let currentNudges = [];
let nudgedTargetsToday = new Set();
let prayersCache = [];
let activeCommentsDate = null;
let activePrayersDate = null;

// ====== HELPERS ======

function pad(n) { return String(n).padStart(2, '0'); }

function formatDDMMYY(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)}`;
}

function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODateToDDMMYY(isoStr) {
  if (!isoStr) return '';
  const parts = isoStr.split('-');
  if (parts.length < 3) return '';
  return `${parts[2]}/${parts[1]}/${parts[0].slice(-2)}`;
}

function parseDDMMYYToISO(ddmmyyStr) {
  if (!ddmmyyStr) return '';
  const parts = ddmmyyStr.split('/');
  if (parts.length < 3) return '';
  const fullYear = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${fullYear}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
}

async function apiGet(params, { retries = 1, timeoutMs = 12000 } = {}) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const GUEST_INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

function getSession() {
  const raw = localStorage.getItem('bible92_session');
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    if (session && session.isGuest) {
      const now = Date.now();
      const last = session.lastActivity || session.loginTime || 0;
      if (now - last > GUEST_INACTIVITY_LIMIT_MS) {
        clearSession();
        return null;
      }
    }
    return session;
  } catch (e) {
    return null;
  }
}

function setSession(session) {
  if (session && session.isGuest) {
    session.lastActivity = Date.now();
    session.loginTime = session.loginTime || Date.now();
  }
  localStorage.setItem('bible92_session', JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem('bible92_session');
}

async function getClientGeoInfo() {
  // Primary fast lookup via ipwho.is (IP + City, Region, Country)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const res = await fetch('https://ipwho.is/', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success !== false && data.ip) {
        const locParts = [data.city, data.region, data.country].filter(Boolean);
        return {
          ip: data.ip || '',
          location: locParts.join(', ') || data.country || 'Unknown'
        };
      }
    }
  } catch (e) {}

  // Fallback lookup via ipapi.co
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        const locParts = [data.city, data.region, data.country_name].filter(Boolean);
        return {
          ip: data.ip || '',
          location: locParts.join(', ') || data.country_name || 'Unknown'
        };
      }
    }
  } catch (e) {}

  // Fallback lookup via ipify for IP only
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      return { ip: data.ip || '', location: 'Unknown' };
    }
  } catch (e) {}

  return { ip: '', location: 'Unknown' };
}

// ====== THEME ======

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon-moon').hidden = theme === 'light';
  document.getElementById('theme-icon-sun').hidden = theme !== 'light';
  localStorage.setItem('bible92_theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('bible92_theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }
}

// ====== LEVEL BADGE HELPER ======

function createLevelBadgeEl(levelTitle) {
  const span = document.createElement('span');
  span.className = 'level-badge' + (levelTitle && levelTitle.includes('Finisher') ? ' finisher' : '');
  span.textContent = levelTitle || 'Disciple I';
  return span;
}

// ====== LOGIN & APP LIFECYCLE ======

function initLogin() {
  initPasswordToggle();
  const session = getSession();
  if (session) {
    showSite(session);
    return;
  }

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    const isGuest = username.toLowerCase().startsWith('guest');
    const clientSessionId = (isGuest ? 'g_' : 'u_') + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    const geoInfo = await getClientGeoInfo();
    const userAgent = navigator.userAgent || '';

    try {
      const res = await apiGet({
        action: 'login',
        username,
        password,
        sessionId: clientSessionId,
        ipAddress: geoInfo.ip,
        location: geoInfo.location,
        userAgent: userAgent
      });
      if (res.success) {
        const session = {
          username: res.username,
          password,
          isGuest: !!res.isGuest,
          sessionId: res.sessionId || clientSessionId,
          lastActivity: Date.now(),
          loginTime: Date.now()
        };
        setSession(session);
        showSite(session);
      } else {
        errorEl.textContent = res.error || 'Could not sign in.';
        errorEl.hidden = false;
      }
    } catch (err) {
      errorEl.textContent = 'Could not reach the server. Check your connection and try again.';
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Begin Reading';
    }
  });
}

function initPasswordToggle() {
  const toggleBtn = document.getElementById('toggle-password-btn');
  const passwordInput = document.getElementById('login-password');
  const eyeShow = document.getElementById('eye-icon-show');
  const eyeHide = document.getElementById('eye-icon-hide');

  if (!toggleBtn || !passwordInput) return;

  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    if (eyeShow) eyeShow.hidden = isPassword;
    if (eyeHide) eyeHide.hidden = !isPassword;
  });
}

function updateGuestBanner(activeGuest, session) {
  const banner = document.getElementById('guest-warning-banner');
  const textEl = document.getElementById('guest-warning-text');
  if (!banner || !textEl) return;

  const currentGuest = activeGuest || (session && session.isGuest ? session.username : null);
  if (currentGuest) {
    textEl.textContent = `A guest is currently logged in (${currentGuest} is watching)! Don't have too much fun or they may die of envy! ✨`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function initGuestInactivityWatcher(session) {
  if (!session || !session.isGuest) return;

  let lastSavedTime = Date.now();

  const recordActivity = () => {
    const now = Date.now();
    if (now - lastSavedTime >= 5000) {
      lastSavedTime = now;
      const cur = getSession();
      if (cur && cur.isGuest) {
        cur.lastActivity = now;
        localStorage.setItem('bible92_session', JSON.stringify(cur));
      }
    }
  };

  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
    window.addEventListener(evt, recordActivity, { passive: true });
  });

  // Check every 10 seconds for 30 minutes inactivity timeout
  setInterval(() => {
    const cur = getSession();
    if (!cur) {
      alert('Your guest session has expired after 30 minutes of inactivity. Please sign in again.');
      location.reload();
    }
  }, 10000);
}

function showSite(session) {
  document.getElementById('login-screen').hidden = true;
  const siteEl = document.getElementById('site');
  siteEl.hidden = false;
  siteEl.classList.add('fade-in', 'site-ease-in');
  document.getElementById('welcome-user').textContent = `Hi, ${session.username}` + (session.isGuest ? ' (Guest)' : '');

  document.getElementById('logout-btn').addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  updateGuestBanner(null, session);
  initGuestInactivityWatcher(session);
  initMobileMenu();
  initDateDropdown();
  initShareModal();
  initReadingSidebar();
  initScriptureReader(session);
  initScrollTransitions();
  initSquadNudgeBanner(session);
  initCommentsDateSearch(session);
  initPrayersDateSearch(session);
  wireUpdateForm(session);
  wireCommentForm(session);
  wirePrayerForm(session);
  initAudioNarrator();
  wireShareTodayButton(session);
  loadInitialData(session);
  startAutoRefresh(session);
}

function startAutoRefresh(session) {
  setInterval(() => loadUpdates(session), 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadUpdates(session);
  });
}

// ====== MOBILE NAV ======

function initMobileMenu() {
  const menuBtn = document.getElementById('menu-toggle');
  const navLeft = document.getElementById('nav-left');

  menuBtn.addEventListener('click', () => {
    const isOpen = navLeft.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(isOpen));
  });

  navLeft.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) {
      navLeft.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('click', (e) => {
    if (!navLeft.classList.contains('open')) return;
    if (navLeft.contains(e.target) || menuBtn.contains(e.target)) return;
    navLeft.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
  });
}

// ====== SECTION 1: TODAY'S READING ======

function initDateDropdown() {
  const select = document.getElementById('date-select');
  const start = new Date(2000 + CHALLENGE_START.y, CHALLENGE_START.m - 1, CHALLENGE_START.d);
  const challengeEnd = new Date(2000 + CHALLENGE_END.y, CHALLENGE_END.m - 1, CHALLENGE_END.d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = today < challengeEnd ? today : challengeEnd;

  select.innerHTML = '';
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const opt = document.createElement('option');
    opt.value = formatDDMMYY(d);
    opt.textContent = formatDDMMYY(d);
    select.appendChild(opt);
  }
  select.value = formatDDMMYY(end);
}

function wireUpdateForm(session) {
  const form = document.getElementById('update-form');
  const feedback = document.getElementById('update-feedback');
  if (!form) return;

  if (session && session.isGuest) {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Guest View Only';
    }
    const dateSelect = document.getElementById('date-select');
    const statusSelect = document.getElementById('status-select');
    if (dateSelect) dateSelect.disabled = true;
    if (statusSelect) statusSelect.disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session && session.isGuest) {
      feedback.hidden = false;
      feedback.textContent = 'Guest users are in read-only mode.';
      feedback.className = 'form-feedback error';
      return;
    }
    feedback.hidden = true;
    const date = document.getElementById('date-select').value;
    const status = document.getElementById('status-select').value;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const res = await apiGet({
        action: 'updateStatus',
        username: session.username,
        password: session.password,
        date,
        status
      });
      feedback.hidden = false;
      if (res.success) {
        feedback.textContent = `Marked ${date} as "${status}".`;
        feedback.className = 'form-feedback success';
        if (status === 'Read') celebrate(false);
        loadUpdates(session);
      } else {
        feedback.textContent = res.error || 'Something went wrong.';
        feedback.className = 'form-feedback error';
      }
    } catch (err) {
      feedback.hidden = false;
      feedback.textContent = "Couldn't reach the server. Try again.";
      feedback.className = 'form-feedback error';
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function renderDayCountdown(day) {
  const dayEl = document.getElementById('today-day');
  const barEl = document.getElementById('challenge-progress-bar');

  if (!day) {
    dayEl.textContent = '';
    barEl.style.width = '0%';
    return;
  }

  const remaining = Math.max(0, TOTAL_CHALLENGE_DAYS - day);
  dayEl.textContent = remaining > 0
    ? `Day ${day} of ${TOTAL_CHALLENGE_DAYS} · ${remaining} day${remaining === 1 ? '' : 's'} left`
    : `Day ${day} of ${TOTAL_CHALLENGE_DAYS} · Final day!`;
  barEl.style.width = Math.min(100, (day / TOTAL_CHALLENGE_DAYS) * 100) + '%';
}

// ====== SQUAD FLAME GAUGE & CELEBRATION FX ======

function renderSquadGauge(rows) {
  const card = document.getElementById('squad-gauge-card');
  const bar = document.getElementById('squad-gauge-bar');
  const countEl = document.getElementById('squad-gauge-count');
  const pctEl = document.getElementById('squad-gauge-pct');
  const badge = document.getElementById('squad-heatwave-badge');
  if (!card || !bar) return;

  const readCount = rows.filter(r => r.readToday).length;
  const total = rows.length || 13;
  const pct = Math.round((readCount / total) * 100);

  bar.style.width = pct + '%';
  countEl.textContent = `${readCount} / ${total} Youth Read Today`;
  pctEl.textContent = `${pct}%`;

  if (readCount === total && total > 0) {
    card.classList.add('heatwave-active');
    badge.hidden = false;
  } else {
    card.classList.remove('heatwave-active');
    badge.hidden = true;
  }
}

function celebrate(big) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Haptic vibration feedback for mobile
  if ('vibrate' in navigator) {
    try { navigator.vibrate([30, 50, 30]); } catch (e) {}
  }

  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const count = big ? 110 : 60;
  const emojis = ['🔥', '✝️', '👑', '✨', '⚡'];
  const colors = ['#E8A93B', '#E4685D', '#6FAE8C', '#5B8DEF', '#C77DFF', '#4CC9C0'];
  const particles = [];

  for (let i = 0; i < count; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * (big ? 400 : 200),
      y: canvas.height * 0.4 + (Math.random() - 0.5) * 100,
      vx: (Math.random() - 0.5) * (big ? 14 : 9),
      vy: -(Math.random() * (big ? 16 : 10) + 4),
      rot: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
      emoji: Math.random() > 0.35 ? emojis[Math.floor(Math.random() * emojis.length)] : null,
      size: Math.random() * 12 + 12,
      opacity: 1
    });
  }

  let startTime = null;
  const duration = big ? 3200 : 2000;

  function animate(timestamp) {
    if (!startTime) startTime = timestamp;
    const progress = timestamp - startTime;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.4; // gravity
      p.rot += p.vRot;
      p.opacity = Math.max(0, 1 - progress / duration);

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);

      if (p.emoji) {
        ctx.font = `${p.size * 1.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.emoji, 0, 0);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    });

    if (progress < duration) {
      requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(animate);
}

function computeAchievements(row) {
  const badges = [];
  // Time-based badges (Early Bird, Night Owl, Clutch Finish) only apply if read today AND within the current calendar day
  if (row.readToday && row.todayTimestamp) {
    const date = new Date(row.todayTimestamp);
    const now = new Date();
    const isSameDay = date.getDate() === now.getDate() &&
                      date.getMonth() === now.getMonth() &&
                      date.getFullYear() === now.getFullYear();
    if (isSameDay) {
      const h = date.getHours();
      if (h < 8) badges.push({ type: 'early-bird', icon: '🌅', label: 'Early Bird' });
      else if (h >= 22) badges.push({ type: 'night-owl', icon: '🦉', label: 'Night Owl' });
      if (h === 23) badges.push({ type: 'clutch', icon: '⚡', label: 'Clutch Finish' });
    }
  }
  if (row.usedStreakFreeze) {
    badges.push({ type: 'freeze', icon: '🧊', label: 'Streak Preserved' });
  }
  return badges;
}

let lastKnownDaysForMe = null;
const MILESTONE_THRESHOLDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 46, 50, 55, 60, 65, 70, 75, 80, 85, 90, 92];

function checkMilestoneCelebration(daysCompleted) {
  if (lastKnownDaysForMe === null) {
    lastKnownDaysForMe = daysCompleted;
    return;
  }
  if (daysCompleted > lastKnownDaysForMe) {
    const crossed = MILESTONE_THRESHOLDS.some(t => lastKnownDaysForMe < t && daysCompleted >= t);
    if (crossed) celebrate(true);
  }
  lastKnownDaysForMe = daysCompleted;
}

// ====== DATA FETCHING ======

async function loadInitialData(session) {
  const portionEl = document.getElementById('today-portion');
  const dateEl = document.getElementById('today-date');
  const lbBody = document.getElementById('leaderboard-body');
  const lbError = document.getElementById('leaderboard-error');
  const commentsListEl = document.getElementById('comments-list');
  const prayersListEl = document.getElementById('prayers-list');

  try {
    const res = await apiGet({ action: 'getInitialData', username: session.username, password: session.password });
    updateGuestBanner(res.activeGuest, session);

    if (res.today.success) {
      portionEl.textContent = res.today.portion;
      dateEl.textContent = res.today.date;
      currentDayNum = res.today.day;
      renderDayCountdown(res.today.day);
      renderTodayPortionDetail(res.today.portion, res.today.day, session);
    } else {
      portionEl.textContent = "No portion listed for today yet — check back soon.";
      dateEl.textContent = res.today.date || '';
      renderDayCountdown(null);
      renderTodayPortionDetail('', null, session);
    }

    if (res.allPortions && res.allPortions.success) {
      renderReadingSidebar(res.allPortions.portions);
    }

    if (res.nudges && res.nudges.success) {
      currentNudges = res.nudges.nudges || [];
      renderSquadNudgeBanner(currentNudges, session);
    }

    if (res.leaderboard.success) {
      currentLeaderboard = res.leaderboard.leaderboard;
      renderLeaderboard(currentLeaderboard, session);
      renderPlayground(currentLeaderboard);
      updateHeaderLevel(currentLeaderboard, session);
    } else {
      lbBody.innerHTML = '';
      lbError.textContent = res.leaderboard.error || 'Could not load the leaderboard.';
      lbError.hidden = false;
    }

    if (res.recap && res.recap.success) {
      currentWeeklyRecap = res.recap;
      renderWeeklyRecap(res.recap);
    }

    if (res.comments && res.comments.success) {
      commentsCache = res.comments.comments;
      renderComments(session);
      updateCommentFormVisibility(session);
    } else {
      if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Could not load comments.</p>';
    }

    if (res.prayers && res.prayers.success) {
      prayersCache = res.prayers.prayers;
      renderPrayers(session);
      updatePrayerFormVisibility(session);
    } else {
      if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Could not load prayers.</p>';
    }

    if (res.history && res.history.success) {
      renderHeatmap(res.history.history);
    }
  } catch (err) {
    portionEl.textContent = "Couldn't load today's portion. Check your connection.";
    lbBody.innerHTML = '';
    lbError.textContent = "Couldn't reach the server.";
    lbError.hidden = false;
    if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
    if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
  }
}

async function loadUpdates(session) {
  try {
    const res = await apiGet({ action: 'getUpdates', username: session.username, password: session.password });
    updateGuestBanner(res.activeGuest, session);

    if (res.nudges && res.nudges.success) {
      currentNudges = res.nudges.nudges || [];
      renderSquadNudgeBanner(currentNudges, session);
    }

    if (res.leaderboard.success) {
      currentLeaderboard = res.leaderboard.leaderboard;
      renderLeaderboard(currentLeaderboard, session);
      renderPlayground(currentLeaderboard);
      updateHeaderLevel(currentLeaderboard, session);
    }
    if (res.recap && res.recap.success) {
      currentWeeklyRecap = res.recap;
      renderWeeklyRecap(res.recap);
    }
    if (res.comments && res.comments.success) {
      commentsCache = res.comments.comments;
      renderComments(session);
      updateCommentFormVisibility(session);
    }
    if (res.prayers && res.prayers.success) {
      prayersCache = res.prayers.prayers;
      renderPrayers(session);
      updatePrayerFormVisibility(session);
    }
    if (res.history && res.history.success) {
      renderHeatmap(res.history.history);
    }
  } catch (err) {
    // silent fail during auto-refresh
  }
}

function updateHeaderLevel(leaderboard, session) {
  const me = leaderboard.find(u => u.username === session.username);
  if (me) {
    currentUserData = me;
    const headerLevelEl = document.getElementById('header-user-level');
    if (headerLevelEl) {
      headerLevelEl.className = 'level-badge' + (me.levelTitle.includes('Finisher') ? ' finisher' : '');
      headerLevelEl.textContent = me.levelTitle;
    }
  }
}

// ====== YOUR READING HISTORY (HEATMAP) ======

function renderHeatmap(history) {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!history.length) {
    grid.innerHTML = '<p class="heatmap-loading">No reading days on the calendar yet.</p>';
    return;
  }

  const todayStr = formatDDMMYY(new Date());
  const todayIndex = parseDDMMYY(todayStr);

  history.forEach((day) => {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';

    const status = (day.status || '').trim().toLowerCase();
    const isFuture = parseDDMMYY(day.date) > todayIndex;

    let stateClass, stateLabel;
    if (status === 'yes') { stateClass = 'yes'; stateLabel = 'Read'; }
    else if (status === 'no') { stateClass = 'no'; stateLabel = 'Not read'; }
    else if (isFuture) { stateClass = 'future'; stateLabel = 'Upcoming'; }
    else { stateClass = 'pending'; stateLabel = 'Not marked yet'; }

    cell.classList.add(stateClass);
    cell.title = `${day.date}: ${stateLabel}`;
    grid.appendChild(cell);
  });
}

function parseDDMMYY(str) {
  const [d, m, y] = str.split('/').map(Number);
  return y * 10000 + m * 100 + d;
}

// ====== SECTION 2: LEADERBOARD ======

function badgeFor(daysCompleted) {
  if (daysCompleted >= TOTAL_CHALLENGE_DAYS) return { icon: '🏆', label: 'Finished all 92 days!' };
  if (daysCompleted >= 46) return { icon: '🌟', label: 'Halfway there — 46+ days' };
  if (daysCompleted >= 5) {
    const tier = Math.floor(daysCompleted / 5) * 5;
    return { icon: '🔥', label: tier + '-day milestone' };
  }
  return null;
}

function renderLeaderboard(rows, session) {
  renderSquadGauge(rows);
  const body = document.getElementById('leaderboard-body');
  document.getElementById('leaderboard-error').hidden = true;
  body.innerHTML = '';

  const me = rows.find(r => session && r.username === session.username);
  const meHasReadToday = me && me.readToday;

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const isYou = session && row.username === session.username;
    if (isYou) {
      tr.classList.add('is-you');
      checkMilestoneCelebration(row.daysCompleted);
    }

    const rankTd = document.createElement('td');
    rankTd.className = 'rank-cell';
    let rankBadge = '';
    if (row.rank === 1) rankBadge = ' 🏆';
    else if (row.rank === 2) rankBadge = ' 🥈';
    else if (row.rank === 3) rankBadge = ' 🥉';
    rankTd.textContent = `${row.rank}${rankBadge}`;

    const readerTd = document.createElement('td');
    readerTd.className = 'reader-cell' + (isYou ? ' is-you' : '');

    const nameRow = document.createElement('div');
    nameRow.className = 'reader-name-row';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = row.username;
    nameRow.appendChild(nameSpan);

    if (row.levelTitle) {
      const lvlBadge = createLevelBadgeEl(row.levelTitle);
      nameRow.appendChild(lvlBadge);
    }

    if (isYou) {
      const tag = document.createElement('span');
      tag.className = 'you-tag';
      tag.textContent = 'YOU';
      nameRow.appendChild(tag);
    }

    const badge = badgeFor(row.daysCompleted);
    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'badge-icon';
      badgeEl.textContent = badge.icon;
      badgeEl.title = badge.label;
      nameRow.appendChild(badgeEl);
    }

    // Render achievement badges & streak freeze indicator
    const achievements = computeAchievements(row);
    achievements.forEach((ach) => {
      const achSpan = document.createElement('span');
      achSpan.className = `achievement-badge ${ach.type}`;
      achSpan.textContent = `${ach.icon} ${ach.label}`;
      achSpan.title = ach.label;
      nameRow.appendChild(achSpan);
    });

    // Available Streak Freezes Counter
    if (row.freezesAvailable !== undefined && row.freezesAvailable > 0) {
      const freezeSpan = document.createElement('span');
      freezeSpan.className = 'freezes-left-badge';
      freezeSpan.textContent = `🧊 ${row.freezesAvailable} left`;
      freezeSpan.title = `${row.freezesAvailable} of ${row.maxFreezes || 3} streak freeze(s) available`;
      nameRow.appendChild(freezeSpan);
    }

    // Squad Nudge / Encouragement Ping Action
    if (!row.readToday && !isYou && (!session || !session.isGuest)) {
      const nudgeBtn = document.createElement('button');
      nudgeBtn.type = 'button';
      const isAlreadyNudged = nudgedTargetsToday.has(row.username);
      nudgeBtn.className = 'nudge-btn' + (isAlreadyNudged ? ' nudged' : '');
      nudgeBtn.textContent = isAlreadyNudged ? '⚡ Nudged!' : '⚡ Nudge';
      nudgeBtn.disabled = isAlreadyNudged || !meHasReadToday;
      nudgeBtn.title = meHasReadToday
        ? (isAlreadyNudged ? `You nudged ${row.username} today!` : `Send ${row.username} an encouragement nudge!`)
        : `Finish today's reading to unlock sending nudges!`;
      nudgeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleNudgeUser(row.username, nudgeBtn, session);
      });
      nameRow.appendChild(nudgeBtn);
    }

    // Nudge counter indicator on leaderboard
    const nudgesReceived = currentNudges.filter(n => n.target && n.target.toLowerCase() === row.username.toLowerCase()).length;
    if (nudgesReceived > 0 && !row.readToday) {
      const nudgeTag = document.createElement('span');
      nudgeTag.className = 'nudge-tag';
      nudgeTag.textContent = `⚡ ${nudgesReceived}x`;
      nudgeTag.title = `Received ${nudgesReceived} encouragement nudge(s) today`;
      nameRow.appendChild(nudgeTag);
    }

    readerTd.appendChild(nameRow);

    const streakEl = document.createElement('span');
    streakEl.className = 'reader-streak';
    streakEl.innerHTML = row.streak > 0
      ? `<span class="flame">🔥</span>${row.streak}-day streak`
      : 'No active streak';
    readerTd.appendChild(streakEl);

    const daysTd = document.createElement('td');
    daysTd.className = 'days-cell';
    daysTd.textContent = row.daysCompleted;

    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    const dot = document.createElement('span');
    dot.className = 'status-dot ' + (row.readToday ? 'status-dot--good' : 'status-dot--bad');
    dot.setAttribute('aria-label', row.readToday ? 'Read today' : 'Not read today');
    statusTd.appendChild(dot);

    tr.append(rankTd, readerTd, daysTd, statusTd);
    body.appendChild(tr);
  });
}

// ====== SECTION 3: WEEKLY RECAP STATS ======

function renderWeeklyRecap(recap) {
  if (!recap || !recap.stats) return;

  const select = document.getElementById('recap-week-select');
  if (select && select.children.length === 0) {
    select.innerHTML = '';
    const total = recap.totalWeeks || 14;
    for (let w = 1; w <= total; w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}` + (w === recap.currentWeek ? ' (Current)' : '');
      select.appendChild(opt);
    }
    select.value = recap.weekNum;

    select.addEventListener('change', async (e) => {
      const selectedWeek = parseInt(e.target.value, 10);
      try {
        const res = await apiGet({ action: 'getWeeklyRecap', weekNum: selectedWeek });
        if (res.success) renderWeeklyRecap(res);
      } catch (err) {
        // silent fail
      }
    });
  }

  document.getElementById('recap-title').textContent = `Week ${recap.weekNum} Highlights (Days ${recap.startDayNum}–${recap.endDayNum})`;
  document.getElementById('recap-pct').textContent = `${recap.stats.weeklyCompletionPct}%`;
  
  const topReaders = (recap.stats.topReaders || []).slice(0, 3);
  const topReadersText = topReaders.length > 0
    ? topReaders.join(', ')
    : 'None yet';
  document.getElementById('recap-top-reader').textContent = topReadersText;

  const topStreakText = recap.stats.topStreakHolder && recap.stats.topStreakHolder.streak > 0
    ? `${recap.stats.topStreakHolder.username} (${recap.stats.topStreakHolder.streak}d)`
    : '0 days';
  document.getElementById('recap-top-streak').textContent = topStreakText;

  document.getElementById('recap-total-days').textContent = recap.stats.totalGroupDaysCompleted;
}

// ====== SECTION 4: COMMENTS ======

const REACTIONS = [
  { type: 'heart', emoji: '❤️', label: 'Amen' },
  { type: 'pray', emoji: '🙏', label: 'Praying' },
  { type: 'fire', emoji: '🔥', label: 'On fire' },
  { type: 'laugh', emoji: '😂', label: 'Laugh' },
  { type: 'cross', emoji: '✝️', label: 'Cross' }
];

let commentsCache = [];

function renderComments(session) {
  const listEl = document.getElementById('comments-list');
  listEl.innerHTML = '';

  if (!commentsCache.length) {
    listEl.innerHTML = '<p class="comments-empty">No comments yet today — be the first to share.</p>';
    return;
  }

  commentsCache.forEach((comment) => {
    listEl.appendChild(buildCommentElement(comment, session));
  });
}

function spawnFloatingEmoji(e, emojiSymbol) {
  const particle = document.createElement('div');
  particle.className = 'floating-emoji-particle';
  particle.textContent = emojiSymbol;
  const x = e ? (e.clientX || window.innerWidth / 2) : (window.innerWidth / 2);
  const y = e ? (e.clientY || window.innerHeight / 2) : (window.innerHeight / 2);
  particle.style.left = `${x}px`;
  particle.style.top = `${y}px`;
  particle.style.setProperty('--drift-x', `${(Math.random() - 0.5) * 100}px`);
  particle.style.setProperty('--rot', `${(Math.random() - 0.5) * 50}deg`);
  document.body.appendChild(particle);
  setTimeout(() => particle.remove(), 1200);
}

function createReactionButtonsRow(reactionsData, session, targetUsername) {
  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'comment-reactions';

  const reactionsObj = reactionsData || { heart: [], pray: [], fire: [], laugh: [], cross: [] };

  REACTIONS.forEach(({ type, emoji, label }) => {
    const list = reactionsObj[type] || [];
    const active = session && list.includes(session.username);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-btn' + (active ? ' active' : '');
    btn.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="reaction-count">${list.length}</span>`;

    const tooltip = document.createElement('span');
    tooltip.className = 'reaction-tooltip';
    tooltip.textContent = list.length > 0 ? `Reacted by: ${list.join(', ')}` : label;
    btn.appendChild(tooltip);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (session && session.isGuest) {
        alert('Guest users are in read-only mode.');
        return;
      }
      spawnFloatingEmoji(e, emoji);
      handleReactionClick(targetUsername, type, session, reactionsRow);
    });

    reactionsRow.appendChild(btn);
  });

  return reactionsRow;
}

function handleReactionClick(targetUsername, type, session, reactionsRow) {
  const comment = commentsCache.find(c => c.username === targetUsername);
  if (!comment) return;

  if (!comment.reactions) comment.reactions = { heart: [], pray: [], fire: [], laugh: [], cross: [] };
  const targetObj = comment.reactions;

  const wasActiveInThisType = (targetObj[type] || []).includes(session.username);
  REACTIONS.forEach(r => {
    if (!targetObj[r.type]) targetObj[r.type] = [];
    targetObj[r.type] = targetObj[r.type].filter(u => u !== session.username);
  });
  if (!wasActiveInThisType) {
    targetObj[type].push(session.username);
  }

  const btnEls = reactionsRow.querySelectorAll('.reaction-btn');
  REACTIONS.forEach(({ type: rType, label }, idx) => {
    const btn = btnEls[idx];
    if (!btn) return;
    const rList = targetObj[rType] || [];
    const rActive = rList.includes(session.username);
    btn.classList.toggle('active', rActive);
    const countSpan = btn.querySelector('.reaction-count');
    if (countSpan) countSpan.textContent = rList.length;
    const tooltipSpan = btn.querySelector('.reaction-tooltip');
    if (tooltipSpan) tooltipSpan.textContent = rList.length > 0 ? `Reacted by: ${rList.join(', ')}` : label;
  });

  apiGet({
    action: 'reactComment',
    reactorUsername: session.username,
    password: session.password,
    targetUsername,
    type
  }).catch(() => {});
}

function getCharAndWordCount(text) {
  const chars = text ? text.length : 0;
  const words = text && text.trim() ? text.trim().split(/\s+/).length : 0;
  return `${chars} / 2500 chars (${words} words)`;
}

async function confirmAndDeleteComment(session) {
  if (!session || session.isGuest) return;
  const confirmed = window.confirm('Are you sure you want to delete your comment for today?');
  if (!confirmed) return;

  const deleteBtns = document.querySelectorAll('.comment-delete-btn, .delete-today-comment-btn');
  deleteBtns.forEach(b => {
    b.disabled = true;
    b.textContent = 'Deleting…';
  });

  const feedback = document.getElementById('comment-feedback');
  if (feedback) feedback.hidden = true;

  try {
    const res = await apiGet({
      action: 'deleteComment',
      username: session.username,
      password: session.password
    });

    if (res && res.success) {
      commentsCache = commentsCache.filter(c => c.username !== session.username);
      
      const itemEl = document.querySelector(`.comment-item[data-username="${CSS.escape(session.username)}"]`);
      if (itemEl) {
        itemEl.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
        itemEl.style.opacity = '0';
        itemEl.style.transform = 'scale(0.95)';
        setTimeout(() => {
          itemEl.remove();
          const listEl = document.getElementById('comments-list');
          if (listEl && listEl.querySelectorAll('.comment-item').length === 0) {
            listEl.innerHTML = '<p class="comments-empty">No comments yet today — be the first to share!</p>';
          }
        }, 250);
      }

      updateCommentFormVisibility(session);

      if (feedback) {
        feedback.hidden = false;
        feedback.className = 'form-feedback success';
        feedback.textContent = 'Your comment has been deleted.';
        setTimeout(() => {
          feedback.hidden = true;
        }, 3500);
      }
    } else {
      alert(res?.error || 'Failed to delete comment.');
      deleteBtns.forEach(b => {
        b.disabled = false;
        if (b.classList.contains('delete-today-comment-btn')) {
          b.textContent = '🗑️ Delete My Comment';
        } else {
          b.innerHTML = '🗑️ Delete';
        }
      });
    }
  } catch (err) {
    alert("Couldn't reach server. Please try again.");
    deleteBtns.forEach(b => {
      b.disabled = false;
      if (b.classList.contains('delete-today-comment-btn')) {
        b.textContent = '🗑️ Delete My Comment';
      } else {
        b.innerHTML = '🗑️ Delete';
      }
    });
  }
}

function buildCommentElement(comment, session) {
  const isYou = session && comment.username === session.username;

  const item = document.createElement('div');
  item.className = 'comment-item' + (isYou ? ' is-you' : '');
  item.dataset.username = comment.username;

  const head = document.createElement('div');
  head.className = 'comment-head';

  const author = document.createElement('span');
  author.className = 'comment-author';
  author.textContent = comment.username;

  const authorData = currentLeaderboard.find(u => u.username === comment.username);
  if (authorData && authorData.levelTitle) {
    author.appendChild(createLevelBadgeEl(authorData.levelTitle));
  }

  if (isYou) {
    const tag = document.createElement('span');
    tag.className = 'you-tag';
    tag.textContent = 'YOU';
    author.appendChild(tag);
  }
  head.appendChild(author);

  if (isYou && (!session || !session.isGuest)) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'comment-delete-btn';
    deleteBtn.innerHTML = '🗑️ Delete';
    deleteBtn.title = 'Delete your comment';
    deleteBtn.addEventListener('click', () => {
      confirmAndDeleteComment(session);
    });
    head.appendChild(deleteBtn);
  }

  const text = document.createElement('p');
  text.className = 'comment-text';
  text.textContent = comment.text;

  const reactionsRow = createReactionButtonsRow(comment.reactions, session, comment.username);

  const actionsBar = document.createElement('div');
  actionsBar.className = 'comment-actions-bar';
  actionsBar.appendChild(reactionsRow);

  item.append(head, text, actionsBar);
  return item;
}

function updateCommentFormVisibility(session) {
  const form = document.getElementById('comment-form');
  const alreadyWrap = document.getElementById('comment-already-wrap');
  const alreadyMsg = document.getElementById('comment-already');
  const deleteTodayBtn = document.getElementById('delete-today-comment-btn');
  if (!form || !alreadyWrap) return;

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = 'Guests are in read-only mode — explore and enjoy!';
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  const userComment = session && commentsCache.find(c => c.username === session.username);
  const hasCommented = Boolean(userComment);
  form.hidden = hasCommented;
  alreadyWrap.hidden = !hasCommented;

  if (hasCommented) {
    if (alreadyMsg) alreadyMsg.textContent = "You've shared your thoughts for today — see you back here tomorrow!";
    if (deleteTodayBtn) {
      deleteTodayBtn.hidden = false;
      deleteTodayBtn.disabled = false;
      deleteTodayBtn.textContent = '🗑️ Delete My Comment';
      deleteTodayBtn.onclick = () => {
        confirmAndDeleteComment(session);
      };
    }
  }
}

function wireCommentForm(session) {
  const form = document.getElementById('comment-form');
  const alreadyWrap = document.getElementById('comment-already-wrap');
  const feedback = document.getElementById('comment-feedback');
  const textarea = document.getElementById('comment-input');
  const counterEl = document.getElementById('comment-char-counter');
  if (!form || !alreadyWrap) return;

  if (textarea && counterEl) {
    counterEl.textContent = getCharAndWordCount(textarea.value);
    textarea.addEventListener('input', () => {
      counterEl.textContent = getCharAndWordCount(textarea.value);
    });
  }

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session && session.isGuest) return;
    feedback.hidden = true;
    const text = textarea.value.trim();
    if (!text) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const optimisticComment = { username: session.username, text, reactions: { heart: [], pray: [], fire: [], laugh: [], cross: [] }, replies: [] };
    commentsCache.push(optimisticComment);
    document.getElementById('comments-list').appendChild(buildCommentElement(optimisticComment, session));
    document.querySelector('.comments-empty')?.remove();
    textarea.value = '';
    if (counterEl) counterEl.textContent = getCharAndWordCount('');
    form.hidden = true;
    alreadyWrap.hidden = false;
    updateCommentFormVisibility(session);

    try {
      const res = await apiGet({
        action: 'postComment',
        username: session.username,
        password: session.password,
        text
      });
      if (!res.success) {
        commentsCache = commentsCache.filter(c => c !== optimisticComment);
        renderComments(session);
        form.hidden = false;
        alreadyWrap.hidden = true;
        textarea.value = text;
        if (counterEl) counterEl.textContent = getCharAndWordCount(text);
        feedback.hidden = false;
        feedback.textContent = res.error || 'Something went wrong.';
        feedback.className = 'form-feedback error';
        updateCommentFormVisibility(session);
      }
    } catch (err) {
      commentsCache = commentsCache.filter(c => c !== optimisticComment);
      renderComments(session);
      form.hidden = false;
      alreadyWrap.hidden = true;
      textarea.value = text;
      if (counterEl) counterEl.textContent = getCharAndWordCount(text);
      feedback.hidden = false;
      feedback.textContent = "Couldn't reach the server. Try again.";
      feedback.className = 'form-feedback error';
      updateCommentFormVisibility(session);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ====== COMMENTS DATE SEARCH ======

function initCommentsDateSearch(session) {
  const picker = document.getElementById('comments-date-picker');
  const todayBtn = document.getElementById('comments-today-btn');
  if (!picker) return;

  const todayIso = formatISODate(new Date());
  picker.max = todayIso;
  picker.min = '2026-08-10';
  picker.value = todayIso;
  activeCommentsDate = formatDDMMYY(new Date());

  picker.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!val) return;
    if (val > todayIso) {
      alert("Time travel currently impossible, please stick to your current timeline!");
      picker.value = todayIso;
      return;
    }
    const ddmmyy = parseISODateToDDMMYY(val);
    activeCommentsDate = ddmmyy;
    await fetchCommentsForDate(ddmmyy, session);
  });

  if (todayBtn) {
    todayBtn.addEventListener('click', async () => {
      picker.value = todayIso;
      activeCommentsDate = formatDDMMYY(new Date());
      await fetchCommentsForDate(activeCommentsDate, session);
    });
  }
}

async function fetchCommentsForDate(ddmmyy, session) {
  const listEl = document.getElementById('comments-list');
  const titleEl = document.getElementById('comments-section-title');
  const form = document.getElementById('comment-form');
  const alreadyWrap = document.getElementById('comment-already-wrap');
  const alreadyMsg = document.getElementById('comment-already');
  const deleteBtn = document.getElementById('delete-today-comment-btn');

  if (listEl) listEl.innerHTML = '<p class="comments-loading">Loading comments…</p>';

  const todayStr = formatDDMMYY(new Date());
  const isToday = ddmmyy === todayStr;

  if (titleEl) {
    titleEl.textContent = isToday ? "Today's Comments" : `Comments (${ddmmyy})`;
  }

  try {
    const res = await apiGet({ action: 'getComments', date: ddmmyy });
    if (res.success) {
      commentsCache = res.comments || [];
      renderComments(session);
      
      if (!isToday) {
        if (form) form.hidden = true;
        if (alreadyWrap) alreadyWrap.hidden = false;
        if (alreadyMsg) alreadyMsg.textContent = `Viewing comments from ${ddmmyy}. You can post comments for today's reading.`;
        if (deleteBtn) deleteBtn.hidden = true;
      } else {
        updateCommentFormVisibility(session);
      }
    } else {
      if (listEl) listEl.innerHTML = '<p class="comments-empty">Could not load comments for this date.</p>';
    }
  } catch (err) {
    if (listEl) listEl.innerHTML = '<p class="comments-empty">Could not reach the server.</p>';
  }
}

// ====== SECTION 4B: PRAYER & GRATITUDE WALL ======

const PRAYER_REACTIONS_MAP = [
  { key: 'pray', icon: '🙏', label: 'Pray' },
  { key: 'heart', icon: '❤️', label: 'Heart' },
  { key: 'amen', icon: '✨', label: 'Amen' },
  { key: 'strength', icon: '💪', label: 'Strength' },
  { key: 'candle', icon: '🕯️', label: 'Candle' }
];

function initPrayersDateSearch(session) {
  const picker = document.getElementById('prayers-date-picker');
  const todayBtn = document.getElementById('prayers-today-btn');
  if (!picker) return;

  const todayIso = formatISODate(new Date());
  picker.max = todayIso;
  picker.min = '2026-08-10';
  picker.value = todayIso;
  activePrayersDate = formatDDMMYY(new Date());

  picker.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!val) return;
    if (val > todayIso) {
      alert("Time travel currently impossible, please stick to your current timeline!");
      picker.value = todayIso;
      return;
    }
    const ddmmyy = parseISODateToDDMMYY(val);
    activePrayersDate = ddmmyy;
    await fetchPrayersForDate(ddmmyy, session);
  });

  if (todayBtn) {
    todayBtn.addEventListener('click', async () => {
      picker.value = todayIso;
      activePrayersDate = formatDDMMYY(new Date());
      await fetchPrayersForDate(activePrayersDate, session);
    });
  }
}

async function fetchPrayersForDate(ddmmyy, session) {
  const listEl = document.getElementById('prayers-list');
  const titleEl = document.getElementById('prayers-section-title');
  if (listEl) listEl.innerHTML = '<p class="prayers-loading">Loading prayers…</p>';

  const todayStr = formatDDMMYY(new Date());
  if (titleEl) {
    titleEl.textContent = (ddmmyy === todayStr) ? "Prayer & Gratitude Wall" : `Prayer Wall (${ddmmyy})`;
  }

  try {
    const res = await apiGet({ action: 'getPrayers', date: ddmmyy });
    if (res.success) {
      prayersCache = res.prayers || [];
      renderPrayers(session);
      updatePrayerFormVisibility(session);
    } else {
      if (listEl) listEl.innerHTML = '<p class="comments-empty">Could not load prayers for this date.</p>';
    }
  } catch (err) {
    if (listEl) listEl.innerHTML = '<p class="comments-empty">Could not reach the server.</p>';
  }
}

function renderPrayers(session) {
  const listEl = document.getElementById('prayers-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!prayersCache.length) {
    listEl.innerHTML = '<p class="comments-empty">No prayers shared for this day yet. Be the first to share! 🙏</p>';
    return;
  }

  prayersCache.forEach(prayer => {
    listEl.appendChild(buildPrayerElement(prayer, session));
  });
}

function buildPrayerElement(prayer, session) {
  const isYou = session && prayer.username === session.username;
  const item = document.createElement('div');
  item.className = 'prayer-card' + (isYou ? ' is-my-prayer' : '');

  const head = document.createElement('div');
  head.className = 'prayer-header';

  const authorInfo = document.createElement('div');
  authorInfo.className = 'prayer-author-info';

  const avatar = document.createElement('div');
  avatar.className = 'prayer-avatar';
  avatar.textContent = (prayer.username || '?').charAt(0).toUpperCase();
  authorInfo.appendChild(avatar);

  const authorName = document.createElement('span');
  authorName.className = 'prayer-author';
  authorName.textContent = prayer.username;
  authorInfo.appendChild(authorName);

  const authorData = currentLeaderboard.find(u => u.username === prayer.username);
  if (authorData && authorData.levelTitle) {
    authorInfo.appendChild(createLevelBadgeEl(authorData.levelTitle));
  }

  if (isYou) {
    const tag = document.createElement('span');
    tag.className = 'you-tag';
    tag.textContent = 'YOU';
    authorInfo.appendChild(tag);
  }

  head.appendChild(authorInfo);

  if (prayer.timestamp) {
    const timeSpan = document.createElement('span');
    timeSpan.className = 'prayer-time';
    try {
      const dt = new Date(prayer.timestamp);
      timeSpan.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch(e) {}
    head.appendChild(timeSpan);
  }

  const text = document.createElement('p');
  text.className = 'prayer-text';
  text.textContent = prayer.text;

  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'prayer-reactions';

  PRAYER_REACTIONS_MAP.forEach(reaction => {
    const usersWhoReacted = (prayer.reactions && prayer.reactions[reaction.key]) || [];
    const count = usersWhoReacted.length;
    const hasReacted = session && usersWhoReacted.includes(session.username);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'prayer-reaction-chip' + (hasReacted ? ' active' : '');
    chip.innerHTML = `<span>${reaction.icon}</span><span>${count > 0 ? count : ''}</span>`;
    
    // Tooltip listing exactly who reacted on hover
    if (count > 0) {
      chip.title = `${reaction.label} by: ${usersWhoReacted.join(', ')}`;
    } else {
      chip.title = `${reaction.label}`;
    }

    if (session && !session.isGuest) {
      chip.addEventListener('click', () => {
        togglePrayerReaction(prayer.username, reaction.key, session);
      });
    } else {
      chip.disabled = true;
    }

    reactionsRow.appendChild(chip);
  });

  item.append(head, text, reactionsRow);
  return item;
}

async function togglePrayerReaction(targetUsername, type, session) {
  if (session && session.isGuest) return;
  const prayer = prayersCache.find(p => p.username === targetUsername);
  if (!prayer) return;

  if (!prayer.reactions) prayer.reactions = { pray: [], heart: [], amen: [], strength: [], candle: [] };
  const targetList = prayer.reactions[type] || [];
  const idx = targetList.indexOf(session.username);

  // Optimistic UI update
  PRAYER_REACTIONS_MAP.forEach(r => {
    if (!prayer.reactions[r.key]) prayer.reactions[r.key] = [];
    const i = prayer.reactions[r.key].indexOf(session.username);
    if (i !== -1) prayer.reactions[r.key].splice(i, 1);
  });

  if (idx === -1) {
    prayer.reactions[type].push(session.username);
  }
  renderPrayers(session);

  try {
    await apiGet({
      action: 'reactPrayer',
      reactorUsername: session.username,
      password: session.password,
      targetUsername: targetUsername,
      type: type,
      date: activePrayersDate || formatDDMMYY(new Date())
    });
  } catch(err) {
    // silent fail
  }
}

function updatePrayerFormVisibility(session) {
  const form = document.getElementById('prayer-form');
  const alreadyWrap = document.getElementById('prayer-already-wrap');
  const alreadyMsg = document.getElementById('prayer-already');
  const deleteBtn = document.getElementById('delete-today-prayer-btn');
  if (!form || !alreadyWrap) return;

  const isToday = !activePrayersDate || activePrayersDate === formatDDMMYY(new Date());

  if (!isToday) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = `Viewing prayers from ${activePrayersDate}. You can share prayers for today.`;
    if (deleteBtn) deleteBtn.hidden = true;
    return;
  }

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = 'Guests are in read-only mode — explore and enjoy!';
    if (deleteBtn) deleteBtn.hidden = true;
    return;
  }

  const userPrayer = session && prayersCache.find(p => p.username === session.username);
  const hasPrayed = Boolean(userPrayer);
  form.hidden = hasPrayed;
  alreadyWrap.hidden = !hasPrayed;

  if (hasPrayed) {
    if (alreadyMsg) alreadyMsg.textContent = "You've shared your prayer for today — thank you for blessing the squad!";
    if (deleteBtn) {
      deleteBtn.hidden = false;
      deleteBtn.disabled = false;
      deleteBtn.textContent = '🗑️ Delete My Prayer';
      deleteBtn.onclick = () => confirmAndDeletePrayer(session);
    }
  }
}

function wirePrayerForm(session) {
  const form = document.getElementById('prayer-form');
  const textarea = document.getElementById('prayer-input');
  const counterEl = document.getElementById('prayer-char-counter');
  const feedback = document.getElementById('prayer-feedback');
  if (!form) return;

  if (textarea && counterEl) {
    counterEl.textContent = getCharAndWordCount(textarea.value);
    textarea.addEventListener('input', () => {
      counterEl.textContent = getCharAndWordCount(textarea.value);
    });
  }

  if (session && session.isGuest) {
    form.hidden = true;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session && session.isGuest) return;
    if (feedback) feedback.hidden = true;
    const text = textarea.value.trim();
    if (!text) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    const optimisticPrayer = {
      username: session.username,
      text,
      timestamp: new Date().toISOString(),
      reactions: { pray: [], heart: [], amen: [], strength: [], candle: [] }
    };
    prayersCache.push(optimisticPrayer);
    renderPrayers(session);
    textarea.value = '';
    if (counterEl) counterEl.textContent = getCharAndWordCount('');
    updatePrayerFormVisibility(session);

    try {
      const res = await apiGet({
        action: 'postPrayer',
        username: session.username,
        password: session.password,
        text
      });
      if (!res.success) {
        prayersCache = prayersCache.filter(p => p !== optimisticPrayer);
        renderPrayers(session);
        updatePrayerFormVisibility(session);
        if (feedback) {
          feedback.hidden = false;
          feedback.textContent = res.error || 'Something went wrong.';
          feedback.className = 'form-feedback error';
        }
      }
    } catch(err) {
      prayersCache = prayersCache.filter(p => p !== optimisticPrayer);
      renderPrayers(session);
      updatePrayerFormVisibility(session);
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = "Couldn't reach server. Please try again.";
        feedback.className = 'form-feedback error';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

async function confirmAndDeletePrayer(session) {
  if (session && session.isGuest) return;
  if (!confirm('Are you sure you want to delete today’s prayer?')) return;

  const prev = [...prayersCache];
  prayersCache = prayersCache.filter(p => p.username !== session.username);
  renderPrayers(session);
  updatePrayerFormVisibility(session);

  try {
    const res = await apiGet({
      action: 'deletePrayer',
      username: session.username,
      password: session.password
    });
    if (!res.success) {
      prayersCache = prev;
      renderPrayers(session);
      updatePrayerFormVisibility(session);
      alert(res.error || 'Could not delete prayer.');
    }
  } catch(err) {
    prayersCache = prev;
    renderPrayers(session);
    updatePrayerFormVisibility(session);
    alert('Server connection error.');
  }
}

// ====== SQUAD NUDGE BANNER & CONTROLLER ======

function initSquadNudgeBanner(session) {
  const dismissBtn = document.getElementById('dismiss-nudge-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      const banner = document.getElementById('squad-nudge-banner');
      if (banner) banner.hidden = true;
    });
  }
}

function renderSquadNudgeBanner(nudges, session) {
  const banner = document.getElementById('squad-nudge-banner');
  const textEl = document.getElementById('squad-nudge-text');
  if (!banner || !textEl || !session || session.isGuest) return;

  const myNudges = (nudges || []).filter(n => n.target && n.target.toLowerCase() === session.username.toLowerCase());
  if (myNudges.length > 0) {
    const senders = [...new Set(myNudges.map(n => n.sender))];
    const sendersStr = senders.join(', ');
    textEl.textContent = `⚡ ${sendersStr} ${senders.length > 1 ? 'have' : 'has'} nudged you to finish today's reading portion!`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

async function handleNudgeUser(targetUsername, btnEl, session) {
  if (btnEl.disabled || session.isGuest) return;
  btnEl.disabled = true;
  btnEl.classList.add('nudged');
  btnEl.textContent = '⚡ Nudged!';
  nudgedTargetsToday.add(targetUsername);

  try {
    const res = await apiGet({
      action: 'nudgeUser',
      senderUsername: session.username,
      password: session.password,
      targetUsername: targetUsername
    });
    if (!res.success) {
      btnEl.textContent = '⚡ Nudge';
      btnEl.disabled = false;
      btnEl.classList.remove('nudged');
      nudgedTargetsToday.delete(targetUsername);
    }
  } catch (err) {
    // silent fail
  }
}

// ====== SECTION 5: PROGRESS PLAYGROUND ======

const USER_COLORS = {
  'Elisha': '#E8A93B',
  'Daysel': '#E4685D',
  'Dechen': '#6FAE8C',
  'Ducks Fartbomber': '#5B8DEF',
  'Guptaji': '#C77DFF',
  'Jason': '#4CC9C0',
  'Nim Nim': '#F4A6C6',
  'Paulz': '#F2C14E',
  'Puia': '#8FBF4D',
  'Victor': '#64B5F6',
  'Vishan': '#9D6FD9',
  'Yutso': '#D9A066',
  'Yeshi': '#B2495C'
};
const FALLBACK_COLOR = '#8892B0';
const CIRCLE_MIN = 52;
const CIRCLE_MAX = 132;

function colorFor(username) {
  return USER_COLORS[username] || FALLBACK_COLOR;
}

function circleSizeFor(daysCompleted) {
  const fraction = Math.max(0, Math.min(1, daysCompleted / TOTAL_CHALLENGE_DAYS));
  return CIRCLE_MIN + (CIRCLE_MAX - CIRCLE_MIN) * fraction;
}

const playgroundCircles = new Map();

function renderPlayground(rows) {
  const container = document.getElementById('playground');
  if (!container) return;

  rows.forEach((row, i) => {
    const size = circleSizeFor(row.daysCompleted);
    let entry = playgroundCircles.get(row.username);

    if (!entry) {
      const el = document.createElement('div');
      el.className = 'playground-circle';
      el.style.background = colorFor(row.username);
      el.innerHTML = `<span class="circle-name">${escapeHtml(row.username)}</span><span class="circle-days">${row.daysCompleted}</span>`;

      const pos = initialPlaygroundPosition(container, i, rows.length, size);
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;

      makeDraggable(el, container);
      container.appendChild(el);

      entry = { el, x: pos.x, y: pos.y, size };
      playgroundCircles.set(row.username, entry);
    } else {
      entry.el.style.width = size + 'px';
      entry.el.style.height = size + 'px';
      entry.el.querySelector('.circle-days').textContent = row.daysCompleted;
      entry.size = size;
    }
  });
}

function initialPlaygroundPosition(container, index, total, size) {
  const w = container.clientWidth || 320;
  const h = container.clientHeight || 320;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const cellW = w / cols;
  const cellH = h / rows;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const jitterX = (Math.random() - 0.5) * cellW * 0.3;
  const jitterY = (Math.random() - 0.5) * cellH * 0.3;

  const x = clamp(col * cellW + cellW / 2 - size / 2 + jitterX, 0, w - size);
  const y = clamp(row * cellH + cellH / 2 - size / 2 + jitterY, 0, h - size);
  return { x, y };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function makeDraggable(el, container) {
  let dragging = false;
  let startPointerX = 0, startPointerY = 0, startX = 0, startY = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    const transform = new DOMMatrix(getComputedStyle(el).transform);
    startX = transform.m41;
    startY = transform.m42;
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const size = el.offsetWidth;
    const dx = e.clientX - startPointerX;
    const dy = e.clientY - startPointerY;
    const x = clamp(startX + dx, 0, container.clientWidth - size);
    const y = clamp(startY + dy, 0, container.clientHeight - size);
    el.style.transform = `translate(${x}px, ${y}px)`;

    const entry = [...playgroundCircles.values()].find(v => v.el === el);
    if (entry) { entry.x = x; entry.y = y; }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

// ====== SHAREABLE DAY-STREAK CARD GENERATOR ======

let lastGeneratedCardBlob = null;
let currentShareTheme = 'midnight';
let currentShareStickers = new Set(['on_fire', 'squad_read']);
let activeShareSession = null;

function refreshSharePreview() {
  if (!activeShareSession) return;
  openShareModal(activeShareSession);
}

function wireShareTodayButton(session) {
  const btn = document.getElementById('share-progress-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    openShareModal(session);
  });
}

function initShareModal() {
  const modal = document.getElementById('share-modal');
  const closeBtn = document.getElementById('close-share-modal');
  const downloadBtn = document.getElementById('download-card-btn');
  const shareBtn = document.getElementById('native-share-btn');

  closeBtn.addEventListener('click', () => modal.hidden = true);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  const themeBtns = document.querySelectorAll('#theme-chip-group .chip-btn');
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      themeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentShareTheme = btn.dataset.theme;
      refreshSharePreview();
    });
  });

  const stickerBoxes = document.querySelectorAll('#sticker-chip-group input[type="checkbox"]');
  stickerBoxes.forEach(box => {
    box.addEventListener('change', () => {
      if (box.checked) currentShareStickers.add(box.value);
      else currentShareStickers.delete(box.value);
      refreshSharePreview();
    });
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastGeneratedCardBlob) return;
    const url = URL.createObjectURL(lastGeneratedCardBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ProjectBible_Streak_Day${currentUserData ? currentUserData.daysCompleted : 0}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  shareBtn.addEventListener('click', async () => {
    if (!lastGeneratedCardBlob) return;
    const filename = `ProjectBible_Streak_Day${currentUserData ? currentUserData.daysCompleted : 0}.png`;
    const file = new File([lastGeneratedCardBlob], filename, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: 'Project Bible in 92 Days',
          text: `Day ${currentUserData ? currentUserData.daysCompleted : 0}/92 🔥 — Reading accountability with The Youth Gathering!`,
          files: [file]
        });
      } catch (err) {
        // User cancelled share
      }
    } else {
      alert('Direct image sharing is not supported on this browser. Use "Download PNG" to save the image!');
    }
  });
}

async function openShareModal(session) {
  activeShareSession = session;
  const modal = document.getElementById('share-modal');
  const previewImg = document.getElementById('share-card-preview');

  const me = currentLeaderboard.find(u => u.username === session.username) || {
    username: session.username,
    levelTitle: 'Disciple I',
    daysCompleted: 0,
    streak: 0
  };

  const canvas = generateShareCardCanvas(me, currentShareTheme, currentShareStickers);
  canvas.toBlob((blob) => {
    lastGeneratedCardBlob = blob;
    previewImg.src = URL.createObjectURL(blob);
    modal.hidden = false;
  }, 'image/png');
}

const CARD_THEMES = {
  midnight: { bg1: '#14162B', bg2: '#1E2140', accent: '#E8A93B', text: '#F6EFE1', border: 'rgba(232, 169, 59, 0.4)' },
  neon: { bg1: '#0f051d', bg2: '#2a0845', accent: '#00f2fe', text: '#ffffff', border: 'rgba(0, 242, 254, 0.5)' },
  vaporwave: { bg1: '#1f0036', bg2: '#4b0082', accent: '#ff71ce', text: '#fbf5ff', border: 'rgba(255, 113, 206, 0.5)' },
  cyberpunk: { bg1: '#0d0d0d', bg2: '#1f1f1f', accent: '#ffe600', text: '#ffffff', border: 'rgba(255, 230, 0, 0.5)' }
};

function generateShareCardCanvas(userData, themeKey = 'midnight', stickers = new Set()) {
  const theme = CARD_THEMES[themeKey] || CARD_THEMES.midnight;

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext('2d');

  const username = userData.username || 'Reader';
  const levelTitle = (userData.levelTitle || 'Disciple I').toUpperCase();
  const days = userData.daysCompleted || 0;
  const streak = userData.streak || 0;

  // Background Gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 1200, 675);
  bgGradient.addColorStop(0, theme.bg1);
  bgGradient.addColorStop(1, theme.bg2);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, 1200, 675);

  // Outer Border & Corner Accents
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 12;
  ctx.strokeRect(30, 30, 1140, 615);

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(45, 45, 1110, 585);

  // Top Eyebrow
  ctx.fillStyle = theme.accent;
  ctx.font = '600 24px "Space Grotesk", sans-serif';
  ctx.letterSpacing = '4px';
  ctx.fillText('THE YOUTH GATHERING 2026', 90, 110);

  // Main Header Title
  ctx.fillStyle = theme.text;
  ctx.font = '700 58px "Fraunces", Georgia, serif';
  ctx.fillText('Project Bible in 92 Days', 90, 185);

  // Ribbon line under title
  ctx.fillStyle = theme.accent;
  ctx.fillRect(90, 210, 120, 8);

  // User Name
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 54px "Space Grotesk", sans-serif';
  ctx.fillText(username, 90, 310);

  // Level Pill Badge
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  const levelWidth = ctx.measureText(levelTitle).width + 40;
  roundRect(ctx, 90, 340, Math.max(160, levelWidth), 46, 23, true, true);

  ctx.fillStyle = theme.accent;
  ctx.font = '700 22px "Space Grotesk", sans-serif';
  ctx.fillText(levelTitle, 110, 371);

  // Streak Pill Badge
  const streakText = `🔥 ${streak}-DAY STREAK`;
  const streakWidth = ctx.measureText(streakText).width + 40;
  const streakX = 90 + Math.max(160, levelWidth) + 20;

  ctx.fillStyle = 'rgba(228, 104, 93, 0.22)';
  ctx.strokeStyle = '#E4685D';
  ctx.lineWidth = 2;
  roundRect(ctx, streakX, 340, Math.max(180, streakWidth), 46, 23, true, true);

  ctx.fillStyle = '#E4685D';
  ctx.font = '700 22px "Space Grotesk", sans-serif';
  ctx.fillText(streakText, streakX + 20, 371);

  // Dynamic Stickers Row
  const STICKER_LABELS = {
    on_fire: '🔥 ON FIRE',
    squad_read: '🛡️ SQUAD READ',
    night_owl: '🦉 NIGHT OWL',
    clutch: '⚡ CLUTCH'
  };

  let stickerOffsetX = 90;
  stickers.forEach((sKey) => {
    const sText = STICKER_LABELS[sKey];
    if (!sText) return;
    ctx.font = '700 18px "Space Grotesk", sans-serif';
    const sWidth = ctx.measureText(sText).width + 30;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, stickerOffsetX, 410, sWidth, 36, 18, true, true);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(sText, stickerOffsetX + 15, 434);
    stickerOffsetX += sWidth + 14;
  });

  // Subtitle / Encouragement quote
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.font = '400 24px "Fraunces", serif';
  ctx.fillText('"Holding each other accountable in God\'s Word day by day."', 90, 485);

  // --- PROGRESS RING ARC (RIGHT SIDE) ---
  const cx = 930;
  const cy = 340;
  const radius = 125;

  // Background Ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 22;
  ctx.stroke();

  // Progress Arc
  const progressRatio = Math.min(1, Math.max(0, days / TOTAL_CHALLENGE_DAYS));
  const startAngle = -0.5 * Math.PI;
  const endAngle = startAngle + (progressRatio * 2 * Math.PI);

  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 22;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center Text inside Ring
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 68px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(days), cx, cy + 10);

  ctx.fillStyle = theme.accent;
  ctx.font = '600 22px "Space Grotesk", sans-serif';
  ctx.fillText(`OF ${TOTAL_CHALLENGE_DAYS} DAYS`, cx, cy + 50);
  ctx.textAlign = 'left';

  // Bottom Footer
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '500 22px "Space Grotesk", sans-serif';
  ctx.fillText('tg.youth_ · Instagram', 90, 580);

  ctx.fillStyle = theme.accent;
  ctx.font = '600 22px "Space Grotesk", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('92 Days Challenge', 1110, 580);
  ctx.textAlign = 'left';

  return canvas;
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// ==================== BIBLE READER & PORTION DETAIL ENGINE ====================

const BIBLE_BOOKS = [
  { id: 1, name: 'Genesis', abbr: 'Gen', aliases: ['genesis', 'gen', 'gn'] },
  { id: 2, name: 'Exodus', abbr: 'Exo', aliases: ['exodus', 'exo', 'ex'] },
  { id: 3, name: 'Leviticus', abbr: 'Lev', aliases: ['leviticus', 'lev', 'lv'] },
  { id: 4, name: 'Numbers', abbr: 'Num', aliases: ['numbers', 'num', 'nm'] },
  { id: 5, name: 'Deuteronomy', abbr: 'Deu', aliases: ['deuteronomy', 'deu', 'deut', 'dt'] },
  { id: 6, name: 'Joshua', abbr: 'Jos', aliases: ['joshua', 'jos', 'josh'] },
  { id: 7, name: 'Judges', abbr: 'Jdg', aliases: ['judges', 'jdg', 'judg'] },
  { id: 8, name: 'Ruth', abbr: 'Rut', aliases: ['ruth', 'rut', 'ru'] },
  { id: 9, name: '1 Samuel', abbr: '1Sa', aliases: ['1 samuel', '1 sam', '1 sa', '1samuel', '1sam'] },
  { id: 10, name: '2 Samuel', abbr: '2Sa', aliases: ['2 samuel', '2 sam', '2 sa', '2samuel', '2sam'] },
  { id: 11, name: '1 Kings', abbr: '1Ki', aliases: ['1 kings', '1 kgs', '1 ki', '1kings', '1kgs', '1ki'] },
  { id: 12, name: '2 Kings', abbr: '2Ki', aliases: ['2 kings', '2 kgs', '2 ki', '2kings', '2kgs', '2ki'] },
  { id: 13, name: '1 Chronicles', abbr: '1Ch', aliases: ['1 chronicles', '1 chron', '1 chr', '1 ch', '1chronicles', '1chr'] },
  { id: 14, name: '2 Chronicles', abbr: '2Ch', aliases: ['2 chronicles', '2 chron', '2 chr', '2 ch', '2chronicles', '2chr'] },
  { id: 15, name: 'Ezra', abbr: 'Ezr', aliases: ['ezra', 'ezr'] },
  { id: 16, name: 'Nehemiah', abbr: 'Neh', aliases: ['nehemiah', 'neh', 'ne'] },
  { id: 17, name: 'Esther', abbr: 'Est', aliases: ['esther', 'est'] },
  { id: 18, name: 'Job', abbr: 'Job', aliases: ['job', 'jb'] },
  { id: 19, name: 'Psalms', abbr: 'Psa', aliases: ['psalms', 'psalm', 'psa', 'ps', 'pss'] },
  { id: 20, name: 'Proverbs', abbr: 'Pro', aliases: ['proverbs', 'proverb', 'pro', 'prov', 'prv', 'pr'] },
  { id: 21, name: 'Ecclesiastes', abbr: 'Ecc', aliases: ['ecclesiastes', 'eccl', 'ecc', 'ec'] },
  { id: 22, name: 'Song of Solomon', abbr: 'Sng', aliases: ['song of solomon', 'song of songs', 'song', 'sos', 'canticles'] },
  { id: 23, name: 'Isaiah', abbr: 'Isa', aliases: ['isaiah', 'isa', 'is'] },
  { id: 24, name: 'Jeremiah', abbr: 'Jer', aliases: ['jeremiah', 'jer', 'je'] },
  { id: 25, name: 'Lamentations', abbr: 'Lam', aliases: ['lamentations', 'lam', 'la'] },
  { id: 26, name: 'Ezekiel', abbr: 'Ezk', aliases: ['ezekiel', 'ezk', 'eze', 'ez'] },
  { id: 27, name: 'Daniel', abbr: 'Dan', aliases: ['daniel', 'dan', 'da'] },
  { id: 28, name: 'Hosea', abbr: 'Hos', aliases: ['hosea', 'hos', 'ho'] },
  { id: 29, name: 'Joel', abbr: 'Jol', aliases: ['joel', 'jol', 'joe', 'jl'] },
  { id: 30, name: 'Amos', abbr: 'Amo', aliases: ['amos', 'amo', 'am'] },
  { id: 31, name: 'Obadiah', abbr: 'Oba', aliases: ['obadiah', 'oba', 'ob'] },
  { id: 32, name: 'Jonah', abbr: 'Jon', aliases: ['jonah', 'jon', 'jnh'] },
  { id: 33, name: 'Micah', abbr: 'Mic', aliases: ['micah', 'mic', 'mc'] },
  { id: 34, name: 'Nahum', abbr: 'Nah', aliases: ['nahum', 'nah', 'na'] },
  { id: 35, name: 'Habakkuk', abbr: 'Hab', aliases: ['habakkuk', 'hab', 'hb'] },
  { id: 36, name: 'Zephaniah', abbr: 'Zep', aliases: ['zephaniah', 'zep', 'ze'] },
  { id: 37, name: 'Haggai', abbr: 'Hag', aliases: ['haggai', 'hag', 'hg'] },
  { id: 38, name: 'Zechariah', abbr: 'Zec', aliases: ['zechariah', 'zec', 'zech', 'zc'] },
  { id: 39, name: 'Malachi', abbr: 'Mal', aliases: ['malachi', 'mal', 'ml'] },
  { id: 40, name: 'Matthew', abbr: 'Mat', aliases: ['matthew', 'matt', 'mat', 'mt'] },
  { id: 41, name: 'Mark', abbr: 'Mrk', aliases: ['mark', 'mrk', 'mk'] },
  { id: 42, name: 'Luke', abbr: 'Luk', aliases: ['luke', 'luk', 'lk'] },
  { id: 43, name: 'John', abbr: 'Jhn', aliases: ['john', 'jhn', 'jn'] },
  { id: 44, name: 'Acts', abbr: 'Act', aliases: ['acts', 'act', 'ac'] },
  { id: 45, name: 'Romans', abbr: 'Rom', aliases: ['romans', 'rom', 'ro', 'rm'] },
  { id: 46, name: '1 Corinthians', abbr: '1Co', aliases: ['1 corinthians', '1 cor', '1 co', '1corinthians', '1cor'] },
  { id: 47, name: '2 Corinthians', abbr: '2Co', aliases: ['2 corinthians', '2 cor', '2 co', '2corinthians', '2cor'] },
  { id: 48, name: 'Galatians', abbr: 'Gal', aliases: ['galatians', 'gal', 'ga'] },
  { id: 49, name: 'Ephesians', abbr: 'Eph', aliases: ['ephesians', 'eph', 'ep'] },
  { id: 50, name: 'Philippians', abbr: 'Php', aliases: ['philippians', 'phil', 'php', 'pp'] },
  { id: 51, name: 'Colossians', abbr: 'Col', aliases: ['colossians', 'col', 'co'] },
  { id: 52, name: '1 Thessalonians', abbr: '1Th', aliases: ['1 thessalonians', '1 thess', '1 th', '1thessalonians', '1thess'] },
  { id: 53, name: '2 Thessalonians', abbr: '2Th', aliases: ['2 thessalonians', '2 thess', '2 th', '2thessalonians', '2thess'] },
  { id: 54, name: '1 Timothy', abbr: '1Ti', aliases: ['1 timothy', '1 tim', '1 ti', '1timothy', '1tim'] },
  { id: 55, name: '2 Timothy', abbr: '2Ti', aliases: ['2 timothy', '2 tim', '2 ti', '2timothy', '2tim'] },
  { id: 56, name: 'Titus', abbr: 'Tit', aliases: ['titus', 'tit', 'ti'] },
  { id: 57, name: 'Philemon', abbr: 'Phm', aliases: ['philemon', 'phm', 'phlm'] },
  { id: 58, name: 'Hebrews', abbr: 'Heb', aliases: ['hebrews', 'heb', 'he'] },
  { id: 59, name: 'James', abbr: 'Jas', aliases: ['james', 'jas', 'jm'] },
  { id: 60, name: '1 Peter', abbr: '1Pe', aliases: ['1 peter', '1 pet', '1 pe', '1peter', '1pet'] },
  { id: 61, name: '2 Peter', abbr: '2Pe', aliases: ['2 peter', '2 pet', '2 pe', '2peter', '2pet'] },
  { id: 62, name: '1 John', abbr: '1Jn', aliases: ['1 john', '1 jn', '1 jhn', '1john'] },
  { id: 63, name: '2 John', abbr: '2Jn', aliases: ['2 john', '2 jn', '2 jhn', '2john'] },
  { id: 64, name: '3 John', abbr: '3Jn', aliases: ['3 john', '3 jn', '3 jhn', '3john'] },
  { id: 65, name: 'Jude', abbr: 'Jud', aliases: ['jude', 'jud', 'jd'] },
  { id: 66, name: 'Revelation', abbr: 'Rev', aliases: ['revelation', 'revelations', 'rev', 'rv'] }
];

const CURATED_KEY_VERSES = {
  1: { text: "In the beginning God created the heavens and the earth.", ref: "Genesis 1:1" },
  2: { text: "I will make you into a great nation, and I will bless you; I will make your name great, and you will be a blessing.", ref: "Genesis 12:2" },
  3: { text: "You intended to harm me, but God intended it for good to accomplish what is now being done.", ref: "Genesis 50:20" },
  4: { text: "God said to Moses, 'I AM WHO I AM.' This is what you are to say: 'I AM has sent me to you.'", ref: "Exodus 3:14" },
  5: { text: "The Lord will fight for you; you need only to be still.", ref: "Exodus 14:14" },
  6: { text: "The Lord bless you and keep you; the Lord make his face shine on you and be gracious to you.", ref: "Numbers 6:24–25" },
  7: { text: "Love the Lord your God with all your heart and with all your soul and with all your strength.", ref: "Deuteronomy 6:5" },
  8: { text: "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.", ref: "Joshua 1:9" },
  9: { text: "Where you go I will go, and where you stay I will stay. Your people will be my people and your God my God.", ref: "Ruth 1:16" },
  10: { text: "People look at the outward appearance, but the Lord looks at the heart.", ref: "1 Samuel 16:7" },
  15: { text: "Trust in the Lord with all your heart and lean not on your own understanding; in all your ways submit to him, and he will make your paths straight.", ref: "Proverbs 3:5–6" },
  20: { text: "The Lord is my shepherd, I lack nothing. He makes me lie down in green pastures, he leads me beside quiet waters.", ref: "Psalm 23:1–2" },
  25: { text: "For to us a child is born, to us a son is given... And he will be called Wonderful Counselor, Mighty God, Everlasting Father, Prince of Peace.", ref: "Isaiah 9:6" },
  30: { text: "Those who hope in the Lord will renew their strength. They will soar on wings like eagles; they will run and not grow weary.", ref: "Isaiah 40:31" },
  35: { text: "'For I know the plans I have for you,' declares the Lord, 'plans to prosper you and not to harm you, plans to give you hope and a future.'", ref: "Jeremiah 29:11" },
  40: { text: "The steadfast love of the Lord never ceases; his mercies never come to an end; they are new every morning; great is your faithfulness.", ref: "Lamentations 3:22–23" },
  45: { text: "Seek first his kingdom and his righteousness, and all these things will be given to you as well.", ref: "Matthew 6:33" },
  50: { text: "Come to me, all you who are weary and burdened, and I will give you rest.", ref: "Matthew 11:28" },
  55: { text: "For even the Son of Man did not come to be served, but to serve, and to give his life as a ransom for many.", ref: "Mark 10:45" },
  60: { text: "For the Son of Man came to seek and to save the lost.", ref: "Luke 19:10" },
  69: { text: "He is not here; he has risen! Remember how he told you, while he was still with you in Galilee.", ref: "Luke 24:6" },
  70: { text: "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life.", ref: "John 3:16" },
  71: { text: "Believe in the Lord Jesus, and you will be saved—you and your household.", ref: "Acts 16:31" },
  73: { text: "And we know that in all things God works for the good of those who love him, who have been called according to his purpose.", ref: "Romans 8:28" },
  74: { text: "Love is patient, love is kind. It does not envy, it does not boast, it is not proud... Love never fails.", ref: "1 Corinthians 13:4,8" },
  76: { text: "For it is by grace you have been saved, through faith—and this is not from yourselves, it is the gift of God.", ref: "Ephesians 2:8" },
  77: { text: "I can do all this through him who gives me strength.", ref: "Philippians 4:13" },
  80: { text: "Now faith is confidence in what we hope for and assurance about what we do not see.", ref: "Hebrews 11:1" },
  83: { text: "He will wipe every tear from their eyes. There will be no more death or mourning or crying or pain, for the old order of things has passed away.", ref: "Revelation 21:4" }
};

function findBibleBook(name) {
  if (!name) return null;
  const clean = name.trim().toLowerCase().replace(/[.:]/g, '');
  return BIBLE_BOOKS.find(b => 
    b.name.toLowerCase() === clean ||
    b.abbr.toLowerCase() === clean ||
    b.aliases.includes(clean)
  ) || null;
}

function parsePassage(portionText) {
  if (!portionText || typeof portionText !== 'string') return { chapters: [], totalChapters: 0, isCatchUp: false };
  const str = portionText.trim();
  if (str.toLowerCase().includes('catch-up')) {
    return { chapters: [], totalChapters: 0, isCatchUp: true };
  }

  const segments = str.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  const chapters = [];

  segments.forEach(seg => {
    const match = seg.match(/^((?:\d\s+)?[A-Za-z\s]+?)(?:\s+(\d+)(?:\s*[\u2013\u2014\-]\s*(\d+))?)?$/);
    if (!match) return;

    const rawBook = match[1].trim();
    const startCh = match[2] ? parseInt(match[2], 10) : 1;
    const endCh = match[3] ? parseInt(match[3], 10) : startCh;

    const bookObj = findBibleBook(rawBook);
    if (!bookObj) return;

    for (let c = startCh; c <= endCh; c++) {
      chapters.push({
        bookName: bookObj.name,
        bookId: bookObj.id,
        abbr: bookObj.abbr,
        chapter: c,
        label: `${bookObj.abbr} ${c}`
      });
    }
  });

  return {
    chapters,
    totalChapters: chapters.length,
    isCatchUp: false
  };
}

function getKeyVerseForPortion(portionText, dayNum) {
  if (dayNum && CURATED_KEY_VERSES[dayNum]) {
    return CURATED_KEY_VERSES[dayNum];
  }
  const parsed = parsePassage(portionText);
  if (parsed.isCatchUp) {
    return {
      text: "Be still, and know that I am God; I will be exalted among the nations, I will be exalted in the earth.",
      ref: "Psalm 46:10"
    };
  }
  if (parsed.chapters.length > 0) {
    const first = parsed.chapters[0];
    const last = parsed.chapters[parsed.chapters.length - 1];
    return {
      text: `Daily reading from ${first.bookName} chapter ${first.chapter} through ${last.bookName} chapter ${last.chapter}.`,
      ref: `${first.bookName} ${first.chapter}`
    };
  }
  return {
    text: "Your word is a lamp to my feet and a light to my path.",
    ref: "Psalm 119:105"
  };
}

let readerChapterCache = {};
let activeReaderPortion = null;
let activeReaderDay = null;
let activeReaderVersion = localStorage.getItem('bible_reader_version') || 'NIV';
let activeReaderFontSize = parseFloat(localStorage.getItem('bible_reader_font_size')) || 1.05;

function initScriptureReader(session) {
  const modal = document.getElementById('reader-modal');
  const backdrop = document.getElementById('reader-modal-backdrop');
  const closeBtn = document.getElementById('close-reader-btn');
  const versionSelect = document.getElementById('bible-version-select');
  const fontDecBtn = document.getElementById('reader-font-decrease');
  const fontIncBtn = document.getElementById('reader-font-increase');
  const markReadBtn = document.getElementById('reader-mark-read-btn');
  const openTodayBtn = document.getElementById('open-today-reader-btn');

  if (versionSelect) {
    versionSelect.value = activeReaderVersion;
    versionSelect.addEventListener('change', (e) => {
      activeReaderVersion = e.target.value;
      localStorage.setItem('bible_reader_version', activeReaderVersion);
      if (activeReaderPortion) {
        renderReaderPassageContent(activeReaderPortion, activeReaderVersion);
      }
    });
  }

  const applyFontSize = () => {
    const contentEl = document.getElementById('reader-content');
    if (contentEl) {
      contentEl.style.setProperty('--reader-font-size', `${activeReaderFontSize}rem`);
      localStorage.setItem('bible_reader_font_size', String(activeReaderFontSize));
    }
  };

  if (fontDecBtn) {
    fontDecBtn.addEventListener('click', () => {
      if (activeReaderFontSize > 0.85) {
        activeReaderFontSize = Math.round((activeReaderFontSize - 0.1) * 100) / 100;
        applyFontSize();
      }
    });
  }

  if (fontIncBtn) {
    fontIncBtn.addEventListener('click', () => {
      if (activeReaderFontSize < 1.45) {
        activeReaderFontSize = Math.round((activeReaderFontSize + 0.1) * 100) / 100;
        applyFontSize();
      }
    });
  }

  const closeModal = () => {
    if (!modal || !backdrop) return;
    stopAudioPlayback();
    modal.classList.remove('active');
    backdrop.classList.remove('active');
    setTimeout(() => {
      modal.hidden = true;
      backdrop.hidden = true;
    }, 300);
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      closeModal();
    }
  });

  if (markReadBtn) {
    markReadBtn.addEventListener('click', async () => {
      if (!session || session.isGuest) {
        alert('Guest users are in read-only mode.');
        return;
      }

      // Check for future dates
      let isFuture = false;
      if (activeReaderDay !== null && activeReaderDay !== undefined) {
        if (currentDayNum !== null && currentDayNum !== undefined) {
          if (activeReaderDay > currentDayNum) {
            isFuture = true;
          }
        } else {
          const targetDateObj = new Date(2000 + CHALLENGE_START.y, CHALLENGE_START.m - 1, CHALLENGE_START.d + (activeReaderDay - 1));
          const now = new Date();
          now.setHours(23, 59, 59, 999);
          if (targetDateObj > now) {
            isFuture = true;
          }
        }
      }

      if (isFuture) {
        alert("Time travel currently impossible, please stick to your current timeline!");
        return;
      }

      markReadBtn.disabled = true;
      markReadBtn.textContent = 'Updating…';

      let targetDate;
      if (activeReaderDay !== null && activeReaderDay !== undefined) {
        const targetDateObj = new Date(2000 + CHALLENGE_START.y, CHALLENGE_START.m - 1, CHALLENGE_START.d + (activeReaderDay - 1));
        targetDate = formatDDMMYY(targetDateObj);
      } else {
        const dateSelect = document.getElementById('date-select');
        targetDate = dateSelect ? dateSelect.value : formatDDMMYY(new Date());
      }

      try {
        const res = await apiGet({
          action: 'updateStatus',
          username: session.username,
          password: session.password,
          date: targetDate,
          status: 'Read'
        });

        if (res.success) {
          markReadBtn.textContent = '✓ Marked as Read!';
          celebrate(true);
          loadUpdates(session);
        } else {
          alert(res.error || 'Failed to update status.');
          markReadBtn.disabled = false;
          markReadBtn.textContent = (activeReaderDay && activeReaderDay === currentDayNum) || !activeReaderDay
            ? '✓ Mark Today as Read'
            : `✓ Mark Day ${activeReaderDay} as Read`;
        }
      } catch (err) {
        alert("Couldn't reach the server. Please try again.");
        markReadBtn.disabled = false;
        markReadBtn.textContent = (activeReaderDay && activeReaderDay === currentDayNum) || !activeReaderDay
          ? '✓ Mark Today as Read'
          : `✓ Mark Day ${activeReaderDay} as Read`;
      }
    });
  }

  if (openTodayBtn) {
    openTodayBtn.addEventListener('click', () => {
      const portionText = document.getElementById('today-portion')?.textContent || '';
      openReaderModal({ portion: portionText, day: currentDayNum });
    });
  }

  applyFontSize();
}

async function fetchChapterFromApi(version, bookId, chapter) {
  const cacheKey = `${version}_${bookId}_${chapter}`;
  if (readerChapterCache[cacheKey]) {
    return readerChapterCache[cacheKey];
  }

  try {
    const res = await fetch(`https://bolls.life/get-chapter/${encodeURIComponent(version)}/${bookId}/${chapter}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      readerChapterCache[cacheKey] = data;
      return data;
    }
    throw new Error('Empty chapter response');
  } catch (err) {
    if (version !== 'WEB') {
      try {
        const fallbackRes = await fetch(`https://bolls.life/get-chapter/WEB/${bookId}/${chapter}/`);
        if (fallbackRes.ok) {
          const fbData = await fallbackRes.json();
          if (Array.isArray(fbData) && fbData.length > 0) return fbData;
        }
      } catch (e) {}
    }
    throw err;
  }
}

async function openReaderModal({ portion, day, initialChapter }) {
  const modal = document.getElementById('reader-modal');
  const backdrop = document.getElementById('reader-modal-backdrop');
  const titleEl = document.getElementById('reader-portion-title');
  const dayBadge = document.getElementById('reader-day-badge');
  const extLink = document.getElementById('reader-external-link');
  const markReadBtn = document.getElementById('reader-mark-read-btn');

  if (!modal || !backdrop) return;

  activeReaderPortion = portion;
  activeReaderDay = day;

  if (titleEl) titleEl.textContent = portion || "Today's Reading";
  if (dayBadge) {
    dayBadge.textContent = day ? `Day ${day}` : 'Reading';
    dayBadge.hidden = !day;
  }

  if (extLink) {
    const bgQuery = encodeURIComponent(portion.replace(/[–—]/g, '-'));
    extLink.href = `https://www.biblegateway.com/passage/?search=${bgQuery}&version=${activeReaderVersion}`;
  }

  if (markReadBtn) {
    const curSession = getSession();
    if (curSession && curSession.isGuest) {
      markReadBtn.disabled = true;
      markReadBtn.textContent = 'Guest View Only';
    } else {
      markReadBtn.disabled = false;
      if (day && currentDayNum && day === currentDayNum) {
        markReadBtn.textContent = '✓ Mark Today as Read';
      } else if (day) {
        markReadBtn.textContent = `✓ Mark Day ${day} as Read`;
      } else {
        markReadBtn.textContent = '✓ Mark Today as Read';
      }
    }
  }

  modal.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add('active');
    backdrop.classList.add('active');
  });

  await renderReaderPassageContent(portion, activeReaderVersion, initialChapter);
}

async function renderReaderPassageContent(portionText, version, targetChapterObj) {
  const tabsContainer = document.getElementById('reader-chapter-tabs');
  const contentContainer = document.getElementById('reader-content');
  if (!contentContainer) return;

  const parsed = parsePassage(portionText);

  if (parsed.isCatchUp) {
    if (tabsContainer) tabsContainer.innerHTML = '';
    contentContainer.innerHTML = `
      <div class="reader-loading-state" style="text-align: center; max-width: 500px; margin: 2rem auto;">
        <span style="font-size: 3rem;">🕊️</span>
        <h3 style="font-family: var(--font-display); font-size: 1.5rem; color: var(--accent); margin: 0.5rem 0;">Catch-Up & Sabbath Day</h3>
        <p style="color: var(--text-muted); line-height: 1.6;">Use today to reflect on the Scriptures read so far, catch up on any missed chapters, or spend time in prayer.</p>
      </div>
    `;
    return;
  }

  if (!parsed.chapters.length) {
    if (tabsContainer) tabsContainer.innerHTML = '';
    contentContainer.innerHTML = `
      <div class="reader-loading-state">
        <p>No chapters found for this portion.</p>
      </div>
    `;
    return;
  }

  if (tabsContainer) {
    tabsContainer.innerHTML = '';
    parsed.chapters.forEach((ch, idx) => {
      const isInitialActive = targetChapterObj
        ? (ch.bookId === targetChapterObj.bookId && ch.chapter === targetChapterObj.chapter)
        : idx === 0;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'reader-tab-btn' + (isInitialActive ? ' active' : '');
      tab.textContent = ch.label;
      tab.dataset.targetId = `reader-ch-${ch.bookId}-${ch.chapter}`;
      tab.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.reader-tab-btn').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const targetEl = document.getElementById(tab.dataset.targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      tabsContainer.appendChild(tab);
    });
  }

  contentContainer.innerHTML = `
    <div class="reader-loading-state">
      <div class="reader-spinner"></div>
      <p>Loading ${portionText} (${version})…</p>
    </div>
  `;

  try {
    const results = await Promise.allSettled(
      parsed.chapters.map(ch => fetchChapterFromApi(version, ch.bookId, ch.chapter))
    );

    contentContainer.innerHTML = '';

    results.forEach((res, idx) => {
      const chMeta = parsed.chapters[idx];
      const chSection = document.createElement('section');
      chSection.className = 'reader-chapter-section';
      chSection.id = `reader-ch-${chMeta.bookId}-${chMeta.chapter}`;

      const heading = document.createElement('h3');
      heading.className = 'reader-chapter-heading';
      heading.textContent = `${chMeta.bookName} ${chMeta.chapter}`;
      chSection.appendChild(heading);

      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'reader-chapter-body';

        res.value.forEach(v => {
          const row = document.createElement('span');
          row.className = 'verse-row';
          const cleanText = String(v.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          row.innerHTML = `<sup class="verse-num">${v.verse}</sup><span class="verse-text">${cleanText}</span> `;
          bodyWrap.appendChild(row);
        });

        chSection.appendChild(bodyWrap);
      } else {
        const errP = document.createElement('p');
        errP.className = 'reader-error-note';
        errP.style.color = 'var(--text-muted)';
        errP.style.fontStyle = 'italic';
        errP.textContent = `Could not load ${chMeta.bookName} ${chMeta.chapter} in ${version}. Tap "Open on Bible Gateway" below to read.`;
        chSection.appendChild(errP);
      }

      contentContainer.appendChild(chSection);
    });

    if (targetChapterObj) {
      setTimeout(() => {
        const targetEl = document.getElementById(`reader-ch-${targetChapterObj.bookId}-${targetChapterObj.chapter}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
    updateAudioChapterInfo(portionText);
  } catch (err) {
    contentContainer.innerHTML = `
      <div class="reader-loading-state">
        <p style="color: var(--bad);">Couldn't load Scripture text from online Bible service.</p>
        <p style="color: var(--text-muted); font-size: 0.9rem;">You can read today's portion directly via Bible Gateway below.</p>
      </div>
    `;
  }
}

function renderTodayPortionDetail(portionText, dayNum, session) {
  const detailCard = document.getElementById('portion-detail-card');
  const readingTimeEl = document.getElementById('portion-reading-time');
  const chaptersCountEl = document.getElementById('portion-chapters-count');
  const keyVerseText = document.getElementById('key-verse-text');
  const keyVerseRef = document.getElementById('key-verse-ref');
  const chipsContainer = document.getElementById('chapter-breakdown-chips');

  if (!detailCard) return;

  if (!portionText || portionText.trim() === '' || portionText.toLowerCase().includes('no portion')) {
    detailCard.hidden = true;
    return;
  }

  detailCard.hidden = false;

  const parsed = parsePassage(portionText);

  if (readingTimeEl) {
    readingTimeEl.textContent = parsed.isCatchUp ? '⏱️ Sabbath / Reflection' : '⏱️ ~45–60 mins';
  }

  if (chaptersCountEl) {
    chaptersCountEl.textContent = parsed.isCatchUp 
      ? '📖 Catch-up & Prayer'
      : `📖 ${parsed.totalChapters} ${parsed.totalChapters === 1 ? 'chapter' : 'chapters'}`;
  }

  const kv = getKeyVerseForPortion(portionText, dayNum);
  if (keyVerseText) keyVerseText.textContent = `"${kv.text}"`;
  if (keyVerseRef) keyVerseRef.textContent = `— ${kv.ref}`;

  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    if (parsed.isCatchUp) {
      chipsContainer.innerHTML = '<span class="breakdown-empty" style="font-size: 0.82rem; color: var(--text-muted);">Catch up on previous readings at your own pace ✨</span>';
    } else {
      parsed.chapters.forEach(ch => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chapter-chip';
        chip.textContent = ch.label;
        chip.title = `Read ${ch.bookName} ${ch.chapter}`;
        chip.addEventListener('click', () => {
          openReaderModal({ portion: portionText, day: dayNum, initialChapter: ch });
        });
        chipsContainer.appendChild(chip);
      });
    }
  }
}

// ====== DAYWISE BIBLE READING PORTION SIDEBAR ======

let allPortionsCache = [];
let currentDayNum = null;

function initReadingSidebar() {
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const closeBtn = document.getElementById('close-sidebar-btn');
  const backdrop = document.getElementById('sidebar-backdrop');
  const sidebar = document.getElementById('reading-sidebar');
  const searchInput = document.getElementById('sidebar-search-input');

  if (!toggleBtn || !sidebar) return;

  const openSidebar = () => {
    sidebar.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      sidebar.classList.add('open');
      backdrop.classList.add('active');
    });
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    filterSidebarPortions('');

    setTimeout(() => {
      const currentEl = sidebar.querySelector('.sidebar-portion-item.current-day');
      if (currentEl) {
        currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 350);
  };

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
    setTimeout(() => {
      sidebar.hidden = true;
      backdrop.hidden = true;
    }, 400);
  };

  toggleBtn.addEventListener('click', openSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      filterSidebarPortions(e.target.value.trim().toLowerCase());
    });
  }
}

function renderReadingSidebar(portions) {
  allPortionsCache = portions || [];
  filterSidebarPortions('');
}

function filterSidebarPortions(query) {
  const listEl = document.getElementById('sidebar-portions-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!allPortionsCache.length) {
    listEl.innerHTML = '<p class="sidebar-loading">No reading schedule available.</p>';
    return;
  }

  const filtered = allPortionsCache.filter(item => {
    if (!query) return true;
    const q = query.toLowerCase();
    return String(item.day).includes(q) ||
           (item.portion && item.portion.toLowerCase().includes(q)) ||
           (item.date && item.date.toLowerCase().includes(q));
  });

  if (!filtered.length) {
    listEl.innerHTML = '<p class="sidebar-loading">No matching portions found.</p>';
    return;
  }

  filtered.forEach(item => {
    const el = document.createElement('div');
    const isCurrent = currentDayNum !== null && item.day === currentDayNum;
    el.className = 'sidebar-portion-item' + (isCurrent ? ' current-day' : '');

    const parsed = parsePassage(item.portion);
    let chipsHtml = '';
    if (!parsed.isCatchUp && parsed.chapters.length > 0) {
      chipsHtml = `<div class="sidebar-chips-row">${parsed.chapters.slice(0, 8).map(c => `<span class="sidebar-mini-chip">${c.abbr} ${c.chapter}</span>`).join('')}${parsed.chapters.length > 8 ? `<span class="sidebar-mini-chip">+${parsed.chapters.length - 8} more</span>` : ''}</div>`;
    }

    el.innerHTML = `
      <div class="sidebar-item-top">
        <span class="sidebar-day-tag">Day ${item.day} ${isCurrent ? '• TODAY' : ''}</span>
        <span class="sidebar-date-tag">${item.date || ''}</span>
      </div>
      <div class="sidebar-portion-text">${item.portion || ''}</div>
      ${chipsHtml}
      <div class="sidebar-item-actions">
        <button type="button" class="btn-sidebar-read">📖 Read Passage</button>
      </div>
    `;

    // Click handler: opens reader modal for that day!
    el.addEventListener('click', (e) => {
      const select = document.getElementById('date-select');
      if (select && item.date) {
        let matchedOpt = Array.from(select.options).find(o => o.value === item.date);
        if (matchedOpt) {
          select.value = item.date;
        } else {
          const opt = document.createElement('option');
          opt.value = item.date;
          opt.textContent = item.date;
          select.appendChild(opt);
          select.value = item.date;
        }
      }

      openReaderModal({ portion: item.portion, day: item.day });

      const closeBtn = document.getElementById('close-sidebar-btn');
      if (closeBtn) closeBtn.click();
    });

    listEl.appendChild(el);
  });
}

// ====== SECTION SCROLL TRANSITIONS ======

function initScrollTransitions() {
  const sections = document.querySelectorAll('main section, .squad-gauge-card');
  sections.forEach(sec => sec.classList.add('scroll-animate'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      } else {
        entry.target.classList.remove('is-visible');
      }
    });
  }, {
    threshold: 0.08,
    rootMargin: '0px 0px -40px 0px'
  });

  sections.forEach(sec => observer.observe(sec));
}

// ====== AUDIO BIBLE NARRATOR CONTROLLER ======

let isAudioPlaying = false;
let audioSpeechSynth = null;
let currentUtterance = null;
let currentAudioChapterName = '';
let audioProgressTimer = null;
let audioPlaybackSeconds = 0;
let estimatedAudioDuration = 180;

function initAudioNarrator() {
  const playBtn = document.getElementById('audio-play-btn');
  const skipBackBtn = document.getElementById('audio-skip-back-btn');
  const skipFwdBtn = document.getElementById('audio-skip-fwd-btn');
  const speedSelect = document.getElementById('audio-speed-select');

  if (!playBtn) return;

  if ('speechSynthesis' in window) {
    audioSpeechSynth = window.speechSynthesis;
  }

  playBtn.addEventListener('click', () => {
    toggleAudioPlayback();
  });

  if (skipBackBtn) {
    skipBackBtn.addEventListener('click', () => {
      seekAudio(-10);
    });
  }

  if (skipFwdBtn) {
    skipFwdBtn.addEventListener('click', () => {
      seekAudio(10);
    });
  }

  if (speedSelect) {
    speedSelect.addEventListener('change', () => {
      if (isAudioPlaying) {
        stopAudioPlayback();
        toggleAudioPlayback();
      }
    });
  }
}

function updateAudioChapterInfo(chapterTitle) {
  const titleEl = document.getElementById('audio-chapter-title');
  const timeDisplay = document.getElementById('audio-time-display');
  currentAudioChapterName = chapterTitle;
  if (titleEl) titleEl.textContent = chapterTitle || 'Audio Narrator';
  stopAudioPlayback();
  audioPlaybackSeconds = 0;
  if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
}

function formatAudioTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function toggleAudioPlayback() {
  if (isAudioPlaying) {
    stopAudioPlayback();
  } else {
    startAudioPlayback();
  }
}

function startAudioPlayback() {
  const contentEl = document.getElementById('reader-content');
  if (!contentEl) return;
  const verses = Array.from(contentEl.querySelectorAll('.verse-text')).map(v => v.textContent.trim()).filter(Boolean);
  if (!verses.length) {
    alert("Please wait for Scripture text to load before starting audio narration.");
    return;
  }

  const fullText = verses.join('. ');
  const speedSelect = document.getElementById('audio-speed-select');
  const rate = speedSelect ? parseFloat(speedSelect.value) || 1.0 : 1.0;

  if (audioSpeechSynth) {
    audioSpeechSynth.cancel();
    currentUtterance = new SpeechSynthesisUtterance(fullText);
    currentUtterance.rate = rate;
    currentUtterance.pitch = 1.0;

    const voices = audioSpeechSynth.getVoices();
    const englishVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Daniel')));
    if (englishVoice) currentUtterance.voice = englishVoice;

    estimatedAudioDuration = Math.max(30, Math.round((verses.length * 4.5) / rate));

    currentUtterance.onstart = () => {
      isAudioPlaying = true;
      const icon = document.getElementById('audio-play-icon');
      if (icon) icon.textContent = '⏸';
      document.getElementById('audio-wave-anim')?.classList.add('playing');
      startAudioProgressTimer();
    };

    currentUtterance.onend = () => {
      stopAudioPlayback();
    };

    currentUtterance.onerror = () => {
      stopAudioPlayback();
    };

    audioSpeechSynth.speak(currentUtterance);
  } else {
    alert("Audio speech synthesis is not supported on this browser.");
  }
}

function stopAudioPlayback() {
  isAudioPlaying = false;
  if (audioSpeechSynth) {
    audioSpeechSynth.cancel();
  }
  const playIcon = document.getElementById('audio-play-icon');
  if (playIcon) playIcon.textContent = '▶';
  document.getElementById('audio-wave-anim')?.classList.remove('playing');
  if (audioProgressTimer) {
    clearInterval(audioProgressTimer);
    audioProgressTimer = null;
  }
}

function startAudioProgressTimer() {
  if (audioProgressTimer) clearInterval(audioProgressTimer);
  const timeDisplay = document.getElementById('audio-time-display');
  audioProgressTimer = setInterval(() => {
    if (!isAudioPlaying) return;
    audioPlaybackSeconds++;
    if (timeDisplay) {
      timeDisplay.textContent = `${formatAudioTime(audioPlaybackSeconds)} / ${formatAudioTime(estimatedAudioDuration)}`;
    }
  }, 1000);
}

function seekAudio(delta) {
  audioPlaybackSeconds = Math.max(0, audioPlaybackSeconds + delta);
  const timeDisplay = document.getElementById('audio-time-display');
  if (timeDisplay) {
    timeDisplay.textContent = `${formatAudioTime(audioPlaybackSeconds)} / ${formatAudioTime(estimatedAudioDuration)}`;
  }
}

// ====== INIT ======

initTheme();
initLogin();
