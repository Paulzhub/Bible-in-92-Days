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

async function apiGet(params, { retries = 2, timeoutMs = 30000 } = {}) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('_t', Date.now().toString());

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
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

function initBrowserLifecycleHandlers() {
  // 1. Force full reload if restored from bfcache (Back/Forward Cache or frozen tab restore)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      window.location.reload();
      return;
    }
    const session = getSession();
    if (session && (!currentLeaderboard || currentLeaderboard.length === 0)) {
      loadInitialData(session);
    }
  });

  // 2. Track browser restart lifecycle
  try {
    const BROWSER_SESSION_KEY = 'bible92_browser_session_live';
    const isBrowserReopen = !sessionStorage.getItem(BROWSER_SESSION_KEY);
    sessionStorage.setItem(BROWSER_SESSION_KEY, String(Date.now()));

    if (isBrowserReopen) {
      const existingSession = localStorage.getItem('bible92_session');
      if (existingSession) {
        const navEntry = window.performance?.getEntriesByType?.('navigation')?.[0];
        if (navEntry && (navEntry.type === 'back_forward' || navEntry.type === 'reload')) {
          window.location.reload();
        }
      }
    }
  } catch (e) {}
}

function initLogin() {
  initBrowserLifecycleHandlers();
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

    const uLow = username.toLowerCase();
    const isGuest = uLow.includes('guest') || uLow.startsWith('guest');
    const isAdmin = uLow === 'admin';
    const clientSessionId = (isAdmin ? 'a_' : (isGuest ? 'g_' : 'u_')) + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
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
          isAdmin: !!res.isAdmin,
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

function formatGuestNameList(names) {
  if (!names || names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function updateGuestBanner(activeGuestsData, session) {
  const banner = document.getElementById('guest-warning-banner');
  const textEl = document.getElementById('guest-warning-text');
  if (!banner || !textEl) return;

  const guestsSet = new Set();
  
  if (Array.isArray(activeGuestsData)) {
    activeGuestsData.forEach(g => {
      if (g && typeof g === 'string' && g.trim()) guestsSet.add(g.trim());
    });
  } else if (typeof activeGuestsData === 'string' && activeGuestsData.trim()) {
    guestsSet.add(activeGuestsData.trim());
  }

  if (session && session.isGuest && session.username) {
    guestsSet.add(session.username.trim());
  }

  const activeGuestsList = Array.from(guestsSet);

  if (activeGuestsList.length === 1) {
    textEl.textContent = `A guest is currently logged in (${activeGuestsList[0]} is watching)! Don't have too much fun or they may die of envy! ✨`;
    banner.hidden = false;
  } else if (activeGuestsList.length > 1) {
    const formattedList = formatGuestNameList(activeGuestsList);
    textEl.textContent = `Multiple guests are currently logged in (${formattedList} are watching)! Don't have too much fun or they may die of envy! ✨`;
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

  let isExpiring = false;
  setInterval(async () => {
    if (isExpiring) return;
    const cur = getSession();
    if (!cur) {
      isExpiring = true;
      alert('Your guest session has expired after 30 minutes of inactivity. Please sign in again.');
      await performLogout(session);
    }
  }, 10000);
}

async function performLogout(session) {
  const cur = session || getSession();
  if (cur) {
    const payload = {
      action: 'logout',
      username: cur.username || '',
      sessionId: cur.sessionId || '',
      isGuest: cur.isGuest ? 'true' : 'false'
    };
    try {
      await apiGet(payload);
    } catch (e) {
      console.warn('Logout logging network error (safe to proceed):', e);
    }
  }
  clearSession();
  location.reload();
}

function showSite(session) {
  document.getElementById('login-screen').hidden = true;
  const siteEl = document.getElementById('site');
  siteEl.hidden = false;
  siteEl.classList.add('fade-in', 'site-ease-in');
  
  const userGreetingSuffix = session.isAdmin ? ' (🛡️ Admin)' : (session.isGuest ? ' (Guest)' : '');
  document.getElementById('welcome-user').textContent = `Hi, ${session.username}` + userGreetingSuffix;

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      logoutBtn.disabled = true;
      logoutBtn.textContent = 'Signing out…';
      await performLogout(session);
    });
  }

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
  setInterval(() => {
    const cur = getSession();
    if (cur) loadUpdates(cur);
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const cur = getSession();
      if (!cur) return;
      if (!currentLeaderboard || currentLeaderboard.length === 0 || !currentDayNum) {
        loadInitialData(cur);
      } else {
        loadUpdates(cur);
      }
    }
  });

  window.addEventListener('focus', () => {
    const cur = getSession();
    if (!cur) return;
    if (!currentLeaderboard || currentLeaderboard.length === 0 || !currentDayNum) {
      loadInitialData(cur);
    } else {
      loadUpdates(cur);
    }
  });

  window.addEventListener('online', () => {
    const cur = getSession();
    if (cur) {
      loadInitialData(cur);
    }
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

  if (session && (session.isGuest || session.isAdmin)) {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = session.isAdmin ? 'Admin Mode (Non-Reader)' : 'Guest View Only';
    }
    const dateSelect = document.getElementById('date-select');
    const statusSelect = document.getElementById('status-select');
    if (dateSelect) dateSelect.disabled = true;
    if (statusSelect) statusSelect.disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session && (session.isGuest || session.isAdmin)) {
      feedback.hidden = false;
      feedback.textContent = session.isAdmin ? 'Admin account is not on the reading roster.' : 'Guest users are in read-only mode.';
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

async function loadInitialData(session, retryCount = 0) {
  const portionEl = document.getElementById('today-portion');
  const dateEl = document.getElementById('today-date');
  const lbBody = document.getElementById('leaderboard-body');
  const lbError = document.getElementById('leaderboard-error');
  const commentsListEl = document.getElementById('comments-list');
  const prayersListEl = document.getElementById('prayers-list');

  let res;
  try {
    res = await apiGet({ action: 'getInitialData', username: session.username, password: session.password });
  } catch (err) {
    if (retryCount < 3) {
      console.warn(`Initial data load failed (attempt ${retryCount + 1}), auto-retrying in ${(retryCount + 1) * 1500}ms...`, err);
      setTimeout(() => {
        const curSession = getSession();
        if (curSession) loadInitialData(curSession, retryCount + 1);
      }, (retryCount + 1) * 1500);
      return;
    }
    if (portionEl) portionEl.textContent = "Couldn't load today's portion. Check your connection.";
    if (lbBody) lbBody.innerHTML = '';
    if (lbError) {
      lbError.textContent = "Couldn't reach the server. Please refresh.";
      lbError.hidden = false;
    }
    if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
    if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
    return;
  }

  if (!res) return;

  try { updateGuestBanner(res.activeGuests || res.activeGuest, session); } catch (e) { console.error(e); }

  try {
    if (res.today && res.today.success) {
      if (portionEl) portionEl.textContent = res.today.portion;
      if (dateEl) dateEl.textContent = res.today.date;
      currentDayNum = res.today.day;
      renderDayCountdown(res.today.day);
      renderTodayPortionDetail(res.today.portion, res.today.day, session);
    } else {
      if (portionEl) portionEl.textContent = "No portion listed for today yet — check back soon.";
      if (dateEl) dateEl.textContent = res.today ? (res.today.date || '') : '';
      renderDayCountdown(null);
      renderTodayPortionDetail('', null, session);
    }
  } catch (e) { console.error('Error rendering today portion:', e); }

  try {
    if (res.allPortions && res.allPortions.success) {
      renderReadingSidebar(res.allPortions.portions);
    }
  } catch (e) { console.error('Error rendering reading sidebar:', e); }

  try {
    if (res.nudges && res.nudges.success) {
      currentNudges = res.nudges.nudges || [];
      if (session && !session.isGuest) {
        nudgedTargetsToday = new Set(
          currentNudges
            .filter(n => n.sender && n.sender.toLowerCase() === session.username.toLowerCase())
            .map(n => n.target)
        );
      }
      renderSquadNudgeBanner(currentNudges, session);
    }
  } catch (e) { console.error('Error rendering squad nudges:', e); }

  try {
    if (res.leaderboard && res.leaderboard.success) {
      currentLeaderboard = res.leaderboard.leaderboard || [];
      renderLeaderboard(currentLeaderboard, session);
      renderPlayground(currentLeaderboard);
      updateHeaderLevel(currentLeaderboard, session);
    } else {
      if (lbBody) lbBody.innerHTML = '';
      if (lbError) {
        lbError.textContent = (res.leaderboard && res.leaderboard.error) || 'Could not load the leaderboard.';
        lbError.hidden = false;
      }
    }
  } catch (e) { console.error('Error rendering leaderboard:', e); }

  try {
    if (res.recap && res.recap.success) {
      currentWeeklyRecap = res.recap;
      renderWeeklyRecap(res.recap);
    }
  } catch (e) { console.error('Error rendering weekly recap:', e); }

  try {
    if (res.comments && res.comments.success) {
      commentsCache = res.comments.comments || [];
      renderComments(session);
      updateCommentFormVisibility(session);
    } else {
      if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Could not load comments.</p>';
    }
  } catch (e) { console.error('Error rendering comments:', e); }

  try {
    if (res.prayers && res.prayers.success) {
      prayersCache = res.prayers.prayers || [];
      renderPrayers(session);
      updatePrayerFormVisibility(session);
    } else {
      if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Could not load prayers.</p>';
    }
  } catch (e) { console.error('Error rendering prayers:', e); }

  try {
    if (res.history && res.history.success) {
      renderHeatmap(res.history.history || []);
    }
  } catch (e) { console.error('Error rendering heatmap:', e); }
}

async function loadUpdates(session) {
  try {
    const res = await apiGet({ action: 'getUpdates', username: session.username, password: session.password });
    if (!res) return;

    try { updateGuestBanner(res.activeGuests || res.activeGuest, session); } catch (e) {}

    try {
      if (res.nudges && res.nudges.success) {
        currentNudges = res.nudges.nudges || [];
        if (session && !session.isGuest) {
          nudgedTargetsToday = new Set(
            currentNudges
              .filter(n => n.sender && n.sender.toLowerCase() === session.username.toLowerCase())
              .map(n => n.target)
          );
        }
        renderSquadNudgeBanner(currentNudges, session);
      }
    } catch (e) {}

    try {
      if (res.leaderboard && res.leaderboard.success) {
        currentLeaderboard = res.leaderboard.leaderboard || [];
        renderLeaderboard(currentLeaderboard, session);
        renderPlayground(currentLeaderboard);
        updateHeaderLevel(currentLeaderboard, session);
      }
    } catch (e) {}

    try {
      if (res.recap && res.recap.success) {
        currentWeeklyRecap = res.recap;
        renderWeeklyRecap(res.recap);
      }
    } catch (e) {}

    const todayStr = formatDDMMYY(new Date());
    const isViewingTodayComments = !activeCommentsDate || activeCommentsDate === todayStr;
    try {
      if (res.comments && res.comments.success && isViewingTodayComments) {
        commentsCache = res.comments.comments || [];
        renderComments(session);
        updateCommentFormVisibility(session);
      }
    } catch (e) {}

    const isViewingTodayPrayers = !activePrayersDate || activePrayersDate === todayStr;
    try {
      if (res.prayers && res.prayers.success && isViewingTodayPrayers) {
        prayersCache = res.prayers.prayers || [];
        renderPrayers(session);
        updatePrayerFormVisibility(session);
      }
    } catch (e) {}

    try {
      if (res.history && res.history.success) {
        renderHeatmap(res.history.history || []);
      }
    } catch (e) {}
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
    if (!row.readToday && !isYou && session && !session.isGuest) {
      const nudgeBtn = document.createElement('button');
      nudgeBtn.type = 'button';
      const isAlreadyNudged = nudgedTargetsToday.has(row.username);
      nudgeBtn.className = 'nudge-btn' + (isAlreadyNudged ? ' nudged' : '');
      nudgeBtn.textContent = isAlreadyNudged ? '⚡ Nudged!' : '⚡ Nudge';
      nudgeBtn.disabled = isAlreadyNudged;
      nudgeBtn.title = isAlreadyNudged
        ? `You nudged ${row.username} today!`
        : `Send ${row.username} an encouragement nudge!`;
      nudgeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleNudgeUser(row.username, nudgeBtn, session);
      });
      nameRow.appendChild(nudgeBtn);
    }

    // Nudge counter indicator on leaderboard with hover tooltip
    const matchingNudges = currentNudges.filter(n => n.target && n.target.toLowerCase() === row.username.toLowerCase());
    const nudgesReceived = matchingNudges.length;
    if (nudgesReceived > 0 && !row.readToday) {
      const senders = [...new Set(matchingNudges.map(n => n.sender).filter(Boolean))];
      const sendersStr = senders.length > 0 ? senders.join(', ') : 'Squad members';
      const nudgeTag = document.createElement('span');
      nudgeTag.className = 'nudge-tag';
      nudgeTag.setAttribute('tabindex', '0');
      nudgeTag.innerHTML = `⚡ ${nudgesReceived}x<span class="nudge-hover-tooltip">Nudged by: ${sendersStr}</span>`;
      nudgeTag.title = `Nudged by: ${sendersStr}`;
      nameRow.appendChild(nudgeTag);
    }

    readerTd.appendChild(nameRow);

    const safeStreak = Math.min(row.streak || 0, row.daysCompleted || 0);
    const streakEl = document.createElement('span');
    streakEl.className = 'reader-streak';
    streakEl.innerHTML = safeStreak > 0
      ? `<span class="flame">🔥</span>${safeStreak}-day streak`
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

async function confirmAndDeleteComment(session, targetUsername, targetDate) {
  if (!session || session.isGuest) return;
  const target = targetUsername || session.username;
  const isOther = target.toLowerCase() !== session.username.toLowerCase();
  const promptMsg = isOther
    ? `Are you sure you want to delete ${target}'s comment as Admin?`
    : 'Are you sure you want to delete your comment?';
  const confirmed = window.confirm(promptMsg);
  if (!confirmed) return;

  const itemEl = document.querySelector(`.comment-item[data-username="${CSS.escape(target)}"]`);
  const deleteBtns = itemEl ? itemEl.querySelectorAll('.comment-delete-btn') : document.querySelectorAll('.comment-delete-btn, .delete-today-comment-btn');
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
      password: session.password,
      targetUsername: target,
      date: targetDate || activeCommentsDate || formatDDMMYY(new Date())
    });

    if (res && res.success) {
      commentsCache = commentsCache.filter(c => c.username !== target);
      
      if (itemEl) {
        itemEl.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
        itemEl.style.opacity = '0';
        itemEl.style.transform = 'scale(0.95)';
        setTimeout(() => {
          itemEl.remove();
          const listEl = document.getElementById('comments-list');
          if (listEl && listEl.querySelectorAll('.comment-item').length === 0) {
            listEl.innerHTML = '<p class="comments-empty">No comments yet for this day — be the first to share!</p>';
          }
        }, 250);
      }

      updateCommentFormVisibility(session);

      if (feedback) {
        feedback.hidden = false;
        feedback.className = 'form-feedback success';
        feedback.textContent = isOther ? `Deleted ${target}'s comment.` : 'Your comment has been deleted.';
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

  const canDelete = (isYou || (session && session.isAdmin)) && (!session || !session.isGuest);
  if (canDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'comment-delete-btn';
    deleteBtn.innerHTML = '🗑️ Delete';
    deleteBtn.title = isYou ? 'Delete your comment' : `Delete ${comment.username}'s comment (Admin)`;
    deleteBtn.addEventListener('click', () => {
      confirmAndDeleteComment(session, comment.username, activeCommentsDate);
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

  if (session && session.isAdmin) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = '🛡️ Admin Mode — You can moderate and delete squad comments directly on each comment card.';
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
  const canModerate = (isYou || (session && session.isAdmin)) && (!session || !session.isGuest);

  const item = document.createElement('div');
  item.className = 'prayer-card' + (isYou ? ' is-my-prayer' : '');
  item.dataset.username = prayer.username;

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

  const headRight = document.createElement('div');
  headRight.className = 'prayer-head-right';

  if (prayer.timestamp) {
    const timeSpan = document.createElement('span');
    timeSpan.className = 'prayer-time';
    try {
      const dt = new Date(prayer.timestamp);
      timeSpan.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch(e) {}
    headRight.appendChild(timeSpan);
  }

  if (canModerate) {
    const actionsGroup = document.createElement('div');
    actionsGroup.className = 'prayer-actions-group';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'prayer-edit-btn';
    editBtn.innerHTML = '✏️ Edit';
    editBtn.title = isYou ? 'Edit your prayer' : `Edit ${prayer.username}'s prayer (Admin)`;
    editBtn.addEventListener('click', () => {
      startEditingPrayer(item, prayer, session);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'prayer-delete-btn';
    deleteBtn.innerHTML = '🗑️ Delete';
    deleteBtn.title = isYou ? 'Delete your prayer' : `Delete ${prayer.username}'s prayer (Admin)`;
    deleteBtn.addEventListener('click', () => {
      confirmAndDeletePrayer(session, prayer.username, activePrayersDate);
    });

    actionsGroup.append(editBtn, deleteBtn);
    headRight.appendChild(actionsGroup);
  }

  head.appendChild(headRight);

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

function startEditingPrayer(cardEl, prayer, session) {
  const existingEditBox = cardEl.querySelector('.prayer-edit-box');
  if (existingEditBox) return;

  const textEl = cardEl.querySelector('.prayer-text');
  const reactionsEl = cardEl.querySelector('.prayer-reactions');
  const actionsGroup = cardEl.querySelector('.prayer-actions-group');
  if (!textEl) return;

  textEl.hidden = true;
  if (reactionsEl) reactionsEl.hidden = true;
  if (actionsGroup) actionsGroup.hidden = true;

  const editBox = document.createElement('div');
  editBox.className = 'prayer-edit-box';

  const textarea = document.createElement('textarea');
  textarea.className = 'prayer-edit-textarea';
  textarea.value = prayer.text;
  textarea.maxLength = 2500;
  textarea.rows = 4;

  const footer = document.createElement('div');
  footer.className = 'prayer-edit-footer';

  const counter = document.createElement('span');
  counter.className = 'prayer-edit-counter';
  counter.textContent = getCharAndWordCount(textarea.value);

  textarea.addEventListener('input', () => {
    counter.textContent = getCharAndWordCount(textarea.value);
  });

  const btns = document.createElement('div');
  btns.className = 'prayer-edit-btns';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'prayer-edit-cancel-btn';
  cancelBtn.textContent = '✖ Cancel';
  cancelBtn.addEventListener('click', () => {
    editBox.remove();
    textEl.hidden = false;
    if (reactionsEl) reactionsEl.hidden = false;
    if (actionsGroup) actionsGroup.hidden = false;
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'prayer-edit-save-btn';
  saveBtn.textContent = '💾 Save Changes';
  saveBtn.addEventListener('click', async () => {
    const newText = textarea.value.trim();
    if (!newText) {
      alert('Prayer text cannot be empty.');
      return;
    }

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const res = await apiGet({
        action: 'editPrayer',
        username: session.username,
        password: session.password,
        targetUsername: prayer.username,
        date: activePrayersDate || formatDDMMYY(new Date()),
        text: newText
      });

      if (res && res.success) {
        prayer.text = newText;
        renderPrayers(session);
      } else {
        alert(res?.error || 'Failed to update prayer.');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = '💾 Save Changes';
      }
    } catch(err) {
      alert('Server connection error. Please try again.');
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes';
    }
  });

  btns.append(cancelBtn, saveBtn);
  footer.append(counter, btns);
  editBox.append(textarea, footer);

  cardEl.insertBefore(editBox, reactionsEl);
  textarea.focus();
}

async function confirmAndDeletePrayer(session, targetUsername, targetDate) {
  if (session && session.isGuest) return;
  const target = targetUsername || session.username;
  const isOther = target.toLowerCase() !== session.username.toLowerCase();
  const promptMsg = isOther
    ? `Are you sure you want to delete ${target}'s prayer as Admin?`
    : 'Are you sure you want to delete today’s prayer?';
  if (!confirm(promptMsg)) return;

  const prev = [...prayersCache];
  prayersCache = prayersCache.filter(p => p.username !== target);
  renderPrayers(session);
  updatePrayerFormVisibility(session);

  try {
    const res = await apiGet({
      action: 'deletePrayer',
      username: session.username,
      password: session.password,
      targetUsername: target,
      date: targetDate || activePrayersDate || formatDDMMYY(new Date())
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

function updatePrayerFormVisibility(session) {
  const form = document.getElementById('prayer-form');
  const alreadyWrap = document.getElementById('prayer-already-wrap');
  const alreadyMsg = document.getElementById('prayer-already');
  const deleteTodayBtn = document.getElementById('delete-today-prayer-btn');
  if (!form || !alreadyWrap) return;

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = 'Guests are in read-only mode — explore and pray for the squad! 🙏';
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  if (session && session.isAdmin) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = '🛡️ Admin Mode — You can moderate, edit, and delete squad prayers directly on each prayer card.';
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  const userPrayer = session && prayersCache.find(p => p.username && p.username.toLowerCase() === session.username.toLowerCase());
  const hasPrayed = Boolean(userPrayer);
  form.hidden = hasPrayed;
  alreadyWrap.hidden = !hasPrayed;

  if (hasPrayed) {
    if (alreadyMsg) alreadyMsg.textContent = "You've shared your prayer for today — thank you for blessing the squad!";
    if (deleteTodayBtn) {
      deleteTodayBtn.hidden = false;
      deleteTodayBtn.disabled = false;
      deleteTodayBtn.textContent = '🗑️ Delete My Prayer';
      deleteTodayBtn.onclick = () => {
        confirmAndDeletePrayer(session);
      };
    }
  }
}

function wirePrayerForm(session) {
  const form = document.getElementById('prayer-form');
  const alreadyWrap = document.getElementById('prayer-already-wrap');
  const feedback = document.getElementById('prayer-feedback');
  const textarea = document.getElementById('prayer-input');
  const counterEl = document.getElementById('prayer-char-counter');
  if (!form || !alreadyWrap) return;

  if (textarea && counterEl) {
    counterEl.textContent = getCharAndWordCount(textarea.value);
    textarea.addEventListener('input', () => {
      counterEl.textContent = getCharAndWordCount(textarea.value);
    });
  }

  if (session && (session.isGuest || session.isAdmin)) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session && (session.isGuest || session.isAdmin)) return;
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
    const listEl = document.getElementById('prayers-list');
    if (listEl) {
      listEl.appendChild(buildPrayerElement(optimisticPrayer, session));
      listEl.querySelectorAll('.comments-empty, .prayers-loading').forEach(el => el.remove());
    }
    textarea.value = '';
    if (counterEl) counterEl.textContent = getCharAndWordCount('');
    form.hidden = true;
    alreadyWrap.hidden = false;
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
        form.hidden = false;
        alreadyWrap.hidden = true;
        textarea.value = text;
        if (counterEl) counterEl.textContent = getCharAndWordCount(text);
        if (feedback) {
          feedback.hidden = false;
          feedback.textContent = res.error || 'Something went wrong.';
          feedback.className = 'form-feedback error';
        }
        updatePrayerFormVisibility(session);
      }
    } catch (err) {
      prayersCache = prayersCache.filter(p => p !== optimisticPrayer);
      renderPrayers(session);
      form.hidden = false;
      alreadyWrap.hidden = true;
      textarea.value = text;
      if (counterEl) counterEl.textContent = getCharAndWordCount(text);
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = "Couldn't reach the server. Try again.";
        feedback.className = 'form-feedback error';
      }
      updatePrayerFormVisibility(session);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
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

let nudgeToastTimer = null;
function showNudgeToast(msg, isError = false) {
  const toast = document.getElementById('nudge-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.borderColor = isError ? 'var(--bad)' : 'var(--accent)';
  toast.hidden = false;
  toast.classList.add('visible');

  if (nudgeToastTimer) clearTimeout(nudgeToastTimer);
  nudgeToastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => {
      toast.hidden = true;
    }, 300);
  }, 3200);
}

async function handleNudgeUser(targetUsername, btnEl, session) {
  const curSession = session || getSession();
  if (!curSession || curSession.isGuest) {
    if (curSession && curSession.isGuest) {
      showNudgeToast('Guest users cannot send nudges.', true);
    }
    return;
  }
  if (btnEl.disabled || btnEl.classList.contains('nudged')) return;

  btnEl.disabled = true;
  btnEl.classList.add('nudged');
  btnEl.textContent = '⚡ Nudged!';
  nudgedTargetsToday.add(targetUsername);

  // Optimistically record nudge in local state
  currentNudges.push({
    sender: curSession.username,
    target: targetUsername
  });

  showNudgeToast(`⚡ Sent encouragement nudge to ${targetUsername}!`);

  try {
    const res = await apiGet({
      action: 'nudgeUser',
      senderUsername: curSession.username,
      password: curSession.password,
      targetUsername: targetUsername
    });
    if (!res || !res.success) {
      btnEl.textContent = '⚡ Nudge';
      btnEl.disabled = false;
      btnEl.classList.remove('nudged');
      nudgedTargetsToday.delete(targetUsername);
      currentNudges = currentNudges.filter(n => !(n.sender === curSession.username && n.target === targetUsername));
      if (res && res.error) {
        showNudgeToast(`Couldn't send nudge: ${res.error}`, true);
      }
    }
  } catch (err) {
    btnEl.textContent = '⚡ Nudge';
    btnEl.disabled = false;
    btnEl.classList.remove('nudged');
    nudgedTargetsToday.delete(targetUsername);
    showNudgeToast('Connection issue while sending nudge. Please retry.', true);
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

  if (session && session.isGuest) {
    btn.disabled = true;
    btn.classList.add('disabled-guest');
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('title', 'Guest users cannot share progress cards.');
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    return;
  }

  btn.disabled = false;
  btn.classList.remove('disabled-guest');
  btn.removeAttribute('aria-disabled');
  btn.removeAttribute('title');
  btn.onclick = () => {
    if (session && session.isGuest) return;
    openShareModal(session);
  };
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
  if (session && session.isGuest) return;
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

const SCRIPTURE_PORTION_KEY_VERSES = [
  // Genesis
  { bookId: 1, chapter: 1, text: "In the beginning God created the heavens and the earth.", ref: "Genesis 1:1" },
  { bookId: 1, chapter: 12, text: "I will make you into a great nation, and I will bless you; I will make your name great, and you will be a blessing.", ref: "Genesis 12:2" },
  { bookId: 1, chapter: 28, text: "I am with you and will watch over you wherever you go, and I will bring you back to this land.", ref: "Genesis 28:15" },
  { bookId: 1, chapter: 50, text: "You intended to harm me, but God intended it for good to accomplish what is now being done, the saving of many lives.", ref: "Genesis 50:20" },

  // Exodus
  { bookId: 2, chapter: 3, text: "God said to Moses, 'I AM WHO I AM.' This is what you are to say: 'I AM has sent me to you.'", ref: "Exodus 3:14" },
  { bookId: 2, chapter: 14, text: "The Lord will fight for you; you need only to be still.", ref: "Exodus 14:14" },
  { bookId: 2, chapter: 20, text: "You shall have no other gods before me.", ref: "Exodus 20:3" },
  { bookId: 2, chapter: 33, text: "The Lord replied, 'My Presence will go with you, and I will give you rest.'", ref: "Exodus 33:14" },

  // Leviticus
  { bookId: 3, chapter: 11, text: "I am the Lord your God; consecrate yourselves and be holy, because I am holy.", ref: "Leviticus 11:44" },
  { bookId: 3, chapter: 19, text: "Love your neighbor as yourself. I am the Lord.", ref: "Leviticus 19:18" },

  // Numbers
  { bookId: 4, chapter: 6, text: "The Lord bless you and keep you; the Lord make his face shine on you and be gracious to you; the Lord turn his face toward you and give you peace.", ref: "Numbers 6:24–26" },
  { bookId: 4, chapter: 23, text: "God is not human, that he should lie, not a human being, that he should change his mind. Does he speak and then not act?", ref: "Numbers 23:19" },

  // Deuteronomy
  { bookId: 5, chapter: 6, text: "Love the Lord your God with all your heart and with all your soul and with all your strength.", ref: "Deuteronomy 6:5" },
  { bookId: 5, chapter: 10, text: "What does the Lord your God ask of you but to fear the Lord your God, to walk in obedience to him, to love him, to serve the Lord your God with all your heart and with all your soul.", ref: "Deuteronomy 10:12" },
  { bookId: 5, chapter: 31, text: "Be strong and courageous. Do not be afraid or terrified because of them, for the Lord your God goes with you; he will never leave you nor forsake you.", ref: "Deuteronomy 31:6" },

  // Joshua
  { bookId: 6, chapter: 1, text: "Have I not commanded you? Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.", ref: "Joshua 1:9" },
  { bookId: 6, chapter: 24, text: "As for me and my household, we will serve the Lord.", ref: "Joshua 24:15" },

  // Judges
  { bookId: 7, chapter: 5, text: "May all who love you be like the sun when it rises in its strength.", ref: "Judges 5:31" },
  { bookId: 7, chapter: 6, text: "The angel of the Lord appeared to Gideon and said, 'The Lord is with you, mighty warrior.'", ref: "Judges 6:12" },

  // Ruth
  { bookId: 8, chapter: 1, text: "Where you go I will go, and where you stay I will stay. Your people will be my people and your God my God.", ref: "Ruth 1:16" },

  // 1 Samuel
  { bookId: 9, chapter: 12, text: "Be sure to fear the Lord and serve him faithfully with all your heart; consider what great things he has done for you.", ref: "1 Samuel 12:24" },
  { bookId: 9, chapter: 16, text: "The Lord does not look at the things people look at. People look at the outward appearance, but the Lord looks at the heart.", ref: "1 Samuel 16:7" },

  // 2 Samuel
  { bookId: 10, chapter: 7, text: "How great you are, Sovereign Lord! There is no one like you, and there is no God but you.", ref: "2 Samuel 7:22" },
  { bookId: 10, chapter: 22, text: "My God is my rock, in whom I take refuge, my shield and the horn of my salvation.", ref: "2 Samuel 22:3" },

  // 1 Kings
  { bookId: 11, chapter: 3, text: "Give your servant a discerning heart to govern your people and to distinguish between right and wrong.", ref: "1 Kings 3:9" },
  { bookId: 11, chapter: 8, text: "Praise be to the Lord, who has given rest to his people Israel just as he promised. Not one word has failed of all the good promises he gave.", ref: "1 Kings 8:56" },
  { bookId: 11, chapter: 18, text: "When all the people saw this, they fell prostrate and cried, 'The Lord—he is God! The Lord—he is God!'", ref: "1 Kings 18:39" },

  // 2 Kings
  { bookId: 12, chapter: 6, text: "'Don't be afraid,' the prophet answered. 'Those who are with us are more than those who are with them.'", ref: "2 Kings 6:16" },
  { bookId: 12, chapter: 19, text: "Now, Lord our God, deliver us from his hand, so that all the kingdoms of the earth may know that you alone, Lord, are God.", ref: "2 Kings 19:19" },

  // 1 Chronicles
  { bookId: 13, chapter: 16, text: "Look to the Lord and his strength; seek his face always.", ref: "1 Chronicles 16:11" },
  { bookId: 13, chapter: 29, text: "Yours, Lord, is the greatness and the power and the glory and the majesty and the splendor, for everything in heaven and earth is yours.", ref: "1 Chronicles 29:11" },

  // 2 Chronicles
  { bookId: 14, chapter: 7, text: "If my people, who are called by my name, will humble themselves and pray and seek my face and turn from their wicked ways, then I will hear from heaven, and I will forgive their sin and will heal their land.", ref: "2 Chronicles 7:14" },
  { bookId: 14, chapter: 20, text: "We do not know what to do, but our eyes are on you.", ref: "2 Chronicles 20:12" },

  // Ezra
  { bookId: 15, chapter: 7, text: "For Ezra had devoted himself to the study and observance of the Law of the Lord, and to teaching its decrees and laws in Israel.", ref: "Ezra 7:10" },

  // Nehemiah
  { bookId: 16, chapter: 8, text: "Do not grieve, for the joy of the Lord is your strength.", ref: "Nehemiah 8:10" },

  // Esther
  { bookId: 17, chapter: 4, text: "And who knows but that you have come to your royal position for such a time as this?", ref: "Esther 4:14" },

  // Job
  { bookId: 18, chapter: 19, text: "I know that my redeemer lives, and that in the end he will stand on the earth.", ref: "Job 19:25" },
  { bookId: 18, chapter: 42, text: "I know that you can do all things; no purpose of yours can be thwarted.", ref: "Job 42:2" },

  // Psalms
  { bookId: 19, chapter: 1, text: "Blessed is the one whose delight is in the law of the Lord, and who meditates on his law day and night.", ref: "Psalm 1:1–2" },
  { bookId: 19, chapter: 23, text: "The Lord is my shepherd, I lack nothing. He makes me lie down in green pastures, he leads me beside quiet waters.", ref: "Psalm 23:1–2" },
  { bookId: 19, chapter: 27, text: "The Lord is my light and my salvation—whom shall I fear? The Lord is the stronghold of my life—of whom shall I be afraid?", ref: "Psalm 27:1" },
  { bookId: 19, chapter: 46, text: "God is our refuge and strength, an ever-present help in trouble.", ref: "Psalm 46:1" },
  { bookId: 19, chapter: 51, text: "Create in me a pure heart, O God, and renew a steadfast spirit within me.", ref: "Psalm 51:10" },
  { bookId: 19, chapter: 91, text: "Whoever dwells in the shelter of the Most High will rest in the shadow of the Almighty.", ref: "Psalm 91:1" },
  { bookId: 19, chapter: 103, text: "Praise the Lord, my soul; all my inmost being, praise his holy name. Praise the Lord, my soul, and forget not all his benefits.", ref: "Psalm 103:1–2" },
  { bookId: 19, chapter: 119, text: "Your word is a lamp to my feet and a light to my path.", ref: "Psalm 119:105" },
  { bookId: 19, chapter: 121, text: "I lift up my eyes to the mountains—where does my help come from? My help comes from the Lord, the Maker of heaven and earth.", ref: "Psalm 121:1–2" },
  { bookId: 19, chapter: 139, text: "I praise you because I am fearfully and wonderfully made; your works are wonderful, I know that full well.", ref: "Psalm 139:14" },

  // Proverbs
  { bookId: 20, chapter: 3, text: "Trust in the Lord with all your heart and lean not on your own understanding; in all your ways submit to him, and he will make your paths straight.", ref: "Proverbs 3:5–6" },
  { bookId: 20, chapter: 4, text: "Above all else, guard your heart, for everything you do flows from it.", ref: "Proverbs 4:23" },
  { bookId: 20, chapter: 16, text: "Commit to the Lord whatever you do, and he will establish your plans.", ref: "Proverbs 16:3" },
  { bookId: 20, chapter: 18, text: "The name of the Lord is a fortified tower; the righteous run to it and are safe.", ref: "Proverbs 18:10" },
  { bookId: 20, chapter: 31, text: "Charm is deceptive, and beauty is fleeting; but a woman who fears the Lord is to be praised.", ref: "Proverbs 31:30" },

  // Ecclesiastes
  { bookId: 21, chapter: 3, text: "He has made everything beautiful in its time. He has also set eternity in the human heart.", ref: "Ecclesiastes 3:11" },
  { bookId: 21, chapter: 12, text: "Fear God and keep his commandments, for this is the duty of all mankind.", ref: "Ecclesiastes 12:13" },

  // Song of Songs
  { bookId: 22, chapter: 8, text: "Many waters cannot quench love; rivers cannot sweep it away.", ref: "Song of Songs 8:7" },

  // Isaiah
  { bookId: 23, chapter: 9, text: "For to us a child is born, to us a son is given, and the government will be on his shoulders. And he will be called Wonderful Counselor, Mighty God, Everlasting Father, Prince of Peace.", ref: "Isaiah 9:6" },
  { bookId: 23, chapter: 26, text: "You will keep in perfect peace those whose minds are steadfast, because they trust in you.", ref: "Isaiah 26:3" },
  { bookId: 23, chapter: 40, text: "Those who hope in the Lord will renew their strength. They will soar on wings like eagles; they will run and not grow weary, they will walk and not be faint.", ref: "Isaiah 40:31" },
  { bookId: 23, chapter: 41, text: "So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand.", ref: "Isaiah 41:10" },
  { bookId: 23, chapter: 43, text: "Do not fear, for I have redeemed you; I have summoned you by name; you are mine.", ref: "Isaiah 43:1" },
  { bookId: 23, chapter: 53, text: "He was pierced for our transgressions, he was crushed for our iniquities; the punishment that brought us peace was on him, and by his wounds we are healed.", ref: "Isaiah 53:5" },
  { bookId: 23, chapter: 55, text: "Seek the Lord while he may be found; call on him while he is near.", ref: "Isaiah 55:6" },

  // Jeremiah
  { bookId: 24, chapter: 1, text: "Before I formed you in the womb I knew you, before you were born I set you apart.", ref: "Jeremiah 1:5" },
  { bookId: 24, chapter: 17, text: "Blessed is the one who trusts in the Lord, whose confidence is in him.", ref: "Jeremiah 17:7" },
  { bookId: 24, chapter: 29, text: "'For I know the plans I have for you,' declares the Lord, 'plans to prosper you and not to harm you, plans to give you hope and a future.'", ref: "Jeremiah 29:11" },
  { bookId: 24, chapter: 33, text: "Call to me and I will answer you and tell you great and unsearchable things you do not know.", ref: "Jeremiah 33:3" },

  // Lamentations
  { bookId: 25, chapter: 3, text: "Because of the Lord's great love we are not consumed, for his compassions never fail. They are new every morning; great is your faithfulness.", ref: "Lamentations 3:22–23" },

  // Ezekiel
  { bookId: 26, chapter: 11, text: "I will give them an undivided heart and put a new spirit in them; I will remove from them their heart of stone and give them a heart of flesh.", ref: "Ezekiel 11:19" },
  { bookId: 26, chapter: 36, text: "I will give you a new heart and put a new spirit in you; I will remove from you your heart of stone and give you a heart of flesh.", ref: "Ezekiel 36:26" },
  { bookId: 26, chapter: 37, text: "This is what the Sovereign Lord says: Come, breath, from the four winds and breathe into these slain, that they may live.", ref: "Ezekiel 37:9" },

  // Daniel
  { bookId: 27, chapter: 3, text: "If we are thrown into the blazing furnace, the God we serve is able to deliver us from it.", ref: "Daniel 3:17" },
  { bookId: 27, chapter: 6, text: "He rescues and he saves; he performs signs and wonders in the heavens and on the earth. He has rescued Daniel from the power of the lions.", ref: "Daniel 6:27" },
  { bookId: 27, chapter: 12, text: "Those who are wise will shine like the brightness of the heavens, and those who lead many to righteousness, like the stars for ever and ever.", ref: "Daniel 12:3" },

  // Minor Prophets
  { bookId: 28, chapter: 6, text: "For I desire mercy, not sacrifice, and acknowledgment of God rather than burnt offerings.", ref: "Hosea 6:6" },
  { bookId: 29, chapter: 2, text: "And afterward, I will pour out my Spirit on all people. Your sons and daughters will prophesy, your old men will dream dreams, your young men will see visions.", ref: "Joel 2:28" },
  { bookId: 30, chapter: 5, text: "Let justice roll on like a river, righteousness like a never-failing stream!", ref: "Amos 5:24" },
  { bookId: 31, chapter: 1, text: "Deliverers will go up on Mount Zion to govern... And the kingdom will be the Lord's.", ref: "Obadiah 1:21" },
  { bookId: 32, chapter: 2, text: "What I have vowed I will make good. I will say, 'Salvation comes from the Lord.'", ref: "Jonah 2:9" },
  { bookId: 33, chapter: 6, text: "He has shown you, O mortal, what is good. And what does the Lord require of you? To act justly and to love mercy and to walk humbly with your God.", ref: "Micah 6:8" },
  { bookId: 34, chapter: 1, text: "The Lord is good, a refuge in times of trouble. He cares for those who trust in him.", ref: "Nahum 1:7" },
  { bookId: 35, chapter: 3, text: "Though the fig tree does not bud and there are no grapes on the vines... yet I will rejoice in the Lord, I will be joyful in God my Savior.", ref: "Habakkuk 3:17–18" },
  { bookId: 36, chapter: 3, text: "The Lord your God is with you, the Mighty Warrior who saves. He will take great delight in you; in his love he will no longer rebuke you, but will rejoice over you with singing.", ref: "Zephaniah 3:17" },
  { bookId: 37, chapter: 2, text: "'The glory of this present house will be greater than the glory of the former house,' says the Lord Almighty. 'And in this place I will grant peace.'", ref: "Haggai 2:9" },
  { bookId: 38, chapter: 4, text: "'Not by might nor by power, but by my Spirit,' says the Lord Almighty.", ref: "Zechariah 4:6" },
  { bookId: 39, chapter: 3, text: "Bring the whole tithe into the storehouse... and see if I will not throw open the floodgates of heaven and pour out so much blessing that there will not be room enough to store it.", ref: "Malachi 3:10" },

  // Gospels
  { bookId: 40, chapter: 5, text: "Blessed are the pure in heart, for they will see God. Blessed are the peacemakers, for they will be called children of God.", ref: "Matthew 5:8–9" },
  { bookId: 40, chapter: 6, text: "Seek first his kingdom and his righteousness, and all these things will be given to you as well.", ref: "Matthew 6:33" },
  { bookId: 40, chapter: 7, text: "Ask and it will be given to you; seek and you will find; knock and the door will be opened to you.", ref: "Matthew 7:7" },
  { bookId: 40, chapter: 11, text: "Come to me, all you who are weary and burdened, and I will give you rest.", ref: "Matthew 11:28" },
  { bookId: 40, chapter: 22, text: "'Love the Lord your God with all your heart and with all your soul and with all your mind.' This is the first and greatest commandment.", ref: "Matthew 22:37–38" },
  { bookId: 40, chapter: 28, text: "Therefore go and make disciples of all nations, baptizing them in the name of the Father and of the Son and of the Holy Spirit.", ref: "Matthew 28:19" },

  { bookId: 41, chapter: 8, text: "What good is it for someone to gain the whole world, yet forfeit their soul?", ref: "Mark 8:36" },
  { bookId: 41, chapter: 10, text: "For even the Son of Man did not come to be served, but to serve, and to give his life as a ransom for many.", ref: "Mark 10:45" },
  { bookId: 41, chapter: 11, text: "Whatever you ask for in prayer, believe that you have received it, and it will be yours.", ref: "Mark 11:24" },

  { bookId: 42, chapter: 1, text: "For no word from God will ever fail.", ref: "Luke 1:37" },
  { bookId: 42, chapter: 2, text: "Glory to God in the highest heaven, and on earth peace to those on whom his favor rests.", ref: "Luke 2:14" },
  { bookId: 42, chapter: 9, text: "Whoever wants to be my disciple must deny themselves and take up their cross daily and follow me.", ref: "Luke 9:23" },
  { bookId: 42, chapter: 12, text: "Do not be afraid, little flock, for your Father has been pleased to give you the kingdom.", ref: "Luke 12:32" },
  { bookId: 42, chapter: 19, text: "For the Son of Man came to seek and to save the lost.", ref: "Luke 19:10" },
  { bookId: 42, chapter: 24, text: "He is not here; he has risen! Remember how he told you, while he was still with you in Galilee.", ref: "Luke 24:6" },

  { bookId: 43, chapter: 1, text: "In the beginning was the Word, and the Word was with God, and the Word was God.", ref: "John 1:1" },
  { bookId: 43, chapter: 3, text: "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life.", ref: "John 3:16" },
  { bookId: 43, chapter: 8, text: "Jesus spoke to the people, 'I am the light of the world. Whoever follows me will never walk in darkness, but will have the light of life.'", ref: "John 8:12" },
  { bookId: 43, chapter: 10, text: "I have come that they may have life, and have it to the full. I am the good shepherd.", ref: "John 10:10–11" },
  { bookId: 43, chapter: 11, text: "Jesus said to her, 'I am the resurrection and the life. The one who believes in me will live, even though they die.'", ref: "John 11:25" },
  { bookId: 43, chapter: 14, text: "Jesus answered, 'I am the way and the truth and the life. No one comes to the Father except through me.'", ref: "John 14:6" },
  { bookId: 43, chapter: 15, text: "I am the vine; you are the branches. If you remain in me and I in you, you will bear much fruit; apart from me you can do nothing.", ref: "John 15:5" },
  { bookId: 43, chapter: 16, text: "In this world you will have trouble. But take heart! I have overcome the world.", ref: "John 16:33" },

  // Acts
  { bookId: 44, chapter: 1, text: "You will receive power when the Holy Spirit comes on you; and you will be my witnesses in Jerusalem, and in all Judea and Samaria, and to the ends of the earth.", ref: "Acts 1:8" },
  { bookId: 44, chapter: 2, text: "They devoted themselves to the apostles' teaching and to fellowship, to the breaking of bread and to prayer.", ref: "Acts 2:42" },
  { bookId: 44, chapter: 4, text: "Salvation is found in no one else, for there is no other name under heaven given to mankind by which we must be saved.", ref: "Acts 4:12" },
  { bookId: 44, chapter: 16, text: "They replied, 'Believe in the Lord Jesus, and you will be saved—you and your household.'", ref: "Acts 16:31" },
  { bookId: 44, chapter: 20, text: "I consider my life worth nothing to me; my only aim is to finish the race and complete the task the Lord Jesus has given me.", ref: "Acts 20:24" },

  // Romans
  { bookId: 45, chapter: 1, text: "For I am not ashamed of the gospel, because it is the power of God that brings salvation to everyone who believes.", ref: "Romans 1:16" },
  { bookId: 45, chapter: 5, text: "God demonstrates his own love for us in this: While we were still sinners, Christ died for us.", ref: "Romans 5:8" },
  { bookId: 45, chapter: 6, text: "For the wages of sin is death, but the gift of God is eternal life in Christ Jesus our Lord.", ref: "Romans 6:23" },
  { bookId: 45, chapter: 8, text: "And we know that in all things God works for the good of those who love him, who have been called according to his purpose.", ref: "Romans 8:28" },
  { bookId: 45, chapter: 10, text: "If you declare with your mouth, 'Jesus is Lord,' and believe in your heart that God raised him from the dead, you will be saved.", ref: "Romans 10:9" },
  { bookId: 45, chapter: 12, text: "Do not conform to the pattern of this world, but be transformed by the renewing of your mind. Then you will be able to test and approve what God's will is.", ref: "Romans 12:2" },

  // 1 & 2 Corinthians
  { bookId: 46, chapter: 1, text: "For the message of the cross is foolishness to those who are perishing, but to us who are being saved it is the power of God.", ref: "1 Corinthians 1:18" },
  { bookId: 46, chapter: 10, text: "No temptation has overtaken you except what is common to mankind. And God is faithful; he will not let you be tempted beyond what you can bear.", ref: "1 Corinthians 10:13" },
  { bookId: 46, chapter: 13, text: "Love is patient, love is kind. It does not envy, it does not boast, it is not proud... And now these three remain: faith, hope and love. But the greatest of these is love.", ref: "1 Corinthians 13:4,13" },
  { bookId: 46, chapter: 15, text: "Where, O death, is your victory? Where, O death, is your sting? But thanks be to God! He gives us the victory through our Lord Jesus Christ.", ref: "1 Corinthians 15:55,57" },
  { bookId: 47, chapter: 4, text: "For our light and momentary troubles are achieving for us an eternal glory that far outweighs them all.", ref: "2 Corinthians 4:17" },
  { bookId: 47, chapter: 5, text: "Therefore, if anyone is in Christ, the new creation has come: The old has gone, the new is here!", ref: "2 Corinthians 5:17" },
  { bookId: 47, chapter: 12, text: "He said to me, 'My grace is sufficient for you, for my power is made perfect in weakness.'", ref: "2 Corinthians 12:9" },

  // Galatians & Ephesians
  { bookId: 48, chapter: 2, text: "I have been crucified with Christ and I no longer live, but Christ lives in me. The life I now live in the body, I live by faith in the Son of God.", ref: "Galatians 2:20" },
  { bookId: 48, chapter: 5, text: "The fruit of the Spirit is love, joy, peace, forbearance, kindness, goodness, faithfulness, gentleness and self-control.", ref: "Galatians 5:22–23" },
  { bookId: 49, chapter: 2, text: "For it is by grace you have been saved, through faith—and this is not from yourselves, it is the gift of God—not by works, so that no one can boast.", ref: "Ephesians 2:8–9" },
  { bookId: 49, chapter: 3, text: "Now to him who is able to do immeasurably more than all we ask or imagine, according to his power that is at work within us.", ref: "Ephesians 3:20" },
  { bookId: 49, chapter: 6, text: "Put on the full armor of God, so that you can take your stand against the devil's schemes.", ref: "Ephesians 6:11" },

  // Philippians & Colossians
  { bookId: 50, chapter: 1, text: "Being confident of this, that he who began a good work in you will carry it on to completion until the day of Christ Jesus.", ref: "Philippians 1:6" },
  { bookId: 50, chapter: 4, text: "I can do all this through him who gives me strength.", ref: "Philippians 4:13" },
  { bookId: 51, chapter: 3, text: "Whatever you do, work at it with all your heart, as working for the Lord, not for human masters.", ref: "Colossians 3:23" },

  // 1 & 2 Thessalonians
  { bookId: 52, chapter: 5, text: "Rejoice always, pray continually, give thanks in all circumstances; for this is God's will for you in Christ Jesus.", ref: "1 Thessalonians 5:16–18" },
  { bookId: 53, chapter: 3, text: "The Lord is faithful, and he will strengthen you and protect you from the evil one.", ref: "2 Thessalonians 3:3" },

  // 1 & 2 Timothy, Titus, Philemon
  { bookId: 54, chapter: 4, text: "Don't let anyone look down on you because you are young, but set an example for the believers in speech, in conduct, in love, in faith and in purity.", ref: "1 Timothy 4:12" },
  { bookId: 54, chapter: 6, text: "Fight the good fight of the faith. Take hold of the eternal life to which you were called.", ref: "1 Timothy 6:12" },
  { bookId: 55, chapter: 1, text: "For the Spirit God gave us does not make us timid, but gives us power, love and self-discipline.", ref: "2 Timothy 1:7" },
  { bookId: 55, chapter: 3, text: "All Scripture is God-breathed and is useful for teaching, rebuking, correcting and training in righteousness.", ref: "2 Timothy 3:16" },
  { bookId: 56, chapter: 2, text: "For the grace of God has appeared that offers salvation to all people.", ref: "Titus 2:11" },
  { bookId: 57, chapter: 1, text: "Your love has given me great joy and encouragement, because you, brother, have refreshed the hearts of the Lord's people.", ref: "Philemon 1:7" },

  // Hebrews & James
  { bookId: 58, chapter: 4, text: "Let us then approach God's throne of grace with confidence, so that we may receive mercy and find grace to help us in our time of need.", ref: "Hebrews 4:16" },
  { bookId: 58, chapter: 11, text: "Now faith is confidence in what we hope for and assurance about what we do not see.", ref: "Hebrews 11:1" },
  { bookId: 58, chapter: 12, text: "Let us run with perseverance the race marked out for us, fixing our eyes on Jesus, the pioneer and perfecter of faith.", ref: "Hebrews 12:1–2" },
  { bookId: 58, chapter: 13, text: "Jesus Christ is the same yesterday and today and forever.", ref: "Hebrews 13:8" },
  { bookId: 59, chapter: 1, text: "Do not merely listen to the word, and so deceive yourselves. Do what it says.", ref: "James 1:22" },
  { bookId: 59, chapter: 4, text: "Come near to God and he will come near to you.", ref: "James 4:8" },

  // Peter, John, Jude
  { bookId: 60, chapter: 1, text: "Praise be to the God and Father of our Lord Jesus Christ! In his great mercy he has given us new birth into a living hope through the resurrection of Jesus Christ.", ref: "1 Peter 1:3" },
  { bookId: 60, chapter: 5, text: "Cast all your anxiety on him because he cares for you.", ref: "1 Peter 5:7" },
  { bookId: 61, chapter: 3, text: "The Lord is not slow in keeping his promise, as some understand slowness. Instead he is patient with you, not wanting anyone to perish.", ref: "2 Peter 3:9" },
  { bookId: 62, chapter: 1, text: "If we confess our sins, he is faithful and just and will forgive us our sins and purify us from all unrighteousness.", ref: "1 John 1:9" },
  { bookId: 62, chapter: 4, text: "We love because he first loved us.", ref: "1 John 4:19" },
  { bookId: 63, chapter: 1, text: "And this is love: that we walk in obedience to his commands.", ref: "2 John 1:6" },
  { bookId: 64, chapter: 1, text: "I have no greater joy than to hear that my children are walking in the truth.", ref: "3 John 1:4" },
  { bookId: 65, chapter: 1, text: "To him who is able to keep you from stumbling and to present you before his glorious presence without fault and with great joy—to the only God our Savior be glory!", ref: "Jude 1:24–25" },

  // Revelation
  { bookId: 66, chapter: 1, text: "'I am the Alpha and the Omega,' says the Lord God, 'who is, and who was, and who is to come, the Almighty.'", ref: "Revelation 1:8" },
  { bookId: 66, chapter: 3, text: "Here I am! I stand at the door and knock. If anyone hears my voice and opens the door, I will come in and eat with that person, and they with me.", ref: "Revelation 3:20" },
  { bookId: 66, chapter: 21, text: "He will wipe every tear from their eyes. There will be no more death or mourning or crying or pain, for the old order of things has passed away.", ref: "Revelation 21:4" },
  { bookId: 66, chapter: 22, text: "'Look, I am coming soon! My reward is with me, and I will give to each person according to what they have done.'", ref: "Revelation 22:12" }
];

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
  const parsed = parsePassage(portionText);
  if (parsed.isCatchUp) {
    return {
      text: "Be still, and know that I am God; I will be exalted among the nations, I will be exalted in the earth.",
      ref: "Psalm 46:10"
    };
  }

  if (parsed.chapters && parsed.chapters.length > 0) {
    // 1. Look for exact matches where both bookId and chapter fall within this portion's chapters
    const matched = SCRIPTURE_PORTION_KEY_VERSES.filter(kv => 
      parsed.chapters.some(ch => ch.bookId === kv.bookId && ch.chapter === kv.chapter)
    );

    if (matched.length > 0) {
      return matched[0];
    }

    // 2. Secondary fallback: Match any curated key verse from one of the books in this portion
    const bookMatched = SCRIPTURE_PORTION_KEY_VERSES.filter(kv =>
      parsed.chapters.some(ch => ch.bookId === kv.bookId)
    );
    if (bookMatched.length > 0) {
      return bookMatched[0];
    }

    const first = parsed.chapters[0];
    return {
      text: `Let the word of Christ dwell in you richly, teaching and admonishing one another in all wisdom.`,
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
        playAudioFromChapter(ch.bookId, ch.chapter);
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

    if (tabsContainer) {
      initReaderScrollSpy(contentContainer, tabsContainer);
    }

    if (targetChapterObj) {
      setTimeout(() => {
        const targetEl = document.getElementById(`reader-ch-${targetChapterObj.bookId}-${targetChapterObj.chapter}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
    updateAudioChapterInfo(portionText);
    audioVerseQueue = prepareAudioVerseQueue();
  } catch (err) {
    contentContainer.innerHTML = `
      <div class="reader-loading-state">
        <p style="color: var(--bad);">Couldn't load Scripture text from online Bible service.</p>
        <p style="color: var(--text-muted); font-size: 0.9rem;">You can read today's portion directly via Bible Gateway below.</p>
      </div>
    `;
  }
}

function initReaderScrollSpy(contentEl, tabsContainer) {
  if (!contentEl || !tabsContainer) return;
  const sections = Array.from(contentEl.querySelectorAll('.reader-chapter-section'));
  if (sections.length === 0) return;

  const updateActiveTab = (activeId) => {
    tabsContainer.querySelectorAll('.reader-tab-btn').forEach(btn => {
      const isTarget = btn.dataset.targetId === activeId;
      if (btn.classList.contains('active') !== isTarget) {
        btn.classList.toggle('active', isTarget);
        if (isTarget) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }
    });
  };

  const checkScrollPosition = () => {
    const containerRect = contentEl.getBoundingClientRect();
    let currentActiveId = sections[0].id;

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const secRect = sec.getBoundingClientRect();
      const relativeTop = secRect.top - containerRect.top;
      // Immediately activate chapter as soon as its top boundary reaches visible reader area
      if (relativeTop <= 90) {
        currentActiveId = sec.id;
      } else {
        break;
      }
    }
    updateActiveTab(currentActiveId);
  };

  if (contentEl._scrollSpyHandler) {
    contentEl.removeEventListener('scroll', contentEl._scrollSpyHandler);
  }
  contentEl._scrollSpyHandler = checkScrollPosition;
  contentEl.addEventListener('scroll', checkScrollPosition, { passive: true });
  checkScrollPosition();
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
let audioKeepAliveTimer = null;
let audioPlaybackSeconds = 0;
let estimatedAudioDuration = 180;
let audioVerseQueue = [];
let currentAudioVerseIndex = 0;
let audioAvailableVoices = [];

const NARRATOR_VOICES = [
  { id: 'us_male', label: 'US (Male)', region: 'US', gender: 'Male', lang: 'en-US', fallbackPitch: 0.92 },
  { id: 'us_female', label: 'United States (Female)', region: 'US', gender: 'Female', lang: 'en-US', fallbackPitch: 1.05 },
  { id: 'uk_male', label: 'United Kingdom (Male)', region: 'UK', gender: 'Male', lang: 'en-GB', fallbackPitch: 0.92 },
  { id: 'uk_female', label: 'United Kingdom (Female)', region: 'UK', gender: 'Female', lang: 'en-GB', fallbackPitch: 1.05 }
];

function initAudioNarrator() {
  const playBtn = document.getElementById('audio-play-btn');
  const skipBackBtn = document.getElementById('audio-skip-back-btn');
  const skipFwdBtn = document.getElementById('audio-skip-fwd-btn');
  const speedSelect = document.getElementById('audio-speed-select');
  const voiceSelect = document.getElementById('audio-voice-select');

  if ('speechSynthesis' in window) {
    audioSpeechSynth = window.speechSynthesis;
    const refreshVoices = () => {
      try {
        audioAvailableVoices = audioSpeechSynth.getVoices() || [];
        populateAudioVoiceDropdown();
      } catch (e) {}
    };
    refreshVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = refreshVoices;
    }
  } else {
    populateAudioVoiceDropdown();
  }

  if (playBtn) {
    playBtn.onclick = () => {
      toggleAudioPlayback();
    };
  }

  if (skipBackBtn) {
    skipBackBtn.onclick = () => {
      seekAudioVerse(-1);
    };
  }

  if (skipFwdBtn) {
    skipFwdBtn.onclick = () => {
      seekAudioVerse(1);
    };
  }

  const savedSpeed = localStorage.getItem('bible92_preferred_audio_speed');
  if (savedSpeed && speedSelect) {
    speedSelect.value = savedSpeed;
  }

  if (speedSelect) {
    speedSelect.onchange = () => {
      try {
        localStorage.setItem('bible92_preferred_audio_speed', speedSelect.value);
      } catch (e) {}
      if (isAudioPlaying) {
        playAudioVerseChunk(currentAudioVerseIndex);
      }
    };
  }

  if (voiceSelect) {
    voiceSelect.onchange = () => {
      const selectedVoiceId = voiceSelect.value;
      if (selectedVoiceId) {
        try {
          localStorage.setItem('bible92_preferred_voice_id', selectedVoiceId);
        } catch (e) {}
      }
      if (isAudioPlaying) {
        playAudioVerseChunk(currentAudioVerseIndex);
      }
    };
  }
}

function findMatchingSystemVoice(targetConfig) {
  if (!audioSpeechSynth) return null;
  const voices = audioAvailableVoices.length ? audioAvailableVoices : (audioSpeechSynth.getVoices() || []);
  if (!voices.length) return null;

  const femaleKeywords = /\b(female|woman|girl|samantha|victoria|karen|fiona|moira|tessa|zira|jenny|aria|emma|sonia|libby|natasha|mia|clara|stephanie|anita|heera|veena|susan|linda|hazel|catherine|elizabeth|serena|ava|allison|joana|salli|ivy|kendra|kimberly|amy|alice|olivia|emily|sarah|chloe|aditi|raveena)\b/i;
  const maleKeywords = /\b(male|man|boy|david|mark|guy|george|daniel|oliver|james|arthur|ryan|liam|aaron|alex|richard|tom|matthew|justin|joey|brian|russell|eric|christopher|benjamin|stefan|steve|steven|john|paul|peter|luke|connor|fred|nate|evan|ravi|hemant)\b/i;

  let bestVoice = null;
  let bestScore = -999;

  for (const v of voices) {
    const name = (v.name || '').toLowerCase();
    const lang = (v.lang || '').replace(/_/g, '-').toLowerCase();
    let score = 0;

    const isTargetUS = targetConfig.region === 'US';
    const isTargetUK = targetConfig.region === 'UK';

    // 1. Language & Region Matching
    if (isTargetUS) {
      if (lang.startsWith('en-us')) score += 50;
      else if (name.includes('united states') || name.includes('us english') || name.includes('(us)')) score += 45;
      else if (lang.startsWith('en') && !lang.startsWith('en-gb') && !name.includes('uk') && !name.includes('british')) score += 10;
      else score -= 40;
    } else if (isTargetUK) {
      if (lang.startsWith('en-gb')) score += 50;
      else if (name.includes('united kingdom') || name.includes('uk english') || name.includes('british') || name.includes('(uk)')) score += 45;
      else if (lang.startsWith('en') && !lang.startsWith('en-us')) score += 10;
      else score -= 40;
    }

    // 2. Gender Matching
    const isFemale = femaleKeywords.test(name) || (name.includes('female') && !name.includes('male'));
    const isMale = maleKeywords.test(name) || (name.includes('male') && !name.includes('female'));

    if (targetConfig.gender === 'Female') {
      if (isFemale) score += 40;
      else if (isMale) score -= 80;
    } else if (targetConfig.gender === 'Male') {
      if (isMale) score += 40;
      else if (isFemale) score -= 80;
    }

    // 3. Quality Bonus
    if (name.includes('natural') || name.includes('neural') || name.includes('online')) score += 15;
    if (name.includes('google') || name.includes('apple') || name.includes('siri')) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestVoice = v;
    }
  }

  if (bestScore > 0 && bestVoice) {
    return bestVoice;
  }

  // Fallback to language-matching voice or default
  const fallback = voices.find(v => (v.lang || '').toLowerCase().startsWith(targetConfig.lang.toLowerCase())) ||
                 voices.find(v => (v.lang || '').toLowerCase().startsWith('en')) ||
                 voices[0];
  return fallback || null;
}

function getNarratorVoiceConfig() {
  const voiceSelect = document.getElementById('audio-voice-select');
  const selectedId = (voiceSelect && voiceSelect.value) || localStorage.getItem('bible92_preferred_voice_id') || 'us_female';
  const config = NARRATOR_VOICES.find(v => v.id === selectedId) || NARRATOR_VOICES[1];
  const matchedVoice = findMatchingSystemVoice(config);
  return {
    config,
    voice: matchedVoice
  };
}

function populateAudioVoiceDropdown() {
  const voiceSelect = document.getElementById('audio-voice-select');
  if (!voiceSelect) return;

  const savedVoiceId = localStorage.getItem('bible92_preferred_voice_id') || 'us_female';
  voiceSelect.innerHTML = '';

  NARRATOR_VOICES.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    if (v.id === savedVoiceId) {
      opt.selected = true;
    }
    voiceSelect.appendChild(opt);
  });

  voiceSelect.value = savedVoiceId;
}

function getBestVoice() {
  return getNarratorVoiceConfig().voice;
}

function prepareAudioVerseQueue() {
  const contentEl = document.getElementById('reader-content');
  if (!contentEl) return [];

  const queue = [];
  const sections = contentEl.querySelectorAll('.reader-chapter-section');

  if (sections.length > 0) {
    sections.forEach(section => {
      const heading = section.querySelector('.reader-chapter-heading');
      if (heading && heading.textContent.trim()) {
        queue.push({
          text: heading.textContent.trim() + '.',
          element: heading
        });
      }

      const rows = section.querySelectorAll('.verse-row');
      rows.forEach(row => {
        const verseTextEl = row.querySelector('.verse-text');
        const text = verseTextEl ? verseTextEl.textContent.trim() : row.textContent.trim();
        if (text) {
          queue.push({
            text: text,
            element: row
          });
        }
      });
    });
  } else {
    // Fallback if no structured sections
    const rows = contentEl.querySelectorAll('.verse-row');
    if (rows.length > 0) {
      rows.forEach(row => {
        const verseTextEl = row.querySelector('.verse-text');
        const text = verseTextEl ? verseTextEl.textContent.trim() : row.textContent.trim();
        if (text) {
          queue.push({
            text: text,
            element: row
          });
        }
      });
    } else {
      // General paragraph fallback
      const paras = contentEl.querySelectorAll('p');
      paras.forEach(p => {
        const text = p.textContent.trim();
        if (text && !p.classList.contains('reader-loading-state')) {
          queue.push({
            text: text,
            element: p
          });
        }
      });
    }
  }

  return queue;
}

function playAudioFromChapter(bookId, chapter) {
  if (!audioVerseQueue || audioVerseQueue.length === 0) {
    audioVerseQueue = prepareAudioVerseQueue();
  }
  if (!audioVerseQueue || audioVerseQueue.length === 0) return;

  const targetSectionId = `reader-ch-${bookId}-${chapter}`;
  const sectionEl = document.getElementById(targetSectionId);

  let targetIdx = 0;
  if (sectionEl) {
    const foundIdx = audioVerseQueue.findIndex(chunk => 
      chunk.element && (chunk.element === sectionEl || sectionEl.contains(chunk.element))
    );
    if (foundIdx !== -1) {
      targetIdx = foundIdx;
    }
  }

  currentAudioVerseIndex = targetIdx;
  isAudioPlaying = true;
  playAudioVerseChunk(targetIdx);
}

let silentAudioEl = null;
let audioWakeLock = null;

function playSilentBackgroundAudioTrack() {
  try {
    if (!silentAudioEl) {
      silentAudioEl = document.getElementById('bible-audio-player');
      if (!silentAudioEl) {
        silentAudioEl = document.createElement('audio');
        silentAudioEl.id = 'bible-audio-player';
        silentAudioEl.hidden = true;
        document.body.appendChild(silentAudioEl);
      }
      silentAudioEl.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      silentAudioEl.loop = true;
    }
    const p = silentAudioEl.play();
    if (p !== undefined) {
      p.catch(() => {});
    }
  } catch (e) {}
}

function pauseSilentBackgroundAudioTrack() {
  try {
    if (silentAudioEl) {
      silentAudioEl.pause();
    }
  } catch (e) {}
}

async function requestAudioWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      if (!audioWakeLock) {
        audioWakeLock = await navigator.wakeLock.request('screen');
        audioWakeLock.addEventListener('release', () => {
          audioWakeLock = null;
        });
      }
    } catch (err) {}
  }
}

function releaseAudioWakeLock() {
  if (audioWakeLock) {
    try {
      audioWakeLock.release();
    } catch (e) {}
    audioWakeLock = null;
  }
}

function updateAudioMediaSession(chunkText) {
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chunkText ? chunkText.substring(0, 45) + '…' : (currentAudioChapterName || "Scripture Audio Narrator"),
        artist: "Project Bible 92",
        album: "The Youth Gathering 2026"
      });
      navigator.mediaSession.setActionHandler('play', () => {
        if (!isAudioPlaying) startAudioPlayback();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (isAudioPlaying) stopAudioPlayback();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        seekAudioVerse(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        seekAudioVerse(1);
      });
    } catch (e) {}
  }
}

function playAudioVerseChunk(index) {
  if (!('speechSynthesis' in window)) {
    alert("Audio speech synthesis is not supported on this browser.");
    return;
  }
  audioSpeechSynth = window.speechSynthesis;

  if (index < 0) index = 0;
  if (index >= audioVerseQueue.length) {
    stopAudioPlayback();
    return;
  }

  currentAudioVerseIndex = index;
  const chunk = audioVerseQueue[index];
  if (!chunk) {
    stopAudioPlayback();
    return;
  }

  // Highlight active verse in reader UI and scroll gently if out of view
  document.querySelectorAll('.verse-row.speaking-verse, .reader-chapter-heading.speaking-verse').forEach(el => el.classList.remove('speaking-verse'));
  if (chunk.element) {
    chunk.element.classList.add('speaking-verse');
    chunk.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Clean cancel without firing rogue error cascades
  try {
    audioSpeechSynth.cancel();
  } catch (e) {}

  const speedSelect = document.getElementById('audio-speed-select');
  const rate = speedSelect ? parseFloat(speedSelect.value) || 1.0 : 1.0;

  const { config, voice } = getNarratorVoiceConfig();

  const utterance = new SpeechSynthesisUtterance(chunk.text);
  utterance.rate = rate;
  utterance.lang = config.lang;
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || config.lang;
  }
  utterance.pitch = config.fallbackPitch || 1.0;

  // Store global reference to avoid garbage collection bug in Chromium
  window._speechActiveUtterance = utterance;
  currentUtterance = utterance;

  utterance.onstart = () => {
    isAudioPlaying = true;
    const playIcon = document.getElementById('audio-play-icon');
    if (playIcon) playIcon.textContent = '⏸';
    document.getElementById('audio-wave-anim')?.classList.add('playing');
    startAudioProgressTimer();
    startAudioKeepAlive();
    playSilentBackgroundAudioTrack();
    requestAudioWakeLock();
    updateAudioMediaSession(chunk.text);
  };

  utterance.onend = () => {
    if (!isAudioPlaying) return;
    if (currentAudioVerseIndex < audioVerseQueue.length - 1) {
      playAudioVerseChunk(currentAudioVerseIndex + 1);
    } else {
      stopAudioPlayback();
    }
  };

  utterance.onerror = (evt) => {
    // Ignore deliberate cancels/interruptions when seeking or pausing
    if (evt && (evt.error === 'canceled' || evt.error === 'interrupted')) {
      return;
    }
    console.warn('Speech synthesis chunk error:', evt);
    if (isAudioPlaying && currentAudioVerseIndex < audioVerseQueue.length - 1) {
      playAudioVerseChunk(currentAudioVerseIndex + 1);
    } else {
      stopAudioPlayback();
    }
  };

  try {
    if (audioSpeechSynth.paused) {
      audioSpeechSynth.resume();
    }
    audioSpeechSynth.speak(utterance);
    if (audioSpeechSynth.paused) {
      audioSpeechSynth.resume();
    }
  } catch (err) {
    console.error('Speech synthesis error:', err);
    stopAudioPlayback();
  }
}

function startAudioPlayback() {
  if (audioVerseQueue.length === 0) {
    audioVerseQueue = prepareAudioVerseQueue();
    currentAudioVerseIndex = 0;
  }

  if (audioVerseQueue.length === 0) {
    alert("Please wait for Scripture text to load before starting audio narration.");
    return;
  }

  const speedSelect = document.getElementById('audio-speed-select');
  const rate = speedSelect ? parseFloat(speedSelect.value) || 1.0 : 1.0;
  estimatedAudioDuration = Math.max(30, Math.round((audioVerseQueue.length * 4.5) / rate));

  isAudioPlaying = true;
  const playIcon = document.getElementById('audio-play-icon');
  if (playIcon) playIcon.textContent = '⏸';
  document.getElementById('audio-wave-anim')?.classList.add('playing');

  playSilentBackgroundAudioTrack();
  requestAudioWakeLock();
  playAudioVerseChunk(currentAudioVerseIndex);
}

function stopAudioPlayback() {
  isAudioPlaying = false;
  pauseSilentBackgroundAudioTrack();
  releaseAudioWakeLock();

  if (audioSpeechSynth) {
    try {
      audioSpeechSynth.cancel();
    } catch (e) {}
  }
  window._speechActiveUtterance = null;
  currentUtterance = null;

  const playIcon = document.getElementById('audio-play-icon');
  if (playIcon) playIcon.textContent = '▶';
  document.getElementById('audio-wave-anim')?.classList.remove('playing');
  document.querySelectorAll('.verse-row.speaking-verse, .reader-chapter-heading.speaking-verse').forEach(el => el.classList.remove('speaking-verse'));

  if (audioProgressTimer) {
    clearInterval(audioProgressTimer);
    audioProgressTimer = null;
  }
  if (audioKeepAliveTimer) {
    clearInterval(audioKeepAliveTimer);
    audioKeepAliveTimer = null;
  }
}

function toggleAudioPlayback() {
  if (isAudioPlaying) {
    stopAudioPlayback();
  } else {
    startAudioPlayback();
  }
}

function seekAudioVerse(delta) {
  if (!audioVerseQueue.length) {
    audioVerseQueue = prepareAudioVerseQueue();
  }
  if (!audioVerseQueue.length) return;

  const targetIndex = Math.max(0, Math.min(audioVerseQueue.length - 1, currentAudioVerseIndex + delta * 2));
  currentAudioVerseIndex = targetIndex;
  audioPlaybackSeconds = Math.max(0, Math.min(estimatedAudioDuration, Math.round((targetIndex / audioVerseQueue.length) * estimatedAudioDuration)));

  const timeDisplay = document.getElementById('audio-time-display');
  if (timeDisplay) {
    timeDisplay.textContent = `${formatAudioTime(audioPlaybackSeconds)} / ${formatAudioTime(estimatedAudioDuration)}`;
  }

  if (isAudioPlaying) {
    playAudioVerseChunk(targetIndex);
  }
}

function startAudioKeepAlive() {
  if (audioKeepAliveTimer) clearInterval(audioKeepAliveTimer);
  audioKeepAliveTimer = setInterval(() => {
    if (!isAudioPlaying || !audioSpeechSynth) return;
    if (audioSpeechSynth.speaking && audioSpeechSynth.paused) {
      audioSpeechSynth.resume();
    }
  }, 5000);
}

document.addEventListener('visibilitychange', () => {
  if (isAudioPlaying && audioSpeechSynth) {
    try {
      if (audioSpeechSynth.paused) {
        audioSpeechSynth.resume();
      }
      playSilentBackgroundAudioTrack();
      if (document.visibilityState === 'visible') {
        requestAudioWakeLock();
      }
    } catch (e) {}
  }
});

function updateAudioChapterInfo(chapterTitle) {
  const titleEl = document.getElementById('audio-chapter-title');
  const timeDisplay = document.getElementById('audio-time-display');
  currentAudioChapterName = chapterTitle;
  if (titleEl) titleEl.textContent = chapterTitle || 'Audio Narrator';
  stopAudioPlayback();
  audioVerseQueue = [];
  currentAudioVerseIndex = 0;
  audioPlaybackSeconds = 0;
  if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
}

function formatAudioTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
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

// ====== INIT ======

initTheme();
initLogin();
