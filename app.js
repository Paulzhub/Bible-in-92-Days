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
let activeSelectedWeek = null;
let currentNudges = [];
let nudgedTargetsToday = new Set();
let prayersCache = [];
let activeCommentsDate = null;
let activePrayersDate = null;

// ====== HELPERS ======

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateSecureToken(prefix = 's') {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}_${Date.now()}_${hex}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

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

function getPersistedNudgedTargets(todayStr, username) {
  if (!todayStr || !username) return new Set();
  try {
    const raw = localStorage.getItem(`bible92_nudged_${todayStr}_${username.toLowerCase()}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(t => String(t).toLowerCase()) : []);
  } catch (e) {
    return new Set();
  }
}

function persistNudgedTarget(todayStr, username, target) {
  if (!todayStr || !username || !target) return;
  try {
    const set = getPersistedNudgedTargets(todayStr, username);
    set.add(target.toLowerCase());
    localStorage.setItem(`bible92_nudged_${todayStr}_${username.toLowerCase()}`, JSON.stringify([...set]));
  } catch (e) {}
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
  const isLight = theme === 'light';
  
  // Header theme toggle icons
  const headerMoon = document.getElementById('theme-icon-moon');
  const headerSun = document.getElementById('theme-icon-sun');
  if (headerMoon) headerMoon.hidden = isLight;
  if (headerSun) headerSun.hidden = !isLight;

  // Login screen theme toggle icons
  const loginMoon = document.getElementById('login-theme-icon-moon');
  const loginSun = document.getElementById('login-theme-icon-sun');
  if (loginMoon) loginMoon.hidden = isLight;
  if (loginSun) loginSun.hidden = !isLight;

  // Plan overview return bar theme toggle icons (for logged-in users)
  const overviewMoon = document.getElementById('overview-theme-icon-moon');
  const overviewSun = document.getElementById('overview-theme-icon-sun');
  if (overviewMoon) overviewMoon.hidden = isLight;
  if (overviewSun) overviewSun.hidden = !isLight;

  localStorage.setItem('bible92_theme', theme);

  // Notify Ambient Three.js celestial background to morph colors and fog
  if (window.ambientCelestialBg && typeof window.ambientCelestialBg.setTheme === 'function') {
    window.ambientCelestialBg.setTheme(theme);
  }
}

function initTheme() {
  const saved = localStorage.getItem('bible92_theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));

  const toggleTheme = (e) => {
    e.preventDefault();
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  };

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }

  const loginToggleBtn = document.getElementById('login-theme-toggle');
  if (loginToggleBtn) {
    loginToggleBtn.addEventListener('click', toggleTheme);
  }

  const overviewToggleBtn = document.getElementById('overview-theme-toggle');
  if (overviewToggleBtn) {
    overviewToggleBtn.addEventListener('click', toggleTheme);
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

// Register Service Worker for PWA Offline Caching
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}

// PWA Installation Manager
let deferredInstallPrompt = window.deferredInstallPrompt || null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredInstallPrompt = e;
  deferredInstallPrompt = e;
});

function isPwaStandalone() {
  return Boolean(
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) ||
    (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) ||
    window.navigator.standalone ||
    (document.referrer && document.referrer.startsWith('android-app://'))
  );
}

function renderInstallGuideContent() {
  const container = document.getElementById('install-guide-steps');
  if (!container) return;

  const ua = (window.navigator.userAgent || '').toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const isInApp = /(instagram|fbav|fban|messenger|whatsapp|musical_ly|bytedance|tiktok)/i.test(ua);

  let platformBadge = '';
  let stepsHtml = '';

  if (isInApp) {
    platformBadge = '<div class="install-guide-platform-pill" style="border-color:#f85149;color:#ff7b72;background:rgba(248,81,73,0.12);"><span>⚠️</span><span>In-App Browser Detected</span></div>';
    stepsHtml = 
      '<div class="install-guide-step" style="border-color:rgba(248,81,73,0.4);background:rgba(248,81,73,0.06);">' +
        '<span class="install-step-num" style="background:#f85149;color:#fff;">!</span>' +
        '<div class="install-step-content">You are viewing inside an in-app browser (such as Instagram or WhatsApp), which prevents direct app installation.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">1</span>' +
        '<div class="install-step-content">Tap the <strong>three dots (⋮ or ⋯)</strong> or <strong>Share</strong> button in the corner of your screen.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">2</span>' +
        '<div class="install-step-content">Select <strong>Open in Chrome</strong> (on Android) or <strong>Open in Safari</strong> (on iPhone).</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">3</span>' +
        '<div class="install-step-content">Once open in your browser, tap <strong>Install App</strong> and the native app install dialog will appear immediately!</div>' +
      '</div>';
  } else if (isIos) {
    platformBadge = '<div class="install-guide-platform-pill"><span>🍎</span><span>Apple iOS (Safari)</span></div>';
    stepsHtml = 
      '<div class="install-guide-step">' +
        '<span class="install-step-num">1</span>' +
        '<div class="install-step-content">In <strong>Safari</strong>, tap the <strong>Share</strong> button (the square with an upward arrow ⎙) in the bottom toolbar.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">2</span>' +
        '<div class="install-step-content">Scroll down the sharing sheet and tap <strong>Add to Home Screen</strong> (📲).</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">3</span>' +
        '<div class="install-step-content">Tap <strong>Add</strong> in the top-right corner. Project Bible in 92 Days is now installed on your device!</div>' +
      '</div>';
  } else if (isAndroid) {
    platformBadge = '<div class="install-guide-platform-pill"><span>🤖</span><span>Android (Chrome / Browser)</span></div>';
    stepsHtml = 
      '<div class="install-guide-step">' +
        '<span class="install-step-num">1</span>' +
        '<div class="install-step-content">Tap the <strong>three dots menu</strong> (⋮) in the corner of your browser.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">2</span>' +
        '<div class="install-step-content">Select <strong>Install app</strong> or <strong>Add to Home screen</strong>.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">3</span>' +
        '<div class="install-step-content">Tap <strong>Install</strong> to confirm. The app icon will appear on your home screen!</div>' +
      '</div>';
  } else {
    platformBadge = '<div class="install-guide-platform-pill"><span>💻</span><span>Desktop (Chrome / Edge / Brave)</span></div>';
    stepsHtml = 
      '<div class="install-guide-step">' +
        '<span class="install-step-num">1</span>' +
        '<div class="install-step-content">Click the <strong>Install App icon</strong> (⊕ or monitor) on the right side of your browser address bar.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">2</span>' +
        '<div class="install-step-content">Or click the browser menu (⋮) and select <strong>Install Project Bible in 92 Days</strong>.</div>' +
      '</div>' +
      '<div class="install-guide-step">' +
        '<span class="install-step-num">3</span>' +
        '<div class="install-step-content">Click <strong>Install</strong> to launch the app in its own dedicated window!</div>' +
      '</div>';
  }

  container.innerHTML = platformBadge + stepsHtml;
}

function openInstallGuideModal() {
  renderInstallGuideContent();
  const modal = document.getElementById('install-guide-modal');
  if (modal) {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }
}

function closeInstallGuideModal() {
  const modal = document.getElementById('install-guide-modal');
  if (modal) {
    modal.hidden = true;
    document.body.style.overflow = '';
  }
}

function setupPwaInstallPrompt() {
  const headerInstallBtn = document.getElementById('header-install-app-btn');
  const legacyHeaderInstallBtn = document.getElementById('pwa-install-btn');
  const loginInstallWrap = document.getElementById('login-pwa-install-wrap');
  const loginInstallBtn = document.getElementById('login-pwa-install-btn');

  const updateVisibility = () => {
    const standalone = isPwaStandalone();
    if (standalone) {
      if (headerInstallBtn) headerInstallBtn.hidden = true;
      if (legacyHeaderInstallBtn) legacyHeaderInstallBtn.hidden = true;
      if (loginInstallWrap) loginInstallWrap.hidden = true;
    } else {
      if (headerInstallBtn) headerInstallBtn.hidden = false;
      if (legacyHeaderInstallBtn) legacyHeaderInstallBtn.hidden = false;
      if (loginInstallWrap) loginInstallWrap.hidden = false;
    }
  };

  const triggerInstallFlow = async () => {
    let promptEvent = window.deferredInstallPrompt || deferredInstallPrompt;

    const ua = (window.navigator.userAgent || '').toLowerCase();
    const isAndroid = /android/.test(ua);

    // If on Android and prompt hasn't arrived yet, wait briefly for pending beforeinstallprompt
    if (!promptEvent && isAndroid) {
      const pendingPrompt = await new Promise((resolve) => {
        let timer = null;
        const handler = (e) => {
          e.preventDefault();
          window.deferredInstallPrompt = e;
          deferredInstallPrompt = e;
          if (timer) clearTimeout(timer);
          resolve(e);
        };
        window.addEventListener('beforeinstallprompt', handler, { once: true });
        window.addEventListener('pwa-prompt-ready', () => {
          if (window.deferredInstallPrompt) {
            if (timer) clearTimeout(timer);
            resolve(window.deferredInstallPrompt);
          }
        }, { once: true });
        timer = setTimeout(() => resolve(null), 800);
      });

      if (pendingPrompt) {
        promptEvent = pendingPrompt;
      }
    }

    if (promptEvent) {
      try {
        promptEvent.prompt();
        const choiceResult = await promptEvent.userChoice;
        if (choiceResult && choiceResult.outcome === 'accepted') {
          if (headerInstallBtn) headerInstallBtn.hidden = true;
          if (legacyHeaderInstallBtn) legacyHeaderInstallBtn.hidden = true;
          if (loginInstallWrap) loginInstallWrap.hidden = true;
          if (typeof showNudgeToast === 'function') {
            showNudgeToast('🎉 Bible in 92 Days installed successfully!');
          }
        }
      } catch (err) {
        console.warn('Install prompt failed:', err);
      }
      window.deferredInstallPrompt = null;
      deferredInstallPrompt = null;
    } else {
      openInstallGuideModal();
    }
  };

  if (headerInstallBtn) {
    headerInstallBtn.addEventListener('click', triggerInstallFlow);
  }
  if (legacyHeaderInstallBtn) {
    legacyHeaderInstallBtn.addEventListener('click', triggerInstallFlow);
  }
  if (loginInstallBtn) {
    loginInstallBtn.addEventListener('click', triggerInstallFlow);
  }

  // Modal close handlers
  const closeBtn = document.getElementById('close-install-guide-modal');
  const gotItBtn = document.getElementById('btn-close-install-guide');
  const modal = document.getElementById('install-guide-modal');

  if (closeBtn) closeBtn.addEventListener('click', closeInstallGuideModal);
  if (gotItBtn) gotItBtn.addEventListener('click', closeInstallGuideModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeInstallGuideModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      closeInstallGuideModal();
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateVisibility();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (headerInstallBtn) headerInstallBtn.hidden = true;
    if (legacyHeaderInstallBtn) legacyHeaderInstallBtn.hidden = true;
    if (loginInstallWrap) loginInstallWrap.hidden = true;
    closeInstallGuideModal();
    console.log('Bible in 92 Days PWA installed successfully!');
    if (typeof showNudgeToast === 'function') {
      showNudgeToast('🎉 Bible in 92 Days installed successfully!');
    }
  });

  // Listen to standalone media query changes in real time
  try {
    const mql = window.matchMedia('(display-mode: standalone)');
    if (mql && mql.addEventListener) {
      mql.addEventListener('change', updateVisibility);
    }
  } catch (err) {
    // Ignore legacy browsers
  }

  // Initial visibility check
  updateVisibility();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupPwaInstallPrompt);
} else {
  setupPwaInstallPrompt();
}

function getChallengeDayForDate(date) {
  const start = new Date(2026, 7, 10); // August 10, 2026
  const cur = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((cur - start) / (1000 * 60 * 60 * 24)) + 1;
  if (diffDays < 1) return 1;
  if (diffDays > 92) return 92;
  return diffDays;
}

function ensureSessionAndOpenReader(dayNum, portionStr) {
  let session = getSession();
  if (!session) {
    const clientSessionId = generateSecureToken('g');
    session = {
      username: 'Guest1',
      password: 'Guest1@123',
      isGuest: true,
      isAdmin: false,
      sessionId: clientSessionId,
      lastActivity: Date.now(),
      loginTime: Date.now()
    };
    setSession(session);
    showSite(session);
  } else {
    // Ensure dashboard is visible and public overview is hidden
    const publicOverview = document.getElementById('public-overview');
    if (publicOverview) publicOverview.hidden = true;
    const siteEl = document.getElementById('site');
    if (siteEl) siteEl.hidden = false;
  }

  if (!portionStr) {
    const cardEl = document.getElementById(`day-${dayNum}`);
    if (cardEl) {
      const pEl = cardEl.querySelector('.public-day-portion');
      if (pEl) portionStr = pEl.textContent.trim();
    }
  }

  setTimeout(() => {
    openReaderModal({ portion: portionStr || `Day ${dayNum}`, day: dayNum });
  }, 200);
}

function initPublicTodayPreview() {
  const dayNum = getChallengeDayForDate(new Date());
  const dayCard = document.getElementById(`day-${dayNum}`);

  const dayNumEl = document.getElementById('public-today-day-num');
  const dateBadgeEl = document.getElementById('public-today-date-badge');
  const portionEl = document.getElementById('public-today-portion-text');
  const readBtn = document.getElementById('public-read-today-btn');

  let portionText = 'Genesis 1-13';
  let dateText = '10/08/26';

  if (dayCard) {
    const cardPortion = dayCard.querySelector('.public-day-portion');
    const cardDate = dayCard.querySelector('.public-day-date');
    if (cardPortion) portionText = cardPortion.textContent.trim();
    if (cardDate) dateText = cardDate.textContent.trim();
  }

  if (dayNumEl) dayNumEl.textContent = `Day ${dayNum}`;
  if (dateBadgeEl) {
    const now = new Date();
    dateBadgeEl.textContent = `${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (Day ${dayNum} of 92)`;
  }
  if (portionEl) portionEl.textContent = portionText;

  if (readBtn) {
    readBtn.addEventListener('click', () => {
      openReaderModal({ portion: portionText || `Day ${dayNum}`, day: dayNum });
    });
  }
}

function initPublicScheduleFeatures() {
  const searchInput = document.getElementById('public-schedule-search');
  const searchClear = document.getElementById('public-search-clear');
  const phaseChips = document.querySelectorAll('#public-phase-chips .phase-chip');
  const countEl = document.getElementById('public-schedule-count');
  const cards = document.querySelectorAll('.public-day-card');
  const backToSignInBtn = document.getElementById('public-back-to-signin-btn');

  let activePhase = 'all';

  function filterCards() {
    const rawQuery = (searchInput ? searchInput.value : '').trim();
    if (searchClear) searchClear.hidden = !rawQuery;

    let visibleCount = 0;
    cards.forEach((card) => {
      const day = Number(card.getAttribute('data-day'));
      const phase = card.getAttribute('data-phase') || '';
      const portionEl = card.querySelector('.public-day-portion');
      const dateEl = card.querySelector('.public-day-date');
      const portion = portionEl ? portionEl.textContent.trim() : '';
      const date = dateEl ? dateEl.textContent.trim() : '';

      const matchesPhase = activePhase === 'all' || phase === activePhase;

      let matchesQuery = true;
      if (rawQuery) {
        const indexItem = buildScheduleItemSearchIndex({ day, portion, date });
        matchesQuery = matchesScheduleQuery(indexItem, rawQuery);
      }

      if (matchesPhase && matchesQuery) {
        card.style.display = '';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });

    if (countEl) {
      countEl.textContent = `Showing ${visibleCount} of ${cards.length} days`;
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', filterCards);
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      filterCards();
      searchInput.focus();
    });
  }

  phaseChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      phaseChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activePhase = chip.getAttribute('data-phase') || 'all';
      filterCards();
    });
  });

  document.querySelectorAll('.btn-public-read').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const day = Number(btn.getAttribute('data-day'));
      const portion = btn.getAttribute('data-portion');
      openReaderModal({ portion: portion || `Day ${day}`, day });
    });
  });

  if (backToSignInBtn) {
    backToSignInBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (lenisInstance) {
        lenisInstance.scrollTo(0, { duration: 0.8 });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
}

function checkUrlDeepLinks(session) {
  try {
    const params = new URLSearchParams(window.location.search);
    const dayParam = params.get('day') || params.get('read');
    const qParam = params.get('q');

    if (dayParam) {
      const dNum = parseInt(dayParam, 10);
      if (!isNaN(dNum) && dNum >= 1 && dNum <= 92) {
        ensureSessionAndOpenReader(dNum);
        return;
      }
    }

    if (window.location.hash) {
      const hashMatch = window.location.hash.match(/^#day-(\d+)$/i);
      if (hashMatch) {
        const dNum = parseInt(hashMatch[1], 10);
        if (!isNaN(dNum) && dNum >= 1 && dNum <= 92) {
          const card = document.getElementById(`day-${dNum}`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.borderColor = 'var(--accent)';
            card.style.boxShadow = '0 0 16px rgba(212, 175, 55, 0.4)';
          }
        }
      }
    }

    if (qParam) {
      const searchInput = document.getElementById('public-schedule-search');
      if (searchInput) {
        searchInput.value = qParam;
        searchInput.dispatchEvent(new Event('input'));
        const scheduleSection = document.getElementById('full-schedule-section');
        if (scheduleSection) {
          scheduleSection.scrollIntoView({ behavior: 'smooth' });
        }
      }
    }
  } catch (e) {
    console.warn('Deep link handling error:', e);
  }
}

function initLogin() {
  initBrowserLifecycleHandlers();
  initPasswordToggle();
  initPublicTodayPreview();
  initPublicScheduleFeatures();
  initScriptureReader();
  const session = getSession();
  if (session) {
    showSite(session);
    checkUrlDeepLinks(session);
    return;
  }
  checkUrlDeepLinks(null);

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
    const isGuest = uLow.includes('guest') || uLow.startsWith('guest') || uLow === 'rinrin' || uLow === 'rin-chan';
    const isAdmin = uLow === 'admin';
    const clientSessionId = generateSecureToken(isAdmin ? 'a' : (isGuest ? 'g' : 'u'));
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

  const guestQuickBtn = document.getElementById('guest-quick-login-btn');
  if (guestQuickBtn) {
    guestQuickBtn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('login-username').value = 'Guest1';
      document.getElementById('login-password').value = 'Guest1@123';
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    });
  }
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

  ['mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
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

function initHeaderPlanOverview(session) {
  const planOverviewBtn = document.getElementById('header-plan-overview-btn');
  const returnBar = document.getElementById('overview-return-bar');
  const returnBtn = document.getElementById('overview-return-btn');
  const returnUser = document.getElementById('overview-return-username');
  const publicOverview = document.getElementById('public-overview');
  const siteEl = document.getElementById('site');
  const loginScreen = document.getElementById('login-screen');

  if (!planOverviewBtn || !publicOverview || !siteEl) return;

  // Clicking "Plan Overview" in header
  planOverviewBtn.addEventListener('click', (e) => {
    e.preventDefault();
    // Hide dashboard
    siteEl.hidden = true;
    // Strictly keep login screen and form hidden
    if (loginScreen) loginScreen.hidden = true;
    // Show public plan overview
    publicOverview.hidden = false;
    if (returnBar) {
      returnBar.hidden = false;
      if (returnUser && session) {
        returnUser.textContent = `Logged in as ${session.username}${session.isGuest ? ' (Guest)' : ''}`;
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.refreshScrollScrubber) setTimeout(window.refreshScrollScrubber, 120);
  });

  // Clicking "Return to Dashboard" bar inside public overview
  if (returnBtn) {
    returnBtn.addEventListener('click', (e) => {
      e.preventDefault();
      publicOverview.hidden = true;
      if (returnBar) returnBar.hidden = true;
      siteEl.hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (window.refreshScrollScrubber) setTimeout(window.refreshScrollScrubber, 120);
    });
  }
}

function showSite(session) {
  document.getElementById('login-screen').hidden = true;
  const publicOverview = document.getElementById('public-overview');
  if (publicOverview) publicOverview.hidden = true;
  const returnBar = document.getElementById('overview-return-bar');
  if (returnBar) returnBar.hidden = true;

  const siteEl = document.getElementById('site');
  siteEl.hidden = false;
  siteEl.classList.add('fade-in', 'site-ease-in');
  if (window.refreshScrollScrubber) setTimeout(window.refreshScrollScrubber, 120);
  if (typeof initKineticCardTilt === 'function') setTimeout(initKineticCardTilt, 80);
  if (typeof ScrollTrigger !== 'undefined') setTimeout(() => { ScrollTrigger.refresh(); }, 150);
  
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
  initHeaderPlanOverview(session);
  initMobileMenu();
  initDateDropdown();
  initShareModal();
  initBoysVsGirlsShareModal();
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
  wireBoysVsGirlsShareButton(session);
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

// ====== SQUAD FLAME GAUGE & MULTI-TIER CELEBRATION FX ======

const SQUAD_CELEBRATION_TIERS = [
  { count: 13, name: 'SQUAD HEATWAVE (13/13)', big: true, emojis: ['🔥', '👑', '🏆', '✨', '⚡'], colors: ['#FFD700', '#FFA500', '#FF4500', '#FFF8DC'], haptic: [50, 80, 50, 80, 100] },
  { count: 10, name: 'Double Digits (10+)', big: true, emojis: ['🔥', '⚡', '✨', '🙌'], colors: ['#E8A93B', '#6FAE8C', '#5B8DEF', '#FFD700'], haptic: [40, 60, 40] },
  { count: 5,  name: 'Squad On Fire (5+)', big: false, emojis: ['🔥', '✨', '⚡'], colors: ['#E8A93B', '#E4685D', '#6FAE8C'], haptic: [30, 50, 30] },
  { count: 3,  name: 'Momentum (3+)', big: false, emojis: ['✨', '⚡', '📖'], colors: ['#5B8DEF', '#6FAE8C', '#E8A93B'], haptic: [30, 30] },
  { count: 2,  name: 'Spark (2+)', big: false, emojis: ['✨', '🌱'], colors: ['#6FAE8C', '#5B8DEF'], haptic: [25] }
];

function checkSquadMilestoneCelebration(readCount) {
  const todayStr = formatDDMMYY(new Date());
  SQUAD_CELEBRATION_TIERS.forEach(tier => {
    if (readCount >= tier.count) {
      const key = `bible92_squad_tier_${tier.count}_${todayStr}`;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1');
        celebrateTier(tier);
      }
    }
  });
}

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

  // Trigger celebration tiers for 2, 3, 5, 10, 13 members reading on the same day
  if (readCount >= 2) {
    checkSquadMilestoneCelebration(readCount);
  }
}

const BOY_USERS = ['paulz', 'victor', 'jason', 'guptaji', 'puia', 'ducks fartbomber', 'vishan'];
const GIRL_USERS = ['nim nim', 'daysel', 'yutso', 'elisha', 'dechen', 'yeshi'];
const BOYS_TOTAL_TARGET_DAYS = 644; // 7 boys * 92 days
const GIRLS_TOTAL_TARGET_DAYS = 552; // 6 girls * 92 days
const BOYS_ROSTER_DEFS = ['Paulz', 'Victor', 'Jason', 'Guptaji', 'Puia', 'Ducks Fartbomber', 'Vishan'];
const GIRLS_ROSTER_DEFS = ['Nim Nim', 'Daysel', 'Yutso', 'Elisha', 'Dechen', 'Yeshi'];

let lastBvgData = null;
let lastBvgCardBlob = null;

function hasReadOnCurrentDay(row) {
  if (!row) return false;
  if (row.readToday) return true;
  if (row.todayTimestamp) return true;
  if (row.lastReadTimestamp > 0) {
    const d = new Date(row.lastReadTimestamp);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }
  return false;
}

function spawnBvgParticleBurst(container, xPct, yPct, themeColor) {
  if (!container) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const emitter = document.createElement('div');
  emitter.className = 'bvg-particle-emitter';

  const colorPalettes = {
    boys: ['#38bdf8', '#7dd3fc', '#bae6fd', '#ffffff', '#0284c7'],
    girls: ['#f472b6', '#fb7185', '#fda4af', '#ffffff', '#e11d48'],
    tie: ['#e8a93b', '#fbbf24', '#fde68a', '#ffffff', '#f59e0b'],
    mixed: ['#38bdf8', '#f472b6', '#e8a93b', '#ffffff', '#bae6fd', '#fbcfe8']
  };

  const palette = colorPalettes[themeColor] || colorPalettes.mixed;
  const particleCount = 14;

  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('span');
    const isStar = Math.random() > 0.6;
    p.className = 'bvg-micro-particle' + (isStar ? ' shape-star' : '');

    const size = isStar ? Math.floor(Math.random() * 4 + 6) : Math.floor(Math.random() * 3 + 4);
    const color = palette[Math.floor(Math.random() * palette.length)];

    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.4;
    const distance = Math.floor(Math.random() * 30 + 14);
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance - Math.random() * 10;
    const rot = Math.floor((Math.random() - 0.5) * 360);

    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.left = `calc(${xPct}% - ${size / 2}px)`;
    p.style.top = `calc(${yPct}% - ${size / 2}px)`;
    p.style.backgroundColor = color;
    p.style.boxShadow = `0 0 ${size}px ${color}`;
    p.style.setProperty('--p-tx', `${tx}px`);
    p.style.setProperty('--p-ty', `${ty}px`);
    p.style.setProperty('--p-rot', `${rot}deg`);

    emitter.appendChild(p);
  }

  container.appendChild(emitter);
  setTimeout(() => {
    if (emitter.parentNode) emitter.remove();
  }, 800);
}

function triggerBvgShockwave({ force = false, isScroll = false } = {}) {
  const card = document.getElementById('boys-vs-girls-card');
  if (!card) return;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const now = Date.now();
  if (!force && now - (window._lastBvgShockwaveTime || 0) < 3000) return;
  window._lastBvgShockwaveTime = now;

  const leadIndicator = document.getElementById('bvg-lead-indicator');
  const barBoys = document.getElementById('bvg-bar-boys');
  const barGirls = document.getElementById('bvg-bar-girls');
  const boysSingleBar = document.getElementById('bvg-boys-single-bar');
  const girlsSingleBar = document.getElementById('bvg-girls-single-bar');
  const seamGlow = document.getElementById('bvg-tug-seam-glow');
  const segBarWrap = document.querySelector('.bvg-segmented-bar-wrap');
  const boysCard = document.querySelector('.bvg-boys-card');
  const girlsCard = document.querySelector('.bvg-girls-card');

  // 1. Energetic pulse on lead indicator
  if (leadIndicator) {
    leadIndicator.classList.remove('lead-pulse-shockwave');
    void leadIndicator.offsetWidth; // force reflow
    leadIndicator.classList.add('lead-pulse-shockwave');
    setTimeout(() => leadIndicator.classList.remove('lead-pulse-shockwave'), 1200);
  }

  // 2. Seam glow shockwave
  if (seamGlow) {
    seamGlow.classList.remove('active');
    void seamGlow.offsetWidth;
    seamGlow.classList.add('active');
    setTimeout(() => seamGlow.classList.remove('active'), 1200);
  }

  // 3. Elastic spring overshoot on first scroll-into-view
  const bvgData = window._currentBvgData || { boysPct: 0, girlsPct: 0, segBoysWidth: 50, segGirlsWidth: 50, leader: 'tie' };
  if (isScroll && !window._bvgHasScrolledIntoView) {
    window._bvgHasScrolledIntoView = true;
    if (barBoys && barGirls && boysSingleBar && girlsSingleBar) {
      barBoys.style.transition = 'none';
      barGirls.style.transition = 'none';
      boysSingleBar.style.transition = 'none';
      girlsSingleBar.style.transition = 'none';

      barBoys.style.width = '50%';
      barGirls.style.width = '50%';
      boysSingleBar.style.width = '0%';
      girlsSingleBar.style.width = '0%';

      void barBoys.offsetWidth; // force reflow

      barBoys.style.transition = '';
      barGirls.style.transition = '';
      boysSingleBar.style.transition = '';
      girlsSingleBar.style.transition = '';

      requestAnimationFrame(() => {
        barBoys.style.width = `${bvgData.segBoysWidth.toFixed(1)}%`;
        barGirls.style.width = `${bvgData.segGirlsWidth.toFixed(1)}%`;
        boysSingleBar.style.width = `${bvgData.boysPct.toFixed(1)}%`;
        girlsSingleBar.style.width = `${bvgData.girlsPct.toFixed(1)}%`;
      });
    }
  }

  // 4. Micro Particle Bursts at the Leading Edge
  setTimeout(() => {
    // A. At the Tug-of-War seam
    if (segBarWrap) {
      spawnBvgParticleBurst(segBarWrap, bvgData.segBoysWidth, 50, 'mixed');
    }

    // B. At the leading edge of the single progress bar
    if (bvgData.leader === 'boys' && boysCard) {
      spawnBvgParticleBurst(boysCard, Math.min(95, Math.max(10, bvgData.boysPct)), 50, 'boys');
    } else if (bvgData.leader === 'girls' && girlsCard) {
      spawnBvgParticleBurst(girlsCard, Math.min(95, Math.max(10, bvgData.girlsPct)), 50, 'girls');
    } else if (boysCard && girlsCard) {
      spawnBvgParticleBurst(boysCard, Math.min(95, Math.max(10, bvgData.boysPct)), 50, 'tie');
      spawnBvgParticleBurst(girlsCard, Math.min(95, Math.max(10, bvgData.girlsPct)), 50, 'tie');
    }
  }, 220);
}

function initBoysVsGirlsRivalryObserver() {
  const card = document.getElementById('boys-vs-girls-card');
  if (!card) return;

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          triggerBvgShockwave({ isScroll: true });
        }
      });
    }, { threshold: 0.25 });
    observer.observe(card);
  }
}

function renderBoysVsGirlsProgress(rows) {
  const card = document.getElementById('boys-vs-girls-card');
  if (!card) return;
  if (!rows || !Array.isArray(rows)) return;

  let boysDays = 0;
  let girlsDays = 0;

  rows.forEach(r => {
    const normUser = (r.username || '').trim().toLowerCase();
    const days = Number(r.daysCompleted) || 0;
    if (BOY_USERS.includes(normUser)) {
      boysDays += days;
    } else if (GIRL_USERS.includes(normUser)) {
      girlsDays += days;
    }
  });

  const boysPct = Math.min(100, Math.max(0, (boysDays / BOYS_TOTAL_TARGET_DAYS) * 100));
  const girlsPct = Math.min(100, Math.max(0, (girlsDays / GIRLS_TOTAL_TARGET_DAYS) * 100));

  const boysPctEl = document.getElementById('bvg-boys-pct');
  const girlsPctEl = document.getElementById('bvg-girls-pct');
  if (boysPctEl) boysPctEl.textContent = `${boysPct.toFixed(1)}%`;
  if (girlsPctEl) girlsPctEl.textContent = `${girlsPct.toFixed(1)}%`;

  const boysFracEl = document.getElementById('bvg-boys-fraction');
  const girlsFracEl = document.getElementById('bvg-girls-fraction');
  if (boysFracEl) boysFracEl.textContent = `${boysDays} / ${BOYS_TOTAL_TARGET_DAYS} days`;
  if (girlsFracEl) girlsFracEl.textContent = `${girlsDays} / ${GIRLS_TOTAL_TARGET_DAYS} days`;

  const boysSingleBar = document.getElementById('bvg-boys-single-bar');
  const girlsSingleBar = document.getElementById('bvg-girls-single-bar');
  if (boysSingleBar) boysSingleBar.style.width = `${boysPct}%`;
  if (girlsSingleBar) girlsSingleBar.style.width = `${girlsPct}%`;

  let segBoysWidth = 50;
  let segGirlsWidth = 50;
  const barBoys = document.getElementById('bvg-bar-boys');
  const barGirls = document.getElementById('bvg-bar-girls');
  if (barBoys && barGirls) {
    const totalCurrentPct = boysPct + girlsPct;
    if (totalCurrentPct > 0) {
      segBoysWidth = (boysPct / totalCurrentPct) * 100;
      segGirlsWidth = (girlsPct / totalCurrentPct) * 100;
      barBoys.style.width = `${segBoysWidth.toFixed(1)}%`;
      barGirls.style.width = `${segGirlsWidth.toFixed(1)}%`;
    } else {
      barBoys.style.width = '50%';
      barGirls.style.width = '50%';
    }
  }

  const seamGlow = document.getElementById('bvg-tug-seam-glow');
  if (seamGlow) {
    seamGlow.style.left = `${segBoysWidth.toFixed(1)}%`;
  }

  let leader = 'tie';
  const leadIndicator = document.getElementById('bvg-lead-indicator');
  const leadIcon = document.getElementById('bvg-lead-icon');
  const leadText = document.getElementById('bvg-lead-text');

  if (leadIndicator && leadText) {
    leadIndicator.classList.remove('lead-boys', 'lead-girls', 'lead-tie');
    if (boysPct > girlsPct) {
      leadIndicator.classList.add('lead-boys');
      if (leadIcon) leadIcon.textContent = '🏃‍♂️';
      leadText.textContent = 'Boys are in the Lead!';
      leader = 'boys';
    } else if (girlsPct > boysPct) {
      leadIndicator.classList.add('lead-girls');
      if (leadIcon) leadIcon.textContent = '🏃‍♀️';
      leadText.textContent = 'Girls are in the Lead!';
      leader = 'girls';
    } else {
      leadIndicator.classList.add('lead-tie');
      if (leadIcon) leadIcon.textContent = '🤝';
      leadText.textContent = "It's a Tie!";
      leader = 'tie';
    }
  }

  const prevData = window._currentBvgData;
  window._currentBvgData = { boysPct, girlsPct, segBoysWidth, segGirlsWidth, leader };

  if (prevData && (prevData.boysPct !== boysPct || prevData.girlsPct !== girlsPct || prevData.leader !== leader)) {
    triggerBvgShockwave({ force: true });
  }

  // Update roster pills with active reader badges in respective themes
  const boysRosterEl = document.getElementById('bvg-boys-roster');
  if (boysRosterEl) {
    boysRosterEl.innerHTML = '';
    BOYS_ROSTER_DEFS.forEach(name => {
      const uRow = rows.find(r => (r.username || '').trim().toLowerCase() === name.toLowerCase());
      const isRead = hasReadOnCurrentDay(uRow);
      const span = document.createElement('span');
      span.className = 'bvg-pill' + (isRead ? ' pill-active-boys' : '');
      span.textContent = isRead ? `${name} ✓` : name;
      if (isRead) span.title = `${name} read today! 🔥`;
      boysRosterEl.appendChild(span);
    });
  }

  const girlsRosterEl = document.getElementById('bvg-girls-roster');
  if (girlsRosterEl) {
    girlsRosterEl.innerHTML = '';
    GIRLS_ROSTER_DEFS.forEach(name => {
      const uRow = rows.find(r => (r.username || '').trim().toLowerCase() === name.toLowerCase());
      const isRead = hasReadOnCurrentDay(uRow);
      const span = document.createElement('span');
      span.className = 'bvg-pill' + (isRead ? ' pill-active-girls' : '');
      span.textContent = isRead ? `${name} ✓` : name;
      if (isRead) span.title = `${name} read today! 🔥`;
      girlsRosterEl.appendChild(span);
    });
  }

  lastBvgData = {
    boysDays,
    boysTotal: BOYS_TOTAL_TARGET_DAYS,
    boysPct,
    girlsDays,
    girlsTotal: GIRLS_TOTAL_TARGET_DAYS,
    girlsPct,
    leadText: leadText ? leadText.textContent : "It's a Tie!",
    leadIcon: leadIcon ? leadIcon.textContent : "🤝",
    rows
  };
}

function generateBoysVsGirlsShareCanvas(bvgData) {
  const data = bvgData || lastBvgData || {
    boysDays: 0,
    boysTotal: 644,
    boysPct: 0,
    girlsDays: 0,
    girlsTotal: 552,
    girlsPct: 0,
    leadText: "It's a Tie!",
    leadIcon: "🤝",
    rows: []
  };

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext('2d');

  // Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 1200, 675);
  bgGrad.addColorStop(0, '#090c15');
  bgGrad.addColorStop(0.5, '#0f1422');
  bgGrad.addColorStop(1, '#171a2b');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1200, 675);

  // Ambient Glow Orbs
  const orbBoys = ctx.createRadialGradient(250, 300, 10, 250, 300, 350);
  orbBoys.addColorStop(0, 'rgba(56, 189, 248, 0.18)');
  orbBoys.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = orbBoys;
  ctx.fillRect(0, 0, 600, 675);

  const orbGirls = ctx.createRadialGradient(950, 300, 10, 950, 300, 350);
  orbGirls.addColorStop(0, 'rgba(244, 114, 182, 0.18)');
  orbGirls.addColorStop(1, 'rgba(244, 114, 182, 0)');
  ctx.fillStyle = orbGirls;
  ctx.fillRect(600, 0, 600, 675);

  // Outer Border Frame
  ctx.strokeStyle = 'rgba(232, 169, 59, 0.35)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 24, 24, 1152, 627, 20, false, true);

  // Corner Accents
  ctx.strokeStyle = '#e8a93b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(40, 60); ctx.lineTo(40, 40); ctx.lineTo(60, 40);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(1140, 60); ctx.lineTo(1140, 40); ctx.lineTo(1160, 40);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(40, 615); ctx.lineTo(40, 635); ctx.lineTo(60, 635);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(1140, 615); ctx.lineTo(1140, 635); ctx.lineTo(1160, 635);
  ctx.stroke();

  // Header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8a93b';
  ctx.font = '600 14px "Space Grotesk", sans-serif';
  ctx.fillText('THE YOUTH GATHERING 2026 • BIBLE IN 92 DAYS', 600, 62);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 36px "Fraunces", Georgia, serif';
  ctx.fillText('BOYS VS GIRLS SHOWDOWN', 600, 105);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 14px "Space Grotesk", sans-serif';
  ctx.fillText('Cumulative Reading Progress • 66 Books • 1,189 Chapters', 600, 132);

  // Lead Banner Pill
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.strokeStyle = 'rgba(232, 169, 59, 0.6)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 420, 150, 360, 40, 20, true, true);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 16px "Space Grotesk", sans-serif';
  ctx.fillText(`${data.leadIcon} ${data.leadText}`, 600, 175);

  // Left Card: Boys Squad
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 2;
  roundRect(ctx, 60, 210, 515, 305, 18, true, true);

  ctx.fillStyle = '#38bdf8';
  roundRect(ctx, 60, 228, 6, 268, 3, true, false);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 22px "Space Grotesk", sans-serif';
  ctx.fillText('🏃‍♂️ BOYS SQUAD', 85, 248);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 13px "Space Grotesk", sans-serif';
  ctx.fillText('7 Disciples • Cumulative Target: 644 Days', 85, 270);

  ctx.fillStyle = '#38bdf8';
  ctx.font = '800 54px "Fraunces", Georgia, serif';
  ctx.fillText(`${data.boysPct.toFixed(1)}%`, 85, 335);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = '600 17px "Space Grotesk", sans-serif';
  ctx.fillText(`${data.boysDays} / 644 target days read`, 85, 368);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  roundRect(ctx, 85, 385, 460, 12, 6, true, false);
  const boysBarW = Math.max(12, Math.min(460, (data.boysPct / 100) * 460));
  const boysGrad = ctx.createLinearGradient(85, 0, 545, 0);
  boysGrad.addColorStop(0, '#0284c7');
  boysGrad.addColorStop(1, '#38bdf8');
  ctx.fillStyle = boysGrad;
  roundRect(ctx, 85, 385, boysBarW, 12, 6, true, false);

  ctx.fillStyle = '#64748B';
  ctx.font = '600 11px "Space Grotesk", sans-serif';
  ctx.fillText('DISCIPLES ROSTER (✓ = READ TODAY):', 85, 430);

  let bX = 85;
  let bY = 455;
  BOYS_ROSTER_DEFS.forEach(name => {
    const uRow = (data.rows || []).find(r => (r.username || '').trim().toLowerCase() === name.toLowerCase());
    const isRead = hasReadOnCurrentDay(uRow);
    const label = isRead ? `${name} ✓` : name;
    ctx.font = isRead ? '700 12px "Space Grotesk", sans-serif' : '500 12px "Space Grotesk", sans-serif';
    const tagW = ctx.measureText(label).width + 14;

    if (bX + tagW > 550) {
      bX = 85;
      bY += 28;
    }

    ctx.fillStyle = isRead ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.06)';
    ctx.strokeStyle = isRead ? '#38bdf8' : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, bX, bY - 14, tagW, 22, 6, true, true);

    ctx.fillStyle = isRead ? '#38bdf8' : '#94A3B8';
    ctx.fillText(label, bX + 7, bY + 2);
    bX += tagW + 6;
  });
  ctx.restore();

  // Right Card: Girls Squad
  ctx.save();
  ctx.fillStyle = 'rgba(30, 15, 25, 0.85)';
  ctx.strokeStyle = '#e11d48';
  ctx.lineWidth = 2;
  roundRect(ctx, 625, 210, 515, 305, 18, true, true);

  ctx.fillStyle = '#f472b6';
  roundRect(ctx, 625, 228, 6, 268, 3, true, false);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 22px "Space Grotesk", sans-serif';
  ctx.fillText('🏃‍♀️ GIRLS SQUAD', 650, 248);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 13px "Space Grotesk", sans-serif';
  ctx.fillText('6 Disciples • Cumulative Target: 552 Days', 650, 270);

  ctx.fillStyle = '#f472b6';
  ctx.font = '800 54px "Fraunces", Georgia, serif';
  ctx.fillText(`${data.girlsPct.toFixed(1)}%`, 650, 335);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = '600 17px "Space Grotesk", sans-serif';
  ctx.fillText(`${data.girlsDays} / 552 target days read`, 650, 368);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  roundRect(ctx, 650, 385, 460, 12, 6, true, false);
  const girlsBarW = Math.max(12, Math.min(460, (data.girlsPct / 100) * 460));
  const girlsGrad = ctx.createLinearGradient(650, 0, 1110, 0);
  girlsGrad.addColorStop(0, '#e11d48');
  girlsGrad.addColorStop(1, '#f472b6');
  ctx.fillStyle = girlsGrad;
  roundRect(ctx, 650, 385, girlsBarW, 12, 6, true, false);

  ctx.fillStyle = '#64748B';
  ctx.font = '600 11px "Space Grotesk", sans-serif';
  ctx.fillText('DISCIPLES ROSTER (✓ = READ TODAY):', 650, 430);

  let gX = 650;
  let gY = 455;
  GIRLS_ROSTER_DEFS.forEach(name => {
    const uRow = (data.rows || []).find(r => (r.username || '').trim().toLowerCase() === name.toLowerCase());
    const isRead = hasReadOnCurrentDay(uRow);
    const label = isRead ? `${name} ✓` : name;
    ctx.font = isRead ? '700 12px "Space Grotesk", sans-serif' : '500 12px "Space Grotesk", sans-serif';
    const tagW = ctx.measureText(label).width + 14;

    if (gX + tagW > 1115) {
      gX = 650;
      gY += 28;
    }

    ctx.fillStyle = isRead ? 'rgba(244, 114, 182, 0.25)' : 'rgba(255, 255, 255, 0.06)';
    ctx.strokeStyle = isRead ? '#f472b6' : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, gX, gY - 14, tagW, 22, 6, true, true);

    ctx.fillStyle = isRead ? '#f472b6' : '#94A3B8';
    ctx.fillText(label, gX + 7, gY + 2);
    gX += tagW + 6;
  });
  ctx.restore();

  // Segmented Comparison Ratio Bar
  ctx.save();
  const totalBothPct = data.boysPct + data.girlsPct;
  const boysShare = totalBothPct > 0 ? (data.boysPct / totalBothPct) : 0.5;
  const barTotalW = 1080;
  const barX = 60;
  const barY = 535;
  const barH = 16;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  roundRect(ctx, barX, barY, barTotalW, barH, 8, true, false);

  const boysSegW = Math.max(10, Math.min(barTotalW - 10, barTotalW * boysShare));
  ctx.fillStyle = '#0284c7';
  roundRect(ctx, barX, barY, boysSegW, barH, 8, true, false);

  ctx.fillStyle = '#f472b6';
  roundRect(ctx, barX + boysSegW, barY, barTotalW - boysSegW, barH, 8, true, false);
  ctx.restore();

  // Footer
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8a93b';
  ctx.font = '600 13px "Space Grotesk", sans-serif';
  ctx.fillText('🔥 Track live on: paulzhub.github.io/Bible-in-92-Days/', 60, 595);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 13px "Space Grotesk", sans-serif';
  ctx.fillText('#BibleIn92Days  •  The Youth Gathering 2026', 1140, 595);

  return canvas;
}

function openBoysVsGirlsShareModal() {
  const cur = getSession();
  if (cur && cur.isGuest) return;
  const modal = document.getElementById('bvg-share-modal');
  const previewImg = document.getElementById('bvg-share-card-preview');
  if (!modal) return;
  const canvas = generateBoysVsGirlsShareCanvas(lastBvgData);
  canvas.toBlob((blob) => {
    lastBvgCardBlob = blob;
    if (previewImg) previewImg.src = URL.createObjectURL(blob);
    modal.hidden = false;
  }, 'image/png');
}

function wireBoysVsGirlsShareButton(session) {
  const btn = document.getElementById('bvg-share-btn');
  if (!btn) return;

  const curSession = session || getSession();
  const isGuest = !curSession || !!curSession.isGuest;

  if (isGuest) {
    btn.disabled = true;
    btn.classList.add('disabled-guest');
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('title', 'Guest users cannot share Boys vs Girls showdown cards.');
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    return;
  }

  btn.disabled = false;
  btn.classList.remove('disabled-guest');
  btn.removeAttribute('aria-disabled');
  btn.setAttribute('title', 'Share Boys vs Girls progress as image');
  btn.onclick = () => {
    const cur = getSession();
    if (cur && cur.isGuest) return;
    openBoysVsGirlsShareModal();
  };
}

function initBoysVsGirlsShareModal() {
  const modal = document.getElementById('bvg-share-modal');
  const closeBtn = document.getElementById('close-bvg-share-modal');
  const downloadBtn = document.getElementById('download-bvg-card-btn');
  const nativeShareBtn = document.getElementById('native-share-bvg-btn');

  if (!modal) return;

  wireBoysVsGirlsShareButton();

  if (closeBtn) closeBtn.addEventListener('click', () => modal.hidden = true);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const cur = getSession();
      if (cur && cur.isGuest) return;
      if (!lastBvgCardBlob) return;
      const url = URL.createObjectURL(lastBvgCardBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Boys_vs_Girls_Progress_Day${currentDayNum || 0}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (nativeShareBtn) {
    nativeShareBtn.addEventListener('click', async () => {
      const cur = getSession();
      if (cur && cur.isGuest) return;
      if (!lastBvgCardBlob) return;
      const filename = `Boys_vs_Girls_Progress_Day${currentDayNum || 0}.png`;
      const file = new File([lastBvgCardBlob], filename, { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Boys vs Girls Cohort Showdown',
            text: `Boys vs Girls Cumulative Reading Showdown! ${lastBvgData ? lastBvgData.leadText : ''} 🔥 Bible in 92 Days with @tg.youth_`,
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
}

function celebrateTier(tier) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (typeof playMedallionChime === 'function') {
    playMedallionChime();
  }

  if ('vibrate' in navigator && tier.haptic) {
    try { navigator.vibrate(tier.haptic); } catch (e) {}
  }

  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const count = tier.big ? 150 : 70;
  const emojis = tier.emojis;
  const colors = tier.colors;
  const particles = [];

  for (let i = 0; i < count; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * (tier.big ? 450 : 220),
      y: canvas.height * 0.4 + (Math.random() - 0.5) * 120,
      vx: (Math.random() - 0.5) * (tier.big ? 16 : 10),
      vy: -(Math.random() * (tier.big ? 18 : 12) + 4),
      rot: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 12,
      color: colors[Math.floor(Math.random() * colors.length)],
      emoji: Math.random() > 0.3 ? emojis[Math.floor(Math.random() * emojis.length)] : null,
      size: Math.random() * 14 + 12,
      opacity: 1
    });
  }

  let startTime = null;
  const duration = tier.big ? 3500 : 2200;

  function animate(timestamp) {
    if (!startTime) startTime = timestamp;
    const progress = timestamp - startTime;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.38; // gravity
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

  // Scholar Crown badge if user correctly answered today's Daily Bible Bite Quiz
  const todayStr = formatDDMMYY(new Date());
  const quizKey = `bible92_quiz_correct_${todayStr}_${(row.username || '').toLowerCase()}`;
  if (localStorage.getItem(quizKey) === '1') {
    badges.push({ type: 'scholar', icon: '📜', label: 'Scholar (Quiz Solved)' });
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

function synthesizeReadingSidebarFromDOM() {
  if (typeof allPortionsCache !== 'undefined' && Array.isArray(allPortionsCache) && allPortionsCache.length > 0) {
    return;
  }
  const cards = document.querySelectorAll('.public-day-card');
  if (!cards || cards.length === 0) return;
  const portions = [];
  cards.forEach(card => {
    const day = Number(card.getAttribute('data-day'));
    const portionEl = card.querySelector('.public-day-portion');
    const dateEl = card.querySelector('.public-day-date');
    if (day && portionEl) {
      portions.push({
        day,
        portion: portionEl.textContent.trim(),
        date: dateEl ? dateEl.textContent.trim() : ''
      });
    }
  });
  if (portions.length > 0) {
    renderReadingSidebar(portions);
  }
}

function applyInitialData(res, session, { isBackgroundUpdate = false, isCached = false } = {}) {
  if (!res) return;

  const portionEl = document.getElementById('today-portion');
  const dateEl = document.getElementById('today-date');
  const lbBody = document.getElementById('leaderboard-body');
  const lbError = document.getElementById('leaderboard-error');
  const commentsListEl = document.getElementById('comments-list');
  const prayersListEl = document.getElementById('prayers-list');

  try { updateGuestBanner(res.activeGuests || res.activeGuest, session); } catch (e) { console.error(e); }

  try {
    if (res.today && res.today.success) {
      if (portionEl) portionEl.textContent = res.today.portion;
      if (dateEl) dateEl.textContent = res.today.date;
      currentDayNum = res.today.day;
      renderDayCountdown(res.today.day);
      renderTodayPortionDetail(res.today.portion, res.today.day, session);
    } else if (!isCached) {
      if (portionEl) portionEl.textContent = "No portion listed for today yet — check back soon.";
      if (dateEl) dateEl.textContent = res.today ? (res.today.date || '') : '';
      renderDayCountdown(null);
      renderTodayPortionDetail('', null, session);
    }
  } catch (e) { console.error('Error rendering today portion:', e); }

  try {
    if (res.allPortions && res.allPortions.success) {
      renderReadingSidebar(res.allPortions.portions);
    } else if (!isBackgroundUpdate) {
      synthesizeReadingSidebarFromDOM();
    }
  } catch (e) { console.error('Error rendering reading sidebar:', e); }

  try {
    if (res.nudges && res.nudges.success) {
      currentNudges = res.nudges.nudges || [];
      if (session && !session.isGuest) {
        const todayStr = formatDDMMYY(new Date());
        const serverTargets = currentNudges
          .filter(n => n.sender && n.sender.toLowerCase() === session.username.toLowerCase())
          .map(n => n.target ? n.target.toLowerCase() : '');
        const localTargets = getPersistedNudgedTargets(todayStr, session.username);
        nudgedTargetsToday = new Set([...serverTargets, ...localTargets].filter(Boolean));
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
      if (lbError) lbError.hidden = true;
    } else if (!isCached) {
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
      activeSelectedWeek = res.recap.weekNum;
      renderWeeklyRecap(res.recap);
    }
    const allTime = res.allTimeStats || (res.recap && res.recap.allTimeStats);
    if (allTime) {
      renderAllTimeStats(allTime, res.leaderboard ? res.leaderboard.leaderboard : null);
    }
  } catch (e) { console.error('Error rendering weekly recap or all-time stats:', e); }

  const todayStr = formatDDMMYY(new Date());
  const isViewingTodayComments = !activeCommentsDate || activeCommentsDate === todayStr;
  try {
    if (res.comments && res.comments.success && isViewingTodayComments) {
      commentsCache = res.comments.comments || [];
      if (session && session.username) {
        mergePersistedReactions(commentsCache, 'comments', activeCommentsDate || todayStr, session.username, REACTIONS.map(r => r.type));
      }
      renderComments(session);
      updateCommentFormVisibility(session);
    } else if (!isCached && isViewingTodayComments) {
      if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Could not load comments.</p>';
    }
  } catch (e) { console.error('Error rendering comments:', e); }

  const isViewingTodayPrayers = !activePrayersDate || activePrayersDate === todayStr;
  try {
    if (res.prayers && res.prayers.success && isViewingTodayPrayers) {
      prayersCache = res.prayers.prayers || [];
      if (session && session.username) {
        mergePersistedReactions(prayersCache, 'prayers', activePrayersDate || todayStr, session.username, PRAYER_REACTIONS_MAP.map(r => r.key));
      }
      renderPrayers(session);
      updatePrayerFormVisibility(session);
    } else if (!isCached && isViewingTodayPrayers) {
      if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Could not load prayers.</p>';
    }
  } catch (e) { console.error('Error rendering prayers:', e); }

  try {
    if (res.history && res.history.success) {
      renderHeatmap(res.history.history || []);
    }
  } catch (e) { console.error('Error rendering heatmap:', e); }
}

async function loadInitialData(session, retryCount = 0) {
  const INITIAL_CACHE_KEY = `bible92_initial_cache_${(session.username || '').toLowerCase()}`;

  // 1. Instant Cache Hydration: Render cached snapshot in < 50ms
  if (retryCount === 0) {
    try {
      const rawCache = localStorage.getItem(INITIAL_CACHE_KEY) || localStorage.getItem('bible92_initial_cache');
      if (rawCache) {
        const cachedRes = JSON.parse(rawCache);
        if (cachedRes && typeof cachedRes === 'object') {
          applyInitialData(cachedRes, session, { isBackgroundUpdate: false, isCached: true });
        }
      } else {
        synthesizeReadingSidebarFromDOM();
      }
    } catch (e) {
      console.warn('Error hydrating initial cache:', e);
      synthesizeReadingSidebarFromDOM();
    }
  }

  // 2. Fetch fresh data from network in the background
  const portionEl = document.getElementById('today-portion');
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
    // Only display error messages if no cached data was rendered
    if (!currentLeaderboard || currentLeaderboard.length === 0) {
      if (portionEl) portionEl.textContent = "Couldn't load today's portion. Check your connection.";
      if (lbBody) lbBody.innerHTML = '';
      if (lbError) {
        lbError.textContent = "Couldn't reach the server. Please refresh.";
        lbError.hidden = false;
      }
      if (commentsListEl) commentsListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
      if (prayersListEl) prayersListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
    }
    return;
  }

  if (!res) return;

  // 3. Persist updated snapshot for instant subsequent loads
  try {
    localStorage.setItem(INITIAL_CACHE_KEY, JSON.stringify(res));
    localStorage.setItem('bible92_initial_cache', JSON.stringify(res));
  } catch (e) {}

  // 4. Seamlessly update UI with fresh data
  applyInitialData(res, session, { isBackgroundUpdate: true, isCached: false });
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
          const todayStr = formatDDMMYY(new Date());
          const serverTargets = currentNudges
            .filter(n => n.sender && n.sender.toLowerCase() === session.username.toLowerCase())
            .map(n => n.target ? n.target.toLowerCase() : '');
          const localTargets = getPersistedNudgedTargets(todayStr, session.username);
          // Merge without wiping recently sent local nudges
          nudgedTargetsToday = new Set([...nudgedTargetsToday, ...serverTargets, ...localTargets].filter(Boolean));
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
        if (!activeSelectedWeek || activeSelectedWeek === res.recap.weekNum) {
          currentWeeklyRecap = res.recap;
          renderWeeklyRecap(res.recap);
        }
      }
      const allTime = res.allTimeStats || (res.recap && res.recap.allTimeStats);
      if (allTime) {
        renderAllTimeStats(allTime, res.leaderboard ? res.leaderboard.leaderboard : null);
      }
    } catch (e) {}

    const todayStr = formatDDMMYY(new Date());
    const isViewingTodayComments = !activeCommentsDate || activeCommentsDate === todayStr;
    try {
      if (res.comments && res.comments.success && isViewingTodayComments) {
        commentsCache = res.comments.comments || [];
        if (session && session.username) {
          mergePersistedReactions(commentsCache, 'comments', todayStr, session.username, REACTIONS.map(r => r.type));
        }
        renderComments(session);
        updateCommentFormVisibility(session);
      }
    } catch (e) {}

    const isViewingTodayPrayers = !activePrayersDate || activePrayersDate === todayStr;
    try {
      if (res.prayers && res.prayers.success && isViewingTodayPrayers) {
        prayersCache = res.prayers.prayers || [];
        if (session && session.username) {
          mergePersistedReactions(prayersCache, 'prayers', todayStr, session.username, PRAYER_REACTIONS_MAP.map(r => r.key));
        }
        renderPrayers(session);
        updatePrayerFormVisibility(session);
      }
    } catch (e) {}

    try {
      if (res.history && res.history.success) {
        renderHeatmap(res.history.history || []);
      }
    } catch (e) {}

    // Update persistent cache with the latest updates
    try {
      const INITIAL_CACHE_KEY = `bible92_initial_cache_${(session.username || '').toLowerCase()}`;
      const rawCache = localStorage.getItem(INITIAL_CACHE_KEY) || localStorage.getItem('bible92_initial_cache');
      if (rawCache) {
        const cachedRes = JSON.parse(rawCache);
        if (cachedRes && typeof cachedRes === 'object') {
          if (res.leaderboard) cachedRes.leaderboard = res.leaderboard;
          if (res.recap) cachedRes.recap = res.recap;
          if (res.allTimeStats) cachedRes.allTimeStats = res.allTimeStats;
          if (res.comments) cachedRes.comments = res.comments;
          if (res.prayers) cachedRes.prayers = res.prayers;
          if (res.nudges) cachedRes.nudges = res.nudges;
          if (res.activeGuests || res.activeGuest) {
            cachedRes.activeGuests = res.activeGuests || cachedRes.activeGuests;
            cachedRes.activeGuest = res.activeGuest || cachedRes.activeGuest;
          }
          if (res.history) cachedRes.history = res.history;
          localStorage.setItem(INITIAL_CACHE_KEY, JSON.stringify(cachedRes));
        }
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
      headerLevelEl.onclick = () => {
        const info = getLevelProgressInfo(me.daysCompleted || 0);
        if (window.openLevelMedallion) {
          window.openLevelMedallion(info.currentLevelNum || 1);
        }
      };
    }
  }
  renderLevelProgress(leaderboard, session);
}

let currentUserCompletedDays = 0;

function getUserDaysCompleted() {
  const session = getSession();
  if (!session || session.isGuest) return 0;
  if (currentUserData && typeof currentUserData.daysCompleted === 'number') {
    return currentUserData.daysCompleted;
  }
  return currentUserCompletedDays;
}

// ====== LEVEL PROGRESSION HELPERS ======

function toRoman(num) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let result = '';
  for (let i = 0; i < map.length; i++) {
    while (num >= map[i][0]) {
      result += map[i][1];
      num -= map[i][0];
    }
  }
  return result;
}

function getLevelProgressInfo(daysCompleted) {
  const TOTAL_DAYS = 92;
  const days = Math.max(0, Number(daysCompleted) || 0);

  if (days >= TOTAL_DAYS) {
    return {
      currentLevelNum: 11,
      currentLevelTitle: 'Finisher 🏆',
      nextLevelNum: 11,
      nextLevelTitle: 'Max Level',
      currentTierStart: 92,
      nextTierTarget: 92,
      tierProgress: 2,
      tierTotal: 2,
      pct: 100,
      daysRemaining: 0,
      isMaxLevel: true
    };
  }

  const currentTier = Math.floor(days / 10) + 1; // 1 to 10
  const currentTitle = 'Disciple ' + toRoman(currentTier);

  if (currentTier === 10) {
    // Days 90-91: Target is Finisher 🏆 at 92 days
    const tierStart = 90;
    const tierTarget = 92;
    const tierProgress = days - tierStart;
    const tierTotal = 2;
    const pct = Math.round((tierProgress / tierTotal) * 100);
    const daysRemaining = tierTarget - days;
    return {
      currentLevelNum: 10,
      currentLevelTitle: currentTitle,
      nextLevelNum: 11,
      nextLevelTitle: 'Finisher 🏆',
      currentTierStart: tierStart,
      nextTierTarget: tierTarget,
      tierProgress,
      tierTotal,
      pct,
      daysRemaining,
      isMaxLevel: false
    };
  }

  const tierStart = (currentTier - 1) * 10;
  const tierTarget = currentTier * 10;
  const nextTitle = 'Disciple ' + toRoman(currentTier + 1);
  const tierProgress = days - tierStart;
  const tierTotal = 10;
  const pct = Math.round((tierProgress / tierTotal) * 100);
  const daysRemaining = tierTarget - days;

  return {
    currentLevelNum: currentTier,
    currentLevelTitle: currentTitle,
    nextLevelNum: currentTier + 1,
    nextLevelTitle: nextTitle,
    currentTierStart: tierStart,
    nextTierTarget: tierTarget,
    tierProgress,
    tierTotal,
    pct,
    daysRemaining,
    isMaxLevel: false
  };
}

function renderLevelProgress(rows, session) {
  const curBadge = document.getElementById('level-current-badge');
  const arrowEl = document.getElementById('level-arrow');
  const nextBadge = document.getElementById('level-next-badge');
  const progressBar = document.getElementById('level-progress-bar');
  const progressWrap = document.getElementById('level-progressbar');
  const statsEl = document.getElementById('level-progress-stats');
  const remainingEl = document.getElementById('level-progress-remaining');
  const pctEl = document.getElementById('level-progress-pct');

  if (!progressBar) return;

  const curSession = session || getSession();
  const isGuest = !curSession || curSession.isGuest;
  
  const me = (!isGuest && rows) ? rows.find(r => curSession && r.username && r.username.toLowerCase() === curSession.username.toLowerCase()) : null;
  const daysCompleted = me ? (me.daysCompleted || 0) : 0;
  const info = getLevelProgressInfo(daysCompleted);

  if (isGuest) {
    if (curBadge) {
      curBadge.textContent = 'Guest Explorer';
      curBadge.className = 'level-badge';
    }
    if (arrowEl) arrowEl.hidden = false;
    if (nextBadge) {
      nextBadge.textContent = 'Disciple Account';
      nextBadge.hidden = false;
      nextBadge.className = 'level-badge next-level-pill';
    }
    progressBar.style.width = '0%';
    if (progressWrap) progressWrap.setAttribute('aria-valuenow', '0');
    if (statsEl) statsEl.textContent = 'Guest preview mode';
    if (remainingEl) remainingEl.textContent = 'Sign in with a disciple account to track your level progression';
    if (pctEl) pctEl.textContent = '0%';
    return;
  }

  // Logged-in disciple
  if (curBadge) {
    curBadge.textContent = info.currentLevelTitle;
    curBadge.className = 'level-badge' + (info.isMaxLevel ? ' finisher' : '');
  }

  if (info.isMaxLevel) {
    if (arrowEl) arrowEl.hidden = true;
    if (nextBadge) nextBadge.hidden = true;
    progressBar.style.width = '100%';
    if (progressWrap) progressWrap.setAttribute('aria-valuenow', '100');
    if (statsEl) statsEl.textContent = `${TOTAL_CHALLENGE_DAYS} / ${TOTAL_CHALLENGE_DAYS} days completed`;
    if (remainingEl) remainingEl.textContent = 'Max Level Achieved! You finished all 92 days! 🏆';
    if (pctEl) pctEl.textContent = '100%';
  } else {
    if (arrowEl) arrowEl.hidden = false;
    if (nextBadge) {
      nextBadge.hidden = false;
      nextBadge.textContent = info.nextLevelTitle;
      nextBadge.className = 'level-badge next-level-pill' + (info.nextLevelTitle.includes('Finisher') ? ' finisher' : '');
    }
    progressBar.style.width = `${info.pct}%`;
    if (progressWrap) progressWrap.setAttribute('aria-valuenow', String(info.pct));
    if (statsEl) statsEl.textContent = `${info.tierProgress} / ${info.tierTotal} days in tier`;
    if (remainingEl) {
      const dayWord = info.daysRemaining === 1 ? 'day' : 'days';
      remainingEl.textContent = `${info.daysRemaining} ${dayWord} until ${info.nextLevelTitle}`;
    }
    if (pctEl) pctEl.textContent = `${info.pct}%`;
  }

  const inspectBtn = document.getElementById('inspect-medallion-btn');
  const openCurrentMedallion = () => {
    if (window.openLevelMedallion) {
      window.openLevelMedallion(info.currentLevelNum || 1);
    }
  };
  const openNextMedallion = () => {
    if (window.openLevelMedallion) {
      window.openLevelMedallion(info.nextLevelNum || 2);
    }
  };

  if (curBadge) curBadge.onclick = openCurrentMedallion;
  if (nextBadge) nextBadge.onclick = openNextMedallion;
  if (inspectBtn) inspectBtn.onclick = openCurrentMedallion;

  currentUserCompletedDays = daysCompleted;
  if (window.ambientCelestialBg && typeof window.ambientCelestialBg.setDaysCompleted === 'function') {
    window.ambientCelestialBg.setDaysCompleted(daysCompleted);
  }
  if (window.updateMedallionUnlockedTiers) {
    window.updateMedallionUnlockedTiers();
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

function badgeFor(daysCompleted, streak) {
  if (daysCompleted >= TOTAL_CHALLENGE_DAYS) return { icon: '🏆', label: 'Finished all 92 days!' };
  if (daysCompleted >= 46) return { icon: '🌟', label: 'Halfway there — 46+ days' };
  if (daysCompleted >= 5 && streak > 0) {
    const tier = Math.floor(daysCompleted / 5) * 5;
    return { icon: '🔥', label: tier + '-day milestone' };
  }
  return null;
}

let activeLeaderboardFilter = 'days';
let isLeaderboardFilterTabsInitialized = false;

function initLeaderboardFilterTabs() {
  if (isLeaderboardFilterTabsInitialized) return;
  const tabButtons = document.querySelectorAll('.lb-filter-btn');
  if (!tabButtons.length) return;

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter || 'days';
      activeLeaderboardFilter = filter;
      tabButtons.forEach(b => {
        const isSelected = b === btn;
        b.classList.toggle('active', isSelected);
        b.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });
      const curSession = getSession();
      if (currentLeaderboard && currentLeaderboard.length > 0) {
        renderLeaderboard(currentLeaderboard, curSession);
      }
    });
  });
  isLeaderboardFilterTabsInitialized = true;
}

function renderLeaderboard(rows, session) {
  initLeaderboardFilterTabs();
  const readCount = (rows || []).filter(r => r.readToday).length;
  if (readCount >= 2) {
    checkSquadMilestoneCelebration(readCount);
  }
  renderSquadGauge(rows);
  renderBoysVsGirlsProgress(rows);
  renderLevelProgress(rows, session);
  const body = document.getElementById('leaderboard-body');
  document.getElementById('leaderboard-error').hidden = true;
  body.innerHTML = '';

  const me = rows.find(r => session && r.username === session.username);
  const meHasReadToday = me && me.readToday;

  // Clone rows for filter-specific sorting
  const sortedRows = [...rows];
  if (activeLeaderboardFilter === 'streak') {
    sortedRows.sort((a, b) => {
      const sA = Math.min(a.streak || 0, a.daysCompleted || 0);
      const sB = Math.min(b.streak || 0, b.daysCompleted || 0);
      if (sB !== sA) return sB - sA;
      if (b.daysCompleted !== a.daysCompleted) return b.daysCompleted - a.daysCompleted;
      if (a.lastReadTimestamp > 0 && b.lastReadTimestamp > 0) {
        if (a.lastReadTimestamp !== b.lastReadTimestamp) return a.lastReadTimestamp - b.lastReadTimestamp;
      } else if (a.lastReadTimestamp > 0) return -1;
      else if (b.lastReadTimestamp > 0) return 1;
      return (a.username || '').localeCompare(b.username || '');
    });
  } else if (activeLeaderboardFilter === 'level') {
    sortedRows.sort((a, b) => {
      const lA = a.levelNum || 1;
      const lB = b.levelNum || 1;
      if (lB !== lA) return lB - lA;
      if (b.daysCompleted !== a.daysCompleted) return b.daysCompleted - a.daysCompleted;
      if (a.lastReadTimestamp > 0 && b.lastReadTimestamp > 0) {
        if (a.lastReadTimestamp !== b.lastReadTimestamp) return a.lastReadTimestamp - b.lastReadTimestamp;
      } else if (a.lastReadTimestamp > 0) return -1;
      else if (b.lastReadTimestamp > 0) return 1;
      const sA = a.streak || 0;
      const sB = b.streak || 0;
      if (sB !== sA) return sB - sA;
      return (a.username || '').localeCompare(b.username || '');
    });
  } else {
    // Standard all-time days rank
    sortedRows.sort((a, b) => {
      if (b.daysCompleted !== a.daysCompleted) return b.daysCompleted - a.daysCompleted;
      if (a.lastReadTimestamp > 0 && b.lastReadTimestamp > 0) {
        if (a.lastReadTimestamp !== b.lastReadTimestamp) return a.lastReadTimestamp - b.lastReadTimestamp;
      } else if (a.lastReadTimestamp > 0) return -1;
      else if (b.lastReadTimestamp > 0) return 1;
      const sA = a.streak || 0;
      const sB = b.streak || 0;
      if (sB !== sA) return sB - sA;
      return (a.username || '').localeCompare(b.username || '');
    });
  }

  sortedRows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const isYou = session && row.username === session.username;
    if (isYou) {
      tr.classList.add('is-you');
      checkMilestoneCelebration(row.daysCompleted);
    }

    const rankNum = index + 1;
    const rankTd = document.createElement('td');
    rankTd.className = 'rank-cell';
    let rankBadge = '';
    if (rankNum === 1) rankBadge = ' 🏆';
    else if (rankNum === 2) rankBadge = ' 🥈';
    else if (rankNum === 3) rankBadge = ' 🥉';
    rankTd.textContent = `${rankNum}${rankBadge}`;

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

    const safeStreak = Math.min(row.streak || 0, row.daysCompleted || 0);
    const badge = badgeFor(row.daysCompleted, safeStreak);
    if (badge && (badge.icon !== '🔥' || safeStreak > 0)) {
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

    // Available Streak Freezes Counter (max 3)
    if (row.freezesAvailable !== undefined && row.freezesAvailable > 0) {
      const displayFreezes = Math.min(3, row.freezesAvailable);
      const freezeSpan = document.createElement('span');
      freezeSpan.className = 'freezes-left-badge';
      freezeSpan.textContent = `🧊 ${displayFreezes} left`;
      freezeSpan.title = `${displayFreezes} streak freeze(s) available (max 3)`;
      nameRow.appendChild(freezeSpan);
    }

    // Squad Nudge / Encouragement Ping Action
    if (!row.readToday && !isYou && session && !session.isGuest) {
      const nudgeBtn = document.createElement('button');
      nudgeBtn.type = 'button';
      const isAlreadyNudged = nudgedTargetsToday.has(row.username ? row.username.toLowerCase() : '');
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
      nudgeTag.textContent = `⚡ ${nudgesReceived}x`;
      const nudgeTooltip = document.createElement('span');
      nudgeTooltip.className = 'nudge-hover-tooltip';
      nudgeTooltip.textContent = `Nudged by: ${sendersStr}`;
      nudgeTag.appendChild(nudgeTooltip);
      nudgeTag.title = `Nudged by: ${sendersStr}`;
      nameRow.appendChild(nudgeTag);
    }

    readerTd.appendChild(nameRow);

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
  const recapSection = document.getElementById('section-recap');
  if (!recapSection) return;

  const select = document.getElementById('recap-week-select');
  const matrixSelect = document.getElementById('squad-matrix-week-select');

  const populateWeekSelect = (el) => {
    if (!el || el.children.length > 0) return;
    el.innerHTML = '';
    const total = recap.totalWeeks || 14;
    for (let w = 1; w <= total; w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}` + (w === recap.currentWeek ? ' (Current)' : '');
      el.appendChild(opt);
    }
  };

  populateWeekSelect(select);
  populateWeekSelect(matrixSelect);

  if (select) select.value = recap.weekNum;
  if (matrixSelect) matrixSelect.value = recap.weekNum;

  const handleWeekChange = async (selectedWeek) => {
    activeSelectedWeek = selectedWeek;
    if (select) select.value = selectedWeek;
    if (matrixSelect) matrixSelect.value = selectedWeek;
    try {
      const res = await apiGet({ action: 'getWeeklyRecap', weekNum: selectedWeek });
      if (res.success) {
        renderWeeklyRecap(res);
        if (res.allTimeStats) {
          renderAllTimeStats(res.allTimeStats);
        }
      }
    } catch (err) {
      // silent fail
    }
  };

  if (select && !select.dataset.bound) {
    select.dataset.bound = 'true';
    select.addEventListener('change', (e) => {
      handleWeekChange(parseInt(e.target.value, 10));
    });
  }

  if (matrixSelect && !matrixSelect.dataset.bound) {
    matrixSelect.dataset.bound = 'true';
    matrixSelect.addEventListener('change', (e) => {
      handleWeekChange(parseInt(e.target.value, 10));
    });
  }

  document.getElementById('recap-title').textContent = `Week ${recap.weekNum} Highlights (Days ${recap.startDayNum}–${recap.endDayNum})`;
  document.getElementById('recap-pct').textContent = `${recap.stats.weeklyCompletionPct}%`;
  
  const topReaders = (recap.stats.topReaders || []).slice(0, 3);
  let topReadersText = 'None yet';
  if (topReaders.length > 0) {
    const maxReads = recap.stats.maxWeeklyReads !== undefined ? recap.stats.maxWeeklyReads : null;
    const totalWeekDays = (recap.endDayNum - recap.startDayNum + 1);
    topReadersText = maxReads !== null
      ? `${topReaders.join(', ')} (${maxReads}/${totalWeekDays}d)`
      : topReaders.join(', ');
  }
  document.getElementById('recap-top-reader').textContent = topReadersText;

  // Top Weekly Streak within this week
  let topWeeklyStreakText = '—';
  if (recap.stats.topWeeklyStreak) {
    const stk = recap.stats.topWeeklyStreak.streak || 0;
    const holders = (recap.stats.topWeeklyStreak.holders || []).slice(0, 3);
    if (stk > 0 && holders.length > 0) {
      topWeeklyStreakText = `${holders.join(', ')} (${stk}d)`;
    }
  } else if (recap.stats.topStreakHolder && recap.stats.topStreakHolder.streak > 0) {
    topWeeklyStreakText = `${recap.stats.topStreakHolder.username} (${recap.stats.topStreakHolder.streak}d)`;
  }
  document.getElementById('recap-top-streak').textContent = topWeeklyStreakText;

  // Days Read This Week (strictly for this week)
  const actualReads = recap.stats.totalActualReadings !== undefined
    ? recap.stats.totalActualReadings
    : (recap.stats.daysReadThisWeek !== undefined ? recap.stats.daysReadThisWeek : 0);
  const possibleReads = recap.stats.totalPossibleReadings || 0;
  document.getElementById('recap-total-days').textContent = possibleReads > 0
    ? `${actualReads} / ${possibleReads}`
    : `${actualReads}`;

  // Render the communal 13x7 Squad Reading Heatmap Matrix
  renderSquadMatrix(recap);
}

function renderSquadMatrix(recap) {
  const thead = document.getElementById('squad-matrix-thead');
  const tbody = document.getElementById('squad-matrix-tbody');
  if (!thead || !tbody) return;

  const weekDays = (recap && recap.stats && recap.stats.weekDays) || [];
  const squadMatrix = (recap && recap.stats && recap.stats.squadMatrix) || [];

  if (!squadMatrix.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="squad-matrix-loading">No squad matrix data for this week yet.</td></tr>';
    return;
  }

  // Render Table Header with dynamic Days (e.g., D1, D2, ... or Day 1, Day 2)
  thead.innerHTML = '';
  const headTr = document.createElement('tr');
  const youthTh = document.createElement('th');
  youthTh.textContent = 'Youth';
  headTr.appendChild(youthTh);

  const numCols = weekDays.length > 0 ? weekDays.length : 7;
  for (let c = 0; c < numCols; c++) {
    const dayTh = document.createElement('th');
    const dayInfo = weekDays[c];
    if (dayInfo) {
      dayTh.textContent = `D${dayInfo.day}`;
      dayTh.title = `Day ${dayInfo.day}: ${dayInfo.date}`;
    } else {
      dayTh.textContent = `D${c + 1}`;
    }
    headTr.appendChild(dayTh);
  }

  const totalTh = document.createElement('th');
  totalTh.textContent = 'Total';
  headTr.appendChild(totalTh);
  thead.appendChild(headTr);

  // Render Table Body for each member
  tbody.innerHTML = '';
  squadMatrix.forEach(member => {
    const tr = document.createElement('tr');
    const curSession = getSession();
    if (curSession && member.username.toLowerCase() === curSession.username.toLowerCase()) {
      tr.classList.add('is-you');
    }

    const nameTd = document.createElement('td');
    nameTd.className = 'matrix-user-name';
    nameTd.textContent = member.username;
    tr.appendChild(nameTd);

    (member.days || []).forEach(dayObj => {
      const dayTd = document.createElement('td');
      const cellSpan = document.createElement('span');
      cellSpan.className = 'squad-matrix-cell';

      if (dayObj.read) {
        cellSpan.classList.add('read');
        cellSpan.textContent = '✓';
        cellSpan.title = `${member.username} read Day ${dayObj.day} (${dayObj.date})`;
      } else {
        cellSpan.classList.add('unread');
        cellSpan.textContent = '·';
        cellSpan.title = `${member.username} has not marked Day ${dayObj.day} (${dayObj.date})`;
      }
      dayTd.appendChild(cellSpan);
      tr.appendChild(dayTd);
    });

    const totalTd = document.createElement('td');
    totalTd.className = 'matrix-user-total';
    totalTd.textContent = `${member.totalReadThisWeek}/${member.days.length}`;
    tr.appendChild(totalTd);

    tbody.appendChild(tr);
  });
}

// ====== SECTION 3B: ALL TIME STATS ======

function renderAllTimeStats(allTimeStats, leaderboard) {
  if (!allTimeStats) {
    if (leaderboard && leaderboard.length > 0) {
      let totalDays = 0;
      let maxDays = 0;
      let maxStreak = 0;
      leaderboard.forEach(u => {
        const d = u.daysCompleted || 0;
        const s = u.streak || 0;
        totalDays += d;
        if (d > maxDays) maxDays = d;
        if (s > maxStreak) maxStreak = s;
      });
      const topReaders = leaderboard.filter(u => u.daysCompleted === maxDays).map(u => u.username).slice(0, 3);
      const topStreakers = leaderboard.filter(u => u.streak === maxStreak && maxStreak > 0).map(u => u.username).slice(0, 3);
      const totalPossible = 92 * (leaderboard.length || 13);
      const pct = totalPossible > 0 ? Number(((totalDays / totalPossible) * 100).toFixed(2)) : 0;
      allTimeStats = {
        completionPct: pct,
        totalGroupDaysCompleted: totalDays,
        totalPossibleDays: totalPossible,
        topReaders: topReaders,
        maxDays: maxDays,
        topStreakHolders: topStreakers,
        topStreak: maxStreak
      };
    } else {
      return;
    }
  }

  const totalPossible = allTimeStats.totalPossibleDays || (92 * 13);
  const totalDays = allTimeStats.totalGroupDaysCompleted || 0;
  let pctVal = allTimeStats.completionPct;
  if (pctVal === undefined || pctVal === null || isNaN(pctVal)) {
    pctVal = totalPossible > 0 ? ((totalDays / totalPossible) * 100).toFixed(2) : '0.00';
  } else {
    pctVal = Number(pctVal).toFixed(2);
  }

  const pctEl = document.getElementById('alltime-pct');
  if (pctEl) pctEl.textContent = `${pctVal}%`;

  const topReaderEl = document.getElementById('alltime-top-reader');
  if (topReaderEl) {
    const readers = (allTimeStats.topReaders || []).slice(0, 3);
    const maxDaysVal = allTimeStats.maxDays || allTimeStats.maxAllTimeDays || 0;
    topReaderEl.textContent = readers.length > 0
      ? (maxDaysVal > 0 ? `${readers.join(', ')} (${maxDaysVal}d)` : readers.join(', '))
      : '—';
  }

  const topStreakEl = document.getElementById('alltime-top-streak');
  if (topStreakEl) {
    const holders = (allTimeStats.topStreakHolders || []).slice(0, 3);
    const streakVal = allTimeStats.topStreak !== undefined ? allTimeStats.topStreak : 0;
    topStreakEl.textContent = streakVal > 0 && holders.length > 0
      ? `${holders.join(', ')} (${streakVal}d)`
      : (allTimeStats.topStreakHolder && allTimeStats.topStreakHolder.streak > 0
        ? `${allTimeStats.topStreakHolder.username} (${allTimeStats.topStreakHolder.streak}d)`
        : '0 days');
  }

  const totalDaysEl = document.getElementById('alltime-total-days');
  if (totalDaysEl) {
    totalDaysEl.textContent = `${totalDays} / ${totalPossible}`;
  }
}

// ====== REACTION PERSISTENCE HELPERS (COMMENTS & PRAYERS) ======
function getPersistedReactionMap(category, dateStr, username) {
  if (!username || !dateStr) return {};
  try {
    const key = `bible92_reactions_${category}_${dateStr}_${username.toLowerCase()}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function persistReaction(category, dateStr, username, targetUsername, reactionType) {
  if (!username || !dateStr || !targetUsername) return;
  try {
    const key = `bible92_reactions_${category}_${dateStr}_${username.toLowerCase()}`;
    const map = getPersistedReactionMap(category, dateStr, username);
    if (reactionType) {
      map[targetUsername] = reactionType;
    } else {
      map[targetUsername] = null;
    }
    localStorage.setItem(key, JSON.stringify(map));
  } catch (e) {}
}

function mergePersistedReactions(items, category, dateStr, username, allReactionTypes) {
  if (!items || !items.length || !username || !dateStr) return items;
  const map = getPersistedReactionMap(category, dateStr, username);
  if (!map || Object.keys(map).length === 0) return items;

  items.forEach(item => {
    if (!item || !item.username) return;
    if (!item.reactions) item.reactions = {};
    allReactionTypes.forEach(t => {
      if (!item.reactions[t]) item.reactions[t] = [];
    });

    const targetUser = item.username;
    if (Object.prototype.hasOwnProperty.call(map, targetUser)) {
      const userSavedType = map[targetUser];
      allReactionTypes.forEach(t => {
        item.reactions[t] = (item.reactions[t] || []).filter(u => u !== username);
      });
      if (userSavedType && item.reactions[userSavedType]) {
        item.reactions[userSavedType].push(username);
      }
    }
  });
  return items;
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

  let newType = null;
  if (!wasActiveInThisType) {
    targetObj[type].push(session.username);
    newType = type;
  }

  const activeDate = activeCommentsDate || formatDDMMYY(new Date());
  persistReaction('comments', activeDate, session.username, targetUsername, newType);

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
    type,
    date: activeDate
  }).then(res => {
    if (res && res.success && res.reactions) {
      comment.reactions = res.reactions;
      const serverActiveType = Object.keys(res.reactions).find(t => (res.reactions[t] || []).includes(session.username)) || null;
      persistReaction('comments', activeDate, session.username, targetUsername, serverActiveType);
    }
  }).catch((err) => {
    console.warn('Silent notice: Comment reaction synced locally; backend sync notice:', err);
  });
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

  const canModerate = (isYou || (session && session.isAdmin)) && (!session || !session.isGuest);
  if (canModerate) {
    const actionsGroup = document.createElement('div');
    actionsGroup.className = 'comment-actions-group';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'comment-edit-btn';
    editBtn.innerHTML = '✏️ Edit';
    editBtn.title = isYou ? 'Edit your comment' : `Edit ${comment.username}'s comment (Admin)`;
    editBtn.addEventListener('click', () => {
      startEditingComment(item, comment, session);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'comment-delete-btn';
    deleteBtn.innerHTML = '🗑️ Delete';
    deleteBtn.title = isYou ? 'Delete your comment' : `Delete ${comment.username}'s comment (Admin)`;
    deleteBtn.addEventListener('click', () => {
      confirmAndDeleteComment(session, comment.username, activeCommentsDate);
    });

    actionsGroup.append(editBtn, deleteBtn);
    head.appendChild(actionsGroup);
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

function startEditingComment(cardEl, comment, session) {
  const existingEditBox = cardEl.querySelector('.comment-edit-box');
  if (existingEditBox) return;

  const textEl = cardEl.querySelector('.comment-text');
  const actionsBar = cardEl.querySelector('.comment-actions-bar');
  const actionsGroup = cardEl.querySelector('.comment-actions-group');
  if (!textEl) return;

  textEl.hidden = true;
  if (actionsBar) actionsBar.hidden = true;
  if (actionsGroup) actionsGroup.hidden = true;

  const editBox = document.createElement('div');
  editBox.className = 'comment-edit-box';

  const textarea = document.createElement('textarea');
  textarea.className = 'comment-edit-textarea';
  textarea.value = comment.text;
  textarea.maxLength = 2500;
  textarea.rows = 4;

  const footer = document.createElement('div');
  footer.className = 'comment-edit-footer';

  const counter = document.createElement('span');
  counter.className = 'comment-edit-counter';
  counter.textContent = getCharAndWordCount(textarea.value);

  textarea.addEventListener('input', () => {
    counter.textContent = getCharAndWordCount(textarea.value);
  });

  const btns = document.createElement('div');
  btns.className = 'comment-edit-btns';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'comment-edit-cancel-btn';
  cancelBtn.textContent = '✖ Cancel';
  cancelBtn.addEventListener('click', () => {
    editBox.remove();
    textEl.hidden = false;
    if (actionsBar) actionsBar.hidden = false;
    if (actionsGroup) actionsGroup.hidden = false;
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'comment-edit-save-btn';
  saveBtn.textContent = '💾 Save Changes';
  saveBtn.addEventListener('click', async () => {
    const newText = textarea.value.trim();
    if (!newText) {
      alert('Comment text cannot be empty.');
      return;
    }
    if (newText === comment.text) {
      editBox.remove();
      textEl.hidden = false;
      if (actionsBar) actionsBar.hidden = false;
      if (actionsGroup) actionsGroup.hidden = false;
      return;
    }

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const res = await apiGet({
        action: 'editComment',
        username: session.username,
        password: session.password,
        targetUsername: comment.username,
        text: newText,
        date: activeCommentsDate || formatDDMMYY(new Date())
      });

      if (res && res.success) {
        comment.text = newText;
        textEl.textContent = newText;
        const cached = commentsCache.find(c => c.username === comment.username);
        if (cached) cached.text = newText;

        editBox.remove();
        textEl.hidden = false;
        if (actionsBar) actionsBar.hidden = false;
        if (actionsGroup) actionsGroup.hidden = false;

        const feedback = document.getElementById('comment-feedback');
        if (feedback) {
          feedback.hidden = false;
          feedback.className = 'form-feedback success';
          feedback.textContent = 'Comment updated successfully!';
          setTimeout(() => { feedback.hidden = true; }, 3500);
        }
      } else {
        alert(res?.error || 'Failed to save comment edits.');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = '💾 Save Changes';
      }
    } catch (err) {
      alert("Couldn't reach server. Please try again.");
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes';
    }
  });

  btns.append(cancelBtn, saveBtn);
  footer.append(counter, btns);
  editBox.append(textarea, footer);

  textEl.after(editBox);
  textarea.focus();
}

function updateCommentFormVisibility(session) {
  const form = document.getElementById('comment-form');
  const alreadyWrap = document.getElementById('comment-already-wrap');
  const alreadyMsg = document.getElementById('comment-already');
  const editTodayBtn = document.getElementById('edit-today-comment-btn');
  const deleteTodayBtn = document.getElementById('delete-today-comment-btn');
  if (!form || !alreadyWrap) return;

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = 'Guests are in read-only mode — explore and enjoy!';
    if (editTodayBtn) editTodayBtn.hidden = true;
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  if (session && session.isAdmin) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = '🛡️ Admin Mode — You can moderate, edit, and delete squad comments directly on each comment card.';
    if (editTodayBtn) editTodayBtn.hidden = true;
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  const userComment = session && commentsCache.find(c => c.username === session.username);
  const hasCommented = Boolean(userComment);
  form.hidden = hasCommented;
  alreadyWrap.hidden = !hasCommented;

  if (hasCommented) {
    if (alreadyMsg) alreadyMsg.textContent = "You've shared your thoughts for today — see you back here tomorrow!";
    if (editTodayBtn) {
      editTodayBtn.hidden = false;
      editTodayBtn.disabled = false;
      editTodayBtn.onclick = () => {
        const cardEl = document.querySelector(`.comment-item[data-username="${CSS.escape(session.username)}"]`);
        if (cardEl && userComment) {
          startEditingComment(cardEl, userComment, session);
          cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }
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
      if (session && session.username) {
        mergePersistedReactions(commentsCache, 'comments', ddmmyy, session.username, REACTIONS.map(r => r.type));
      }
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
      if (session && session.username) {
        mergePersistedReactions(prayersCache, 'prayers', ddmmyy, session.username, PRAYER_REACTIONS_MAP.map(r => r.key));
      }
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
      chip.addEventListener('click', (e) => {
        togglePrayerReaction(prayer.username, reaction.key, session, e);
      });
    } else {
      chip.disabled = true;
    }

    reactionsRow.appendChild(chip);
  });

  item.append(head, text, reactionsRow);
  return item;
}

async function togglePrayerReaction(targetUsername, type, session, clickEvent) {
  if (!session || session.isGuest) {
    alert('Guest users are in read-only mode.');
    return;
  }
  const prayer = prayersCache.find(p => p.username === targetUsername);
  if (!prayer) return;

  const prayerReactionKeys = PRAYER_REACTIONS_MAP.map(r => r.key);
  if (!prayer.reactions) {
    prayer.reactions = {};
    prayerReactionKeys.forEach(k => { prayer.reactions[k] = []; });
  }

  const targetList = prayer.reactions[type] || [];
  const wasActive = targetList.includes(session.username);

  prayerReactionKeys.forEach(k => {
    if (!prayer.reactions[k]) prayer.reactions[k] = [];
    prayer.reactions[k] = prayer.reactions[k].filter(u => u !== session.username);
  });

  let newType = null;
  if (!wasActive) {
    prayer.reactions[type].push(session.username);
    newType = type;
    const matchObj = PRAYER_REACTIONS_MAP.find(r => r.key === type);
    if (matchObj) {
      spawnFloatingEmoji(clickEvent, matchObj.icon);
    }
  }

  const activeDate = activePrayersDate || formatDDMMYY(new Date());
  persistReaction('prayers', activeDate, session.username, targetUsername, newType);

  renderPrayers(session);

  try {
    const res = await apiGet({
      action: 'reactPrayer',
      reactorUsername: session.username,
      password: session.password,
      targetUsername: targetUsername,
      type: type,
      date: activeDate
    });
    if (res && res.success && res.reactions) {
      prayer.reactions = res.reactions;
      const serverActiveType = Object.keys(res.reactions).find(k => (res.reactions[k] || []).includes(session.username)) || null;
      persistReaction('prayers', activeDate, session.username, targetUsername, serverActiveType);
      renderPrayers(session);
    }
  } catch (err) {
    console.warn('Silent notice: Prayer reaction synced locally; backend sync notice:', err);
  }
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
  const editTodayBtn = document.getElementById('edit-today-prayer-btn');
  const deleteTodayBtn = document.getElementById('delete-today-prayer-btn');
  if (!form || !alreadyWrap) return;

  if (session && session.isGuest) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = 'Guests are in read-only mode — explore and pray for the squad! 🙏';
    if (editTodayBtn) editTodayBtn.hidden = true;
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  if (session && session.isAdmin) {
    form.hidden = true;
    alreadyWrap.hidden = false;
    if (alreadyMsg) alreadyMsg.textContent = '🛡️ Admin Mode — You can moderate, edit, and delete squad prayers directly on each prayer card.';
    if (editTodayBtn) editTodayBtn.hidden = true;
    if (deleteTodayBtn) deleteTodayBtn.hidden = true;
    return;
  }

  const userPrayer = session && prayersCache.find(p => p.username && p.username.toLowerCase() === session.username.toLowerCase());
  const hasPrayed = Boolean(userPrayer);
  form.hidden = hasPrayed;
  alreadyWrap.hidden = !hasPrayed;

  if (hasPrayed) {
    if (alreadyMsg) alreadyMsg.textContent = "You've shared your prayer for today — thank you for blessing the squad!";
    if (editTodayBtn) {
      editTodayBtn.hidden = false;
      editTodayBtn.disabled = false;
      editTodayBtn.onclick = () => {
        const cardEl = document.querySelector(`.prayer-card[data-username="${CSS.escape(session.username)}"]`);
        if (cardEl && userPrayer) {
          startEditingPrayer(cardEl, userPrayer, session);
          cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }
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

  const targetLower = String(targetUsername).toLowerCase();
  btnEl.disabled = true;
  btnEl.classList.add('nudged');
  btnEl.textContent = '⚡ Nudged!';
  nudgedTargetsToday.add(targetLower);

  const todayStr = formatDDMMYY(new Date());
  persistNudgedTarget(todayStr, curSession.username, targetLower);

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
    if (res && !res.success && res.error && !res.error.toLowerCase().includes('already')) {
      // Only revert if server explicitly rejected with non-duplicate error
      btnEl.textContent = '⚡ Nudge';
      btnEl.disabled = false;
      btnEl.classList.remove('nudged');
      nudgedTargetsToday.delete(targetLower);
      showNudgeToast(`Couldn't send nudge: ${res.error}`, true);
    }
  } catch (err) {
    // Keep button disabled/nudged locally even on network retry/timeout
    console.warn('Nudge request network notice:', err);
  }
}

// ====== SECTION 5: PROGRESS PLAYGROUND (INTERACTIVE ARENA) ======

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
const CIRCLE_MIN = 54;
const CIRCLE_MAX = 120;

function colorFor(username) {
  return USER_COLORS[username] || FALLBACK_COLOR;
}

function circleSizeFor(daysCompleted) {
  const fraction = Math.max(0, Math.min(1, daysCompleted / TOTAL_CHALLENGE_DAYS));
  return Math.round(CIRCLE_MIN + (CIRCLE_MAX - CIRCLE_MIN) * fraction);
}

const playgroundCircles = new Map();
let playgroundMode = 'free'; // 'free' | 'magnet' | 'orbit'
let playgroundTiltEnabled = false;
let playgroundChimesEnabled = true;
let playgroundTilt = { gx: 0, gy: 0 };
let playgroundMouse = { active: false, x: 0, y: 0 };
let playgroundOrbitPhase = 0;
let isPlaygroundLoopRunning = false;
let playgroundAnimId = null;
let isPlaygroundControlsBound = false;
let lastPgBumpTime = 0;
let activeBumpVoices = 0;

// Procedural Micro-Harmonics on Collisions
function playPlaygroundBumpHarmonic(massFraction, speed) {
  if (!playgroundChimesEnabled) return;
  try {
    const ctx = getProceduralAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastPgBumpTime < 0.05 || activeBumpVoices >= 3) return;
    if (speed < 1.3) return;

    lastPgBumpTime = now;
    activeBumpVoices++;

    const masterGain = ctx.createGain();
    const vol = Math.min(0.14, Math.max(0.02, (speed / 14) * 0.12));
    masterGain.gain.setValueAtTime(vol, now);
    masterGain.connect(ctx.destination);

    const PENTATONIC_SCALE = [
      146.83, 196.00, 220.00, 293.66, 369.99, 440.00, 493.88, 587.33, 739.99, 880.00
    ];
    const scaleIdx = Math.max(0, Math.min(PENTATONIC_SCALE.length - 1, Math.floor((1 - (massFraction || 0.5)) * (PENTATONIC_SCALE.length - 1))));
    const freq = PENTATONIC_SCALE[scaleIdx];

    playPluckedHarpString(ctx, masterGain, freq, now, 0.65, 0.11);
    setTimeout(() => {
      activeBumpVoices = Math.max(0, activeBumpVoices - 1);
    }, 650);
  } catch (err) {}
}

function initPlaygroundControls() {
  if (isPlaygroundControlsBound) return;
  isPlaygroundControlsBound = true;

  const container = document.getElementById('playground');
  const section = document.getElementById('section-playground');
  const sunEl = document.getElementById('playground-sun');
  const modeBtns = document.querySelectorAll('.pg-mode-btn');
  const tiltBtn = document.getElementById('pg-tilt-toggle');
  const audioBtn = document.getElementById('pg-audio-toggle');
  const popover = document.getElementById('playground-popover');
  const popoverClose = document.getElementById('pg-popover-close');

  // Arena Modes
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playgroundMode = btn.dataset.mode || 'free';

      if (container) {
        container.classList.remove('mode-free', 'mode-magnet', 'mode-orbit');
        container.classList.add(`mode-${playgroundMode}`);
      }
      if (sunEl) {
        sunEl.hidden = (playgroundMode !== 'orbit');
      }

      if (playgroundMode === 'orbit') {
        assignPlaygroundOrbitSlots(container);
      } else {
        // Nudge circles gently when entering free or magnet
        playgroundCircles.forEach(entry => {
          entry.vx = (Math.random() - 0.5) * 2;
          entry.vy = (Math.random() - 0.5) * 2;
        });
      }

      closePlaygroundPopover();
    });
  });

  // Tilt Gravity Toggle
  if (tiltBtn) {
    tiltBtn.addEventListener('click', async () => {
      if (!playgroundTiltEnabled) {
        // Request permission for iOS Safari if needed
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          try {
            const resp = await DeviceOrientationEvent.requestPermission();
            if (resp !== 'granted') {
              showNudgeToast('⚠️ Device orientation permission denied.', true);
              return;
            }
          } catch (e) {
            console.warn(e);
          }
        }
        playgroundTiltEnabled = true;
        tiltBtn.classList.add('active');
        const textEl = document.getElementById('pg-tilt-text');
        if (textEl) textEl.textContent = 'Tilt: ON';
        showNudgeToast('📱 Gyro Gravity active! Tilt your device to roll orbs.');
      } else {
        playgroundTiltEnabled = false;
        tiltBtn.classList.remove('active');
        const textEl = document.getElementById('pg-tilt-text');
        if (textEl) textEl.textContent = 'Tilt Gravity';
        playgroundTilt = { gx: 0, gy: 0 };
      }
    });
  }

  // Device orientation listener
  window.addEventListener('deviceorientation', (e) => {
    if (!playgroundTiltEnabled) return;
    const gamma = e.gamma || 0; // -90 to 90 (left to right)
    const beta = e.beta || 0;   // -180 to 180 (front to back)
    playgroundTilt.gx = Math.max(-1, Math.min(1, gamma / 32)) * 0.55;
    playgroundTilt.gy = Math.max(-1, Math.min(1, (beta - 42) / 32)) * 0.55;
  }, { passive: true });

  // Desktop Mouse Gravity
  if (container) {
    container.addEventListener('mousemove', (e) => {
      if (playgroundTiltEnabled) return;
      const rect = container.getBoundingClientRect();
      playgroundMouse.x = e.clientX - rect.left;
      playgroundMouse.y = e.clientY - rect.top;
      playgroundMouse.active = true;
    });
    container.addEventListener('mouseleave', () => {
      playgroundMouse.active = false;
    });
  }

  // Chimes Toggle
  if (audioBtn) {
    audioBtn.addEventListener('click', () => {
      playgroundChimesEnabled = !playgroundChimesEnabled;
      audioBtn.classList.toggle('active', playgroundChimesEnabled);
      const textEl = document.getElementById('pg-audio-text');
      const iconEl = document.getElementById('pg-audio-icon');
      if (textEl) textEl.textContent = playgroundChimesEnabled ? 'Chimes' : 'Muted';
      if (iconEl) iconEl.textContent = playgroundChimesEnabled ? '🔔' : '🔕';
    });
    audioBtn.classList.add('active');
  }

  // Popover close listener
  if (popoverClose) {
    popoverClose.addEventListener('click', closePlaygroundPopover);
  }

  document.addEventListener('pointerdown', (e) => {
    if (popover && !popover.hidden && !popover.contains(e.target) && !e.target.closest('.playground-circle')) {
      closePlaygroundPopover();
    }
  });

  // Pause simulation loop when offscreen
  if (section && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          startPlaygroundLoop();
        } else {
          stopPlaygroundLoop();
        }
      });
    }, { threshold: 0.05 });
    observer.observe(section);
  }
}

function closePlaygroundPopover() {
  const popover = document.getElementById('playground-popover');
  if (popover) popover.hidden = true;
}

function openPlaygroundPopover(entry, clientX, clientY) {
  const popover = document.getElementById('playground-popover');
  const container = document.getElementById('playground');
  if (!popover || !container) return;

  const row = entry.row;
  const session = getSession();
  const isMe = session && row.username && row.username.toLowerCase() === session.username.toLowerCase();

  const avatarEl = document.getElementById('pg-popover-avatar');
  const nameEl = document.getElementById('pg-popover-name');
  const tierEl = document.getElementById('pg-popover-tier');
  const daysEl = document.getElementById('pg-popover-days');
  const streakEl = document.getElementById('pg-popover-streak');
  const statusEl = document.getElementById('pg-popover-status');
  const actionBtn = document.getElementById('pg-popover-action-btn');

  if (avatarEl) {
    avatarEl.style.background = colorFor(row.username);
    avatarEl.textContent = (row.username || '?').charAt(0).toUpperCase();
  }
  if (nameEl) nameEl.textContent = row.username;

  const levelInfo = getLevelProgressInfo(row.daysCompleted || 0);
  if (tierEl) tierEl.textContent = levelInfo.currentLevelTitle || 'Disciple';

  if (daysEl) daysEl.textContent = `${row.daysCompleted || 0} / ${TOTAL_CHALLENGE_DAYS}d`;
  if (streakEl) streakEl.textContent = row.streak > 0 ? `🔥 ${row.streak}d streak` : 'No streak';
  if (statusEl) {
    statusEl.textContent = row.readToday ? '✓ Read Today' : '⏳ Pending';
    statusEl.style.color = row.readToday ? 'var(--accent-2, #10b981)' : 'var(--accent, #e8a93b)';
  }

  if (actionBtn) {
    if (isMe) {
      actionBtn.textContent = row.readToday ? '🏅 Inspect My Medallion' : '📖 Read Today\'s Portion';
      actionBtn.className = 'btn btn-primary btn-sm pg-action-btn';
      actionBtn.onclick = () => {
        closePlaygroundPopover();
        if (row.readToday) {
          if (window.openLevelMedallion) window.openLevelMedallion();
        } else {
          const portionEl = document.getElementById('today-portion-link') || document.querySelector('.today-portion-card');
          if (portionEl) portionEl.scrollIntoView({ behavior: 'smooth' });
        }
      };
    } else if (row.readToday) {
      actionBtn.textContent = '🙌 Cheer On!';
      actionBtn.className = 'btn btn-secondary btn-sm pg-action-btn';
      actionBtn.onclick = () => {
        showNudgeToast(`🙌 You cheered on ${row.username}! Keep shining!`);
        celebrateTier({ big: false, count: 2, emojis: ['🙌', '✨', '⭐'], colors: ['#E8A93B', '#6FAE8C', '#5B8DEF'] });
        closePlaygroundPopover();
      };
    } else {
      actionBtn.textContent = '⚡ Nudge to Read';
      actionBtn.className = 'btn btn-primary btn-sm pg-action-btn';
      actionBtn.onclick = async () => {
        actionBtn.disabled = true;
        actionBtn.textContent = 'Sending nudge…';
        try {
          if (typeof nudgeUser === 'function') {
            await nudgeUser(row.username);
          } else {
            showNudgeToast(`⚡ You nudged ${row.username} to read today!`);
          }
        } catch (e) {
          showNudgeToast(`⚡ You nudged ${row.username} to read today!`);
        }
        celebrateTier({ big: false, count: 2, emojis: ['⚡', '✨', '🔥'], colors: ['#FFD700', '#FFA500', '#5B8DEF'] });
        closePlaygroundPopover();
      };
    }
  }

  // Positioning
  const cRect = container.getBoundingClientRect();
  const popWidth = 270;
  const popHeight = 180;
  let posX = (entry.x + entry.size / 2) - (popWidth / 2);
  let posY = entry.y - popHeight - 12;

  if (posY < 8) posY = entry.y + entry.size + 12;
  posX = Math.max(8, Math.min(container.clientWidth - popWidth - 8, posX));
  posY = Math.max(8, Math.min(container.clientHeight - popHeight - 8, posY));

  popover.style.left = posX + 'px';
  popover.style.top = posY + 'px';
  popover.hidden = false;
}

function startPlaygroundLoop() {
  if (isPlaygroundLoopRunning) return;
  isPlaygroundLoopRunning = true;
  let lastTime = performance.now();

  function loop(currentTime) {
    if (!isPlaygroundLoopRunning) return;
    const dt = Math.min(32, currentTime - lastTime) / 16;
    lastTime = currentTime;

    updatePlaygroundPhysics(dt);
    playgroundAnimId = requestAnimationFrame(loop);
  }
  playgroundAnimId = requestAnimationFrame(loop);
}

function stopPlaygroundLoop() {
  isPlaygroundLoopRunning = false;
  if (playgroundAnimId) {
    cancelAnimationFrame(playgroundAnimId);
    playgroundAnimId = null;
  }
}

function assignPlaygroundOrbitSlots(container) {
  const entries = Array.from(playgroundCircles.values());
  if (!entries.length) return;

  const w = container ? (container.clientWidth || 360) : 360;
  const h = container ? (container.clientHeight || 380) : 380;

  // Sort by daysCompleted descending so top disciples occupy the inner honor sanctuary
  const sorted = [...entries].sort((a, b) => (b.row?.daysCompleted || 0) - (a.row?.daysCompleted || 0));
  const total = sorted.length;

  if (total <= 6) {
    // Single spacious circular orbit
    const R = Math.min(w * 0.36, h * 0.32);
    sorted.forEach((item, idx) => {
      item.orbitR = R;
      item.orbitAngle = (idx / total) * Math.PI * 2;
    });
  } else {
    // Two concentric non-intersecting rings
    // Inner Honor Ring (top 4 readers)
    const innerCount = Math.min(4, Math.ceil(total / 2));
    const outerCount = total - innerCount;
    const innerR = Math.min(w, h) * 0.22; // ~84px
    const outerR = Math.min(w, h) * 0.38; // ~144px

    sorted.forEach((item, idx) => {
      if (idx < innerCount) {
        item.orbitR = innerR;
        item.orbitAngle = (idx / innerCount) * Math.PI * 2;
      } else {
        const outerIdx = idx - innerCount;
        // Staggered by half step so outer disciples orbit safely between inner disciples
        const stagger = Math.PI / outerCount;
        item.orbitR = outerR;
        item.orbitAngle = (outerIdx / outerCount) * Math.PI * 2 + stagger;
      }
    });
  }
}

function updatePlaygroundPhysics(dt) {
  const container = document.getElementById('playground');
  if (!container) return;

  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w < 50 || h < 50) return;

  const entries = Array.from(playgroundCircles.values());

  // =========================================================================
  // 1. CELESTIAL ORBIT MODE
  // Orbs follow smooth, circular paths around the central Word cross.
  // In this mode, orbs NEVER touch each other and DO NOT bounce off each other.
  // =========================================================================
  if (playgroundMode === 'orbit') {
    playgroundOrbitPhase += 0.005 * dt; // Serene 21-second celestial revolution
    const cx = w * 0.5;
    const cy = h * 0.5;

    entries.forEach(item => {
      if (item.isDragging) return;

      const angle = (item.orbitAngle || 0) + playgroundOrbitPhase;
      const targetR = item.orbitR || (Math.min(w, h) * 0.30);
      const targetX = cx + targetR * Math.cos(angle) - item.radius;
      const targetY = cy + targetR * Math.sin(angle) - item.radius;

      // Smooth critically-damped spring toward exact circular slot
      const lerpFactor = Math.min(1, 0.08 * dt);
      item.x += (targetX - item.x) * lerpFactor;
      item.y += (targetY - item.y) * lerpFactor;
      item.vx = 0;
      item.vy = 0;
    });

    // Subpixel render for orbit mode
    entries.forEach(item => {
      const maxX = Math.max(0, w - item.size);
      const maxY = Math.max(0, h - item.size);
      if (!Number.isFinite(item.x)) item.x = maxX / 2;
      if (!Number.isFinite(item.y)) item.y = maxY / 2;
      item.x = Math.max(0, Math.min(maxX, item.x));
      item.y = Math.max(0, Math.min(maxY, item.y));
      item.el.style.transform = `translate3d(${item.x.toFixed(2)}px, ${item.y.toFixed(2)}px, 0)`;
    });

    return; // Completely bypass collision and bounce in orbit mode!
  }

  // =========================================================================
  // 2. FREE FLOAT & SQUAD MAGNET MODES
  // Smooth, cushioned physics where orbs never rebound or move away too fast.
  // =========================================================================
  const wallRestitution = 0.45;
  const orbRestitution = 0.48;
  const friction = 0.955;
  const maxSpeed = 5.0; // Strictly capped to prevent fast darting / jerky bouncing

  // Force Integration & Movement
  entries.forEach(item => {
    if (item.isDragging) return;

    // Apply arena mode forces
    if (playgroundMode === 'magnet') {
      const isBoy = BOY_USERS.includes((item.username || '').toLowerCase());
      const targetX = isBoy ? w * 0.22 : w * 0.78;
      const targetY = h * 0.50;
      const dx = targetX - (item.x + item.radius);
      const dy = targetY - (item.y + item.radius);
      item.vx += dx * 0.0025 * dt;
      item.vy += dy * 0.0025 * dt;
    }

    // Apply tilt or mouse gravity
    if (playgroundTiltEnabled) {
      item.vx += playgroundTilt.gx * 0.75 * dt;
      item.vy += playgroundTilt.gy * 0.75 * dt;
    } else if (playgroundMouse.active && playgroundMode === 'free') {
      const dx = playgroundMouse.x - (item.x + item.radius);
      const dy = playgroundMouse.y - (item.y + item.radius);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 30 && dist < 220) {
        item.vx += (dx / dist) * 0.14 * dt;
        item.vy += (dy / dist) * 0.14 * dt;
      }
    }

    // Natural friction damping
    item.vx *= Math.pow(friction, dt);
    item.vy *= Math.pow(friction, dt);

    // Speed cap to keep motion calm and smooth
    const speed = Math.sqrt(item.vx * item.vx + item.vy * item.vy);
    if (speed > maxSpeed) {
      item.vx = (item.vx / speed) * maxSpeed;
      item.vy = (item.vy / speed) * maxSpeed;
    }

    // Step position
    item.x += item.vx * dt;
    item.y += item.vy * dt;

    // Smooth cushioned wall collisions (rebound velocity capped at 3.2px/frame)
    const maxX = Math.max(0, w - item.size);
    const maxY = Math.max(0, h - item.size);

    let hitWall = false;
    let hitSpeed = 0;

    if (item.x <= 0) {
      item.x = 0;
      hitSpeed = Math.abs(item.vx);
      item.vx = Math.min(hitSpeed * wallRestitution, 3.2);
      hitWall = true;
    } else if (item.x >= maxX) {
      item.x = maxX;
      hitSpeed = Math.abs(item.vx);
      item.vx = -Math.min(hitSpeed * wallRestitution, 3.2);
      hitWall = true;
    }

    if (item.y <= 0) {
      item.y = 0;
      hitSpeed = Math.max(hitSpeed, Math.abs(item.vy));
      item.vy = Math.min(Math.abs(item.vy) * wallRestitution, 3.2);
      hitWall = true;
    } else if (item.y >= maxY) {
      item.y = maxY;
      hitSpeed = Math.max(hitSpeed, Math.abs(item.vy));
      item.vy = -Math.min(Math.abs(item.vy) * wallRestitution, 3.2);
      hitWall = true;
    }

    if (hitWall && hitSpeed > 2.0) {
      item.el.classList.remove('squash');
      void item.el.offsetWidth;
      item.el.classList.add('squash');
      playPlaygroundBumpHarmonic(item.massFraction, hitSpeed);
    }
  });

  // Circle-to-Circle Elastic Collisions (Smooth & non-explosive)
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];

      let dx = (b.x + b.radius) - (a.x + a.radius);
      let dy = (b.y + b.radius) - (a.y + a.radius);
      let dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.radius + b.radius;

      if (dist < minDist) {
        if (dist < 0.001) {
          dx = (Math.random() - 0.5) * 2 || 1;
          dy = (Math.random() - 0.5) * 2 || 1;
          dist = Math.sqrt(dx * dx + dy * dy);
        }

        // Overlap separation with soft cushioning factor
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        const totalMass = a.mass + b.mass;
        const aShare = b.mass / totalMass;
        const bShare = a.mass / totalMass;
        const sepDamp = 0.85;

        if (!a.isDragging && !b.isDragging) {
          a.x -= nx * overlap * aShare * sepDamp;
          a.y -= ny * overlap * aShare * sepDamp;
          b.x += nx * overlap * bShare * sepDamp;
          b.y += ny * overlap * bShare * sepDamp;
        } else if (a.isDragging && !b.isDragging) {
          b.x += nx * overlap * sepDamp;
          b.y += ny * overlap * sepDamp;
        } else if (!a.isDragging && b.isDragging) {
          a.x -= nx * overlap * sepDamp;
          a.y -= ny * overlap * sepDamp;
        }

        // Relative velocity along normal
        const rvx = a.vx - b.vx;
        const rvy = a.vy - b.vy;
        const velAlongNormal = rvx * nx + rvy * ny;

        // Positive velAlongNormal means circles are approaching each other
        if (velAlongNormal > 0) {
          // Cushioned impulse strictly capped so orbs never move away too fast
          const rawImpulse = -(1 + orbRestitution) * velAlongNormal / (1 / a.mass + 1 / b.mass);
          const maxImpulse = 3.6;
          const impulse = Math.max(-maxImpulse, Math.min(maxImpulse, rawImpulse));

          if (!a.isDragging) {
            a.vx += (impulse / a.mass) * nx;
            a.vy += (impulse / a.mass) * ny;
            const spdA = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
            if (spdA > 4.0) {
              a.vx = (a.vx / spdA) * 4.0;
              a.vy = (a.vy / spdA) * 4.0;
            }
          }
          if (!b.isDragging) {
            b.vx -= (impulse / b.mass) * nx;
            b.vy -= (impulse / b.mass) * ny;
            const spdB = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (spdB > 4.0) {
              b.vx = (b.vx / spdB) * 4.0;
              b.vy = (b.vy / spdB) * 4.0;
            }
          }

          if (velAlongNormal > 1.8) {
            a.el.classList.remove('squash');
            b.el.classList.remove('squash');
            void a.el.offsetWidth;
            a.el.classList.add('squash');
            b.el.classList.add('squash');
            playPlaygroundBumpHarmonic((a.massFraction + b.massFraction) / 2, velAlongNormal);
          }
        }
      }
    }
  }

  // Coordinate Sanitization, Clamping & Subpixel Rendering
  entries.forEach(item => {
    const maxX = Math.max(0, w - item.size);
    const maxY = Math.max(0, h - item.size);

    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
      item.x = maxX / 2;
      item.y = maxY / 2;
      item.vx = 0;
      item.vy = 0;
    }
    if (!Number.isFinite(item.vx)) item.vx = 0;
    if (!Number.isFinite(item.vy)) item.vy = 0;

    item.x = Math.max(0, Math.min(maxX, item.x));
    item.y = Math.max(0, Math.min(maxY, item.y));

    item.el.style.transform = `translate3d(${item.x.toFixed(2)}px, ${item.y.toFixed(2)}px, 0)`;
  });
}

function renderPlayground(rows) {
  const container = document.getElementById('playground');
  if (!container || !rows || !rows.length) return;

  initPlaygroundControls();

  const session = getSession();
  const maxDays = Math.max(...rows.map(r => r.daysCompleted || 0));

  // Sort rows to assign balanced orbit rings
  const sorted = [...rows].sort((a, b) => (b.daysCompleted || 0) - (a.daysCompleted || 0));

  sorted.forEach((row, i) => {
    const size = circleSizeFor(row.daysCompleted || 0);
    const radius = size / 2;
    const massFraction = Math.max(0, Math.min(1, (row.daysCompleted || 0) / TOTAL_CHALLENGE_DAYS));
    const mass = 1 + massFraction * 2.5;

    let entry = playgroundCircles.get(row.username);

    if (!entry) {
      const el = document.createElement('div');
      el.className = 'playground-circle';
      el.style.background = colorFor(row.username);
      el.style.width = size + 'px';
      el.style.height = size + 'px';

      const isMe = session && row.username && session.username && (row.username.toLowerCase() === session.username.toLowerCase());
      const isLeader = maxDays > 0 && (row.daysCompleted === maxDays);
      const hasStreak = (row.streak || 0) >= 3;
      const isHotStreak = (row.streak || 0) >= 5;
      const hasReadToday = !!row.readToday;

      let innerContent = '';
      if (isLeader) {
        innerContent += '<span class="leader-crown" title="Top Reader Crown">👑</span>';
      }
      innerContent += `<span class="circle-name">${escapeHtml(row.username)}</span>`;
      innerContent += `<span class="circle-days">${row.daysCompleted || 0}</span>`;
      if (isMe) {
        innerContent += '<span class="you-badge">YOU</span>';
      }
      el.innerHTML = innerContent;

      if (isMe) el.classList.add('you-marker');
      if (isHotStreak) el.classList.add('streak-hot-aura');
      else if (hasStreak) el.classList.add('streak-flame-aura');
      if (hasReadToday) el.classList.add('read-today-aura');

      const pos = initialPlaygroundPosition(container, i, rows.length, size);
      el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;

      // Assigned celestial orbit radius and speed
      const ringIndex = i % 4;
      const minR = Math.min(container.clientWidth || 360, container.clientHeight || 380) * 0.18;
      const maxR = Math.min(container.clientWidth || 360, container.clientHeight || 380) * 0.42;
      const orbitRadius = minR + (ringIndex / 3) * (maxR - minR);
      const orbitSpeed = (1.4 + (i % 3) * 0.4) * (i % 2 === 0 ? 1 : -1);

      entry = {
        id: row.username,
        username: row.username,
        row: row,
        el: el,
        x: pos.x,
        y: pos.y,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        size: size,
        radius: radius,
        mass: mass,
        massFraction: massFraction,
        isDragging: false,
        orbitRadius: orbitRadius,
        orbitSpeed: orbitSpeed
      };

      el.addEventListener('animationend', (e) => {
        if (e.animationName === 'orbSquash') {
          el.classList.remove('squash');
        }
      });

      makeEnhancedDraggable(entry, container);
      container.appendChild(el);
      playgroundCircles.set(row.username, entry);
    } else {
      entry.row = row;
      entry.size = size;
      entry.radius = radius;
      entry.mass = mass;
      entry.massFraction = massFraction;
      entry.el.style.width = size + 'px';
      entry.el.style.height = size + 'px';

      const daysEl = entry.el.querySelector('.circle-days');
      if (daysEl) daysEl.textContent = row.daysCompleted || 0;

      // Update aura classes
      const isLeader = maxDays > 0 && (row.daysCompleted === maxDays);
      const hasStreak = (row.streak || 0) >= 3;
      const isHotStreak = (row.streak || 0) >= 5;
      const hasReadToday = !!row.readToday;

      entry.el.classList.toggle('streak-hot-aura', isHotStreak);
      entry.el.classList.toggle('streak-flame-aura', hasStreak && !isHotStreak);
      entry.el.classList.toggle('read-today-aura', hasReadToday);

      const crownEl = entry.el.querySelector('.leader-crown');
      if (isLeader && !crownEl) {
        const crown = document.createElement('span');
        crown.className = 'leader-crown';
        crown.textContent = '👑';
        entry.el.prepend(crown);
      } else if (!isLeader && crownEl) {
        crownEl.remove();
      }
    }
  });

  assignPlaygroundOrbitSlots(container);
  startPlaygroundLoop();
}

function initialPlaygroundPosition(container, index, total, size) {
  const w = container.clientWidth || 320;
  const h = container.clientHeight || 380;
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

function makeEnhancedDraggable(entry, container) {
  const el = entry.el;
  let downX = 0, downY = 0, downTime = 0;
  let prevX = 0, prevY = 0, prevTime = 0;

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    entry.isDragging = true;
    entry.vx = 0;
    entry.vy = 0;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);

    downX = e.clientX;
    downY = e.clientY;
    downTime = performance.now();

    prevX = e.clientX;
    prevY = e.clientY;
    prevTime = downTime;
  });

  el.addEventListener('pointermove', (e) => {
    if (!entry.isDragging) return;

    const now = performance.now();
    const dt = Math.max(8, now - prevTime);

    // Compute rolling pointer velocity
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    entry.vx = (dx / dt) * 8;
    entry.vy = (dy / dt) * 8;

    prevX = e.clientX;
    prevY = e.clientY;
    prevTime = now;

    // Follow pointer directly
    const rect = container.getBoundingClientRect();
    const curX = e.clientX - rect.left - entry.radius;
    const curY = e.clientY - rect.top - entry.radius;

    entry.x = Math.max(0, Math.min(container.clientWidth - entry.size, curX));
    entry.y = Math.max(0, Math.min(container.clientHeight - entry.size, curY));

    el.style.transform = `translate3d(${entry.x.toFixed(2)}px, ${entry.y.toFixed(2)}px, 0)`;
  });

  const onPointerUp = (e) => {
    if (!entry.isDragging) return;
    entry.isDragging = false;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }

    const upTime = performance.now();
    const totalDist = Math.sqrt(Math.pow(e.clientX - downX, 2) + Math.pow(e.clientY - downY, 2));
    const duration = upTime - downTime;

    // Tap vs Drag threshold
    if (totalDist < 8 && duration < 320) {
      entry.vx = 0;
      entry.vy = 0;
      openPlaygroundPopover(entry, e.clientX, e.clientY);
    } else {
      // Gentle, controlled fling momentum
      const flingSpeed = Math.sqrt(entry.vx * entry.vx + entry.vy * entry.vy);
      const maxFling = 4.2;
      if (flingSpeed > maxFling) {
        entry.vx = (entry.vx / flingSpeed) * maxFling;
        entry.vy = (entry.vy / flingSpeed) * maxFling;
      }
      closePlaygroundPopover();
    }
  };

  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
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

let isScriptureReaderInitialized = false;

function closeReaderModal() {
  const modal = document.getElementById('reader-modal');
  const backdrop = document.getElementById('reader-modal-backdrop');
  if (!modal || !backdrop) return;
  stopAudioPlayback();
  modal.classList.remove('active');
  backdrop.classList.remove('active');
  if (window.ambientCelestialBg && typeof window.ambientCelestialBg.resume === 'function') {
    window.ambientCelestialBg.resume('reader');
  }
  setTimeout(() => {
    modal.hidden = true;
    backdrop.hidden = true;
  }, 380);
}

function initScriptureReader(session) {
  const modal = document.getElementById('reader-modal');
  const backdrop = document.getElementById('reader-modal-backdrop');
  const closeBtn = document.getElementById('close-reader-btn');
  const versionSelect = document.getElementById('bible-version-select');
  const fontDecBtn = document.getElementById('reader-font-decrease');
  const fontIncBtn = document.getElementById('reader-font-increase');
  const markReadBtn = document.getElementById('reader-mark-read-btn');
  const openTodayBtn = document.getElementById('open-today-reader-btn');

  if (closeBtn) closeBtn.onclick = closeReaderModal;
  if (backdrop) backdrop.onclick = closeReaderModal;

  if (isScriptureReaderInitialized) return;
  isScriptureReaderInitialized = true;

  if (versionSelect) {
    versionSelect.value = activeReaderVersion;
    versionSelect.addEventListener('change', (e) => {
      activeReaderVersion = e.target.value;
      localStorage.setItem('bible_reader_version', activeReaderVersion);
      const extLink = document.getElementById('reader-external-link');
      if (extLink && activeReaderPortion) {
        const bgQuery = encodeURIComponent(activeReaderPortion.replace(/[–—]/g, '-'));
        extLink.href = `https://www.biblegateway.com/passage/?search=${bgQuery}&version=${activeReaderVersion}`;
      }
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      closeReaderModal();
    }
  });

  if (markReadBtn) {
    markReadBtn.addEventListener('click', async () => {
      const curSession = session || getSession();
      if (!curSession || curSession.isGuest) {
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

const BOLLS_VERSION_MAP = {
  'CSB': 'CSB17',
  'HIN': 'HIOV',
  'AFR': 'AFR53'
};

async function fetchChapterFromApi(version, bookId, chapter) {
  const cacheKey = `${version}_${bookId}_${chapter}`;
  if (readerChapterCache[cacheKey]) {
    return readerChapterCache[cacheKey];
  }

  if (version === 'TIB') {
    const bookObj = BIBLE_BOOKS.find(b => b.id === bookId);
    const bookName = bookObj ? bookObj.name : '';
    if (bookName) {
      try {
        const query = encodeURIComponent(`${bookName} ${chapter}`);
        const res = await fetch(`https://api.biblesupersearch.com/api?bible=bo_ntb&reference=${query}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const versesObj = data?.results?.[0]?.verses?.bo_ntb?.[chapter] || data?.results?.[0]?.verses?.bo_ntb?.[String(chapter)];
        if (versesObj && typeof versesObj === 'object') {
          const verses = Object.entries(versesObj)
            .map(([vNum, vData]) => ({
              pk: (vData && vData.id) || parseInt(vNum, 10),
              verse: parseInt(vNum, 10),
              text: (vData && vData.text) || ''
            }))
            .sort((a, b) => a.verse - b.verse);

          if (verses.length > 0) {
            readerChapterCache[cacheKey] = verses;
            return verses;
          }
        }
        throw new Error('Empty Tibetan chapter response');
      } catch (tibErr) {
        console.warn('Tibetan Bible fetch error, falling back to WEB:', tibErr);
        try {
          const fallbackRes = await fetch(`https://bolls.life/get-chapter/WEB/${bookId}/${chapter}/`);
          if (fallbackRes.ok) {
            const fbData = await fallbackRes.json();
            if (Array.isArray(fbData) && fbData.length > 0) return fbData;
          }
        } catch (e) {}
        throw tibErr;
      }
    }
  }

  const apiVersion = BOLLS_VERSION_MAP[version] || version;

  try {
    const res = await fetch(`https://bolls.life/get-chapter/${encodeURIComponent(apiVersion)}/${bookId}/${chapter}/`);
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
  initScriptureReader();
  const modal = document.getElementById('reader-modal');
  const backdrop = document.getElementById('reader-modal-backdrop');
  const closeBtn = document.getElementById('close-reader-btn');
  if (closeBtn) closeBtn.onclick = closeReaderModal;
  if (backdrop) backdrop.onclick = closeReaderModal;
  const titleEl = document.getElementById('reader-portion-title');
  const dayBadge = document.getElementById('reader-day-badge');
  const extLink = document.getElementById('reader-external-link');
  const markReadBtn = document.getElementById('reader-mark-read-btn');

  if (!modal || !backdrop) return;

  // Always load the last opened bible version, else default to 'NIV'
  const savedVersion = localStorage.getItem('bible_reader_version');
  activeReaderVersion = savedVersion || 'NIV';

  const versionSelect = document.getElementById('bible-version-select');
  if (versionSelect) {
    versionSelect.value = activeReaderVersion;
    // If the saved version is unrecognized in select options, fallback to NIV
    if (!versionSelect.value) {
      activeReaderVersion = 'NIV';
      versionSelect.value = 'NIV';
    }
  }

  activeReaderPortion = portion;
  activeReaderDay = day;

  if (titleEl) titleEl.textContent = portion || "Today's Reading";
  if (dayBadge) {
    dayBadge.textContent = day ? `Day ${day}` : 'Reading';
    dayBadge.hidden = !day;
  }

  if (extLink) {
    const bgQuery = encodeURIComponent((portion || '').replace(/[–—]/g, '-'));
    extLink.href = `https://www.biblegateway.com/passage/?search=${bgQuery}&version=${activeReaderVersion}`;
  }

  if (markReadBtn) {
    const curSession = getSession();
    if (!curSession || curSession.isGuest) {
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
  if (window.ambientCelestialBg && typeof window.ambientCelestialBg.pause === 'function') {
    window.ambientCelestialBg.pause('reader');
  }
  requestAnimationFrame(() => {
    modal.classList.add('active');
    backdrop.classList.add('active');
    if (typeof playScrollUnfurlHarp === 'function') {
      playScrollUnfurlHarp();
    }
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
        if (targetEl && contentContainer) {
          const containerRect = contentContainer.getBoundingClientRect();
          const targetRect = targetEl.getBoundingClientRect();
          contentContainer.scrollTop += (targetRect.top - containerRect.top);
        }
        playAudioFromChapter(ch.bookId, ch.chapter);
      });
      tabsContainer.appendChild(tab);
    });
  }

  contentContainer.innerHTML = `
    <div class="reader-loading-state">
      <div class="reader-spinner"></div>
      <p>Loading ${escapeHtml(portionText)} (${escapeHtml(version)})…</p>
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
          const cleanText = String(v.text || '')
            .replace(/^[¶\s]+/, '')
            .replace(/<sup\b[^>]*>.*?<\/sup>/gi, '')
            .replace(/<s\b[^>]*>.*?<\/s>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const sup = document.createElement('sup');
          sup.className = 'verse-num';
          sup.textContent = v.verse;
          const textSpan = document.createElement('span');
          textSpan.className = 'verse-text';
          textSpan.textContent = cleanText;
          row.append(sup, textSpan, document.createTextNode(' '));
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
        if (targetEl && contentContainer) {
          const containerRect = contentContainer.getBoundingClientRect();
          const targetRect = targetEl.getBoundingClientRect();
          contentContainer.scrollTop += (targetRect.top - containerRect.top);
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
  if (keyVerseText) {
    keyVerseText.textContent = `"${kv.text}"`;
    keyVerseText.setAttribute('data-raw-verse', `"${kv.text}"`);
    if (window._livingInkHasRevealedOnce && typeof triggerLivingInkVerseReveal === 'function') {
      triggerLivingInkVerseReveal(keyVerseText, keyVerseRef, true);
    } else if (typeof primeLivingInkVerse === 'function') {
      primeLivingInkVerse(keyVerseText, keyVerseRef);
    }
  }
  if (keyVerseRef) {
    keyVerseRef.textContent = `— ${kv.ref}`;
  }

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

  // Render 3D Verse Flip Card & Youth TL;DR Bite
  renderVerseFlipCard(portionText, dayNum);

  // Initialize Daily Micro-Trivia / Flash Quiz
  initDailyQuiz(portionText, dayNum);
}

// ====== 3D VERSE FLIP CARD & INSTAGRAM STORY COPY ======

const YOUTH_PORTION_TLDR_BITES = {
  1: "God speaks light into darkness and creates a breathtaking world, crafting you in His divine image with immense purpose.",
  2: "God establishes His covenant with Abraham, proving that even when we can't see the full path, His promises never fail.",
  3: "Through trials and betrayal, Joseph stays faithful—reminding us that what was meant to harm us, God turns for good.",
  4: "God calls Moses at the burning bush, declaring 'I AM WHO I AM'—reminding us that God qualifies who He calls.",
  5: "The Red Sea parts as God fights for His people: when you face a wall, stand firm and watch God make a way.",
  6: "God gives the Ten Commandments: loving God wholeheartedly and loving your neighbors as yourself.",
  7: "Consecrate yourselves and be holy: God desires a pure, dedicated generation to carry His light.",
  8: "The priestly blessing: 'The Lord bless you and keep you; make His face shine on you and give you peace.'",
  9: "Be strong and courageous: God promises to go before you and will never leave you nor forsake you.",
  10: "Joshua takes the promised land: As for me and my household, we will serve the Lord with boldness.",
  11: "God raises up Gideon and Deborah: He uses ordinary, willing youth to shatter giant obstacles.",
  12: "Ruth's fierce loyalty: Walking in relentless love and discovering God's providential restoration.",
  13: "Samuel hears God's voice in the quiet: 'Speak Lord, for your servant is listening.'",
  14: "David faces Goliath with a sling and unshakable faith: The battle belongs to the Lord!",
  15: "David's heart after God: Even in sorrow and brokenness, true worship is built on humble repentance."
};

function getTldrForPortion(portionText, dayNum) {
  if (dayNum && YOUTH_PORTION_TLDR_BITES[dayNum]) {
    return YOUTH_PORTION_TLDR_BITES[dayNum];
  }
  const parsed = parsePassage(portionText);
  if (parsed.isCatchUp) {
    return "Take time to rest, breathe, and catch up on previous readings. God's grace is fresh every morning!";
  }
  if (parsed.chapters && parsed.chapters.length > 0) {
    const book = parsed.chapters[0].bookName;
    return `Immerse yourself in ${book}—discovering God's faithful character and His living truth for our generation today.`;
  }
  return "God's living Word speaks directly into your story today. Meditate on it day and night.";
}

function syncVerseFlipCardHeight() {
  const container = document.getElementById('flip-card-container');
  if (!container) return;
  const inner = document.getElementById('flip-card-inner');
  const front = container.querySelector('.flip-card-front');
  const back = container.querySelector('.flip-card-back');
  if (!front || !back || !inner) return;

  requestAnimationFrame(() => {
    container.style.minHeight = '';
    inner.style.minHeight = '';
    const hFront = front.scrollHeight || 0;
    const hBack = back.scrollHeight || 0;
    const needed = Math.max(hFront, hBack, 190);
    container.style.minHeight = `${needed}px`;
    inner.style.minHeight = `${needed}px`;
  });
}

let isFlipCardWired = false;

function renderVerseFlipCard(portionText, dayNum) {
  const container = document.getElementById('flip-card-container');
  const tldrEl = document.getElementById('flip-card-tldr-text');
  const verseTextEl = document.getElementById('flip-card-verse-text');
  const verseRefEl = document.getElementById('flip-card-verse-ref');
  const toggleBtn = document.getElementById('flip-card-toggle-btn');
  const igCopyBtn = document.getElementById('copy-ig-story-btn');

  if (!container || !tldrEl || !verseTextEl || !verseRefEl) return;

  const tldr = getTldrForPortion(portionText, dayNum);
  const kv = getKeyVerseForPortion(portionText, dayNum);

  tldrEl.textContent = `"${tldr}"`;
  verseTextEl.textContent = `"${kv.text}"`;
  verseRefEl.textContent = `— ${kv.ref}`;

  syncVerseFlipCardHeight();

  const toggleFlip = () => {
    container.classList.toggle('is-flipped');
    const isFlipped = container.classList.contains('is-flipped');
    container.setAttribute('aria-expanded', isFlipped ? 'true' : 'false');
  };

  if (!isFlipCardWired) {
    window.addEventListener('resize', syncVerseFlipCardHeight);

    container.addEventListener('click', (e) => {
      // Don't flip if clicking the copy button
      if (e.target.closest('#copy-ig-story-btn')) return;
      toggleFlip();
    });

    container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleFlip();
      }
    });

    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFlip();
      });
    }

    if (igCopyBtn) {
      igCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const curKv = getKeyVerseForPortion(portionText, currentDayNum);
        const dayLabel = currentDayNum ? `DAY ${currentDayNum}` : 'BIBLE 92';
        const igText = `📖 ${dayLabel} · BIBLE IN 92 DAYS ✨\n\n"${curKv.text}"\n— ${curKv.ref}\n\n🔥 Reading with @tg.youth_\n#BibleIn92Days #YouthGathering2026`;

        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(igText);
          } else {
            const ta = document.createElement('textarea');
            ta.value = igText;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          igCopyBtn.classList.add('copied');
          igCopyBtn.innerHTML = '<span>✓ Copied to Clipboard!</span>';
          setTimeout(() => {
            igCopyBtn.classList.remove('copied');
            igCopyBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              <span>Copy for Instagram Story</span>
            `;
          }, 2500);
        } catch (err) {
          alert('Could not copy automatically. You can copy the verse text directly!');
        }
      });
    }

    isFlipCardWired = true;
  }
}

// ====== DAILY MICRO-TRIVIA / FLASH QUIZ ======

const DAILY_BIBLE_QUIZ_BANK = {
  "1": {
    "question": "In Genesis 1, on which day of Creation did God create light?",
    "options": [
      "Day 1",
      "Day 3",
      "Day 4",
      "Day 7"
    ],
    "correctIndex": 0,
    "verse": "Genesis 1:3",
    "explanation": "God said, 'Let there be light,' and there was light on the very first day!"
  },
  "2": {
    "question": "What sign did God place in the sky as a covenant promise never to flood the earth again?",
    "options": [
      "A shooting star",
      "A rainbow",
      "A solar eclipse",
      "A pillar of cloud"
    ],
    "correctIndex": 1,
    "verse": "Genesis 9:13",
    "explanation": "God placed His rainbow in the clouds as a sign of His everlasting covenant."
  },
  "3": {
    "question": "What special gift did Jacob give to his beloved son Joseph?",
    "options": [
      "A golden signet ring",
      "A silver harp",
      "An ornate coat of many colors",
      "A shepherd's staff"
    ],
    "correctIndex": 2,
    "verse": "Genesis 37:3",
    "explanation": "Jacob loved Joseph more than any of his other sons and gave him a richly ornamented coat."
  },
  "4": {
    "question": "Through what miraculous sight did God first speak to Moses in Midian?",
    "options": [
      "A roaring thunderstorm",
      "A bush that burned without being consumed",
      "An angel in a chariot",
      "A stone tablet"
    ],
    "correctIndex": 1,
    "verse": "Exodus 3:2",
    "explanation": "The angel of the Lord appeared to Moses in flames of fire from within a bush that did not burn up."
  },
  "5": {
    "question": "What food did God rain down from heaven each morning for the Israelites in the wilderness?",
    "options": [
      "Manna",
      "Figs",
      "Unleavened bread",
      "Pomegranates"
    ],
    "correctIndex": 0,
    "verse": "Exodus 16:15",
    "explanation": "God provided manna, a sweet flake-like bread from heaven that sustained them for 40 years."
  },
  "6": {
    "question": "On which mountain did Moses receive the Ten Commandments from God?",
    "options": [
      "Mount Carmel",
      "Mount Sinai (Horeb)",
      "Mount Nebo",
      "Mount Zion"
    ],
    "correctIndex": 1,
    "verse": "Exodus 19:20",
    "explanation": "The Lord descended upon the top of Mount Sinai and called Moses to meet Him."
  },
  "7": {
    "question": "What did the high priest wear on the breastplate representing the 12 tribes of Israel?",
    "options": [
      "12 precious gemstones",
      "12 golden bells",
      "12 olive branches",
      "12 silver chains"
    ],
    "correctIndex": 0,
    "verse": "Exodus 28:21",
    "explanation": "There were 12 stones on Aaron's breastplate, each engraved like a seal with the name of one of the 12 tribes."
  },
  "8": {
    "question": "Which tribe of Israel was set apart specifically to serve in the Tabernacle and the priesthood?",
    "options": [
      "Judah",
      "Benjamin",
      "Levi",
      "Dan"
    ],
    "correctIndex": 2,
    "verse": "Numbers 3:6",
    "explanation": "The tribe of Levi was dedicated to God to assist Aaron and care for the sacred Tabernacle."
  },
  "9": {
    "question": "How many spies did Moses send out to explore the Promised Land of Canaan?",
    "options": [
      "7",
      "10",
      "12",
      "70"
    ],
    "correctIndex": 2,
    "verse": "Numbers 13:1–2",
    "explanation": "Moses sent 12 leaders, one from each ancestral tribe of Israel, to explore Canaan."
  },
  "10": {
    "question": "Which two faithful spies declared that with the Lord's help, Israel could take the land?",
    "options": [
      "Joshua and Caleb",
      "Aaron and Hur",
      "Gideon and Samson",
      "Moses and Eleazar"
    ],
    "correctIndex": 0,
    "verse": "Numbers 14:6–9",
    "explanation": "Joshua and Caleb urged the people: 'The Lord is with us. Do not be afraid of them!'"
  },
  "11": {
    "question": "What miraculous event in Numbers 17 confirmed Aaron's divine appointment as high priest?",
    "options": [
      "Aaron's wooden staff blossomed and produced ripe almonds overnight",
      "Water flowed from his priestly garments",
      "A column of fire rested exclusively on his tent",
      "A golden crown descended from heaven"
    ],
    "correctIndex": 0,
    "verse": "Numbers 17:8",
    "explanation": "Aaron's staff miraculously sprouted, budded, blossomed, and produced almonds, settling his priesthood permanently."
  },
  "12": {
    "question": "Whom did the Lord commission before the high priest Eleazar to succeed Moses as Israel's leader?",
    "options": [
      "Phinehas",
      "Caleb son of Jephunneh",
      "Joshua son of Nun",
      "Gershom"
    ],
    "correctIndex": 2,
    "verse": "Numbers 27:18–22",
    "explanation": "Moses laid his hands on Joshua, a man in whom is the Spirit, commissioning him before the whole congregation."
  },
  "13": {
    "question": "What foundational declaration of monotheism and love for God is commanded in Deuteronomy 6:4–5?",
    "options": [
      "The Shema ('Hear, O Israel: The LORD our God, the LORD is one')",
      "The Beatitudes",
      "The Aaronic Blessing",
      "The Song of Moses"
    ],
    "correctIndex": 0,
    "verse": "Deuteronomy 6:4–5",
    "explanation": "The Shema declares: 'Hear, O Israel: The LORD our God, the LORD is one. Love the LORD your God with all your heart, soul, and strength.'"
  },
  "14": {
    "question": "In Deuteronomy 18, what future deliverer did Moses prophesy that God would raise up from among their brothers?",
    "options": [
      "A world-conquering monarch",
      "A Prophet like Moses whom they must listen to",
      "An angelic army general",
      "A wealthy merchant king"
    ],
    "correctIndex": 1,
    "verse": "Deuteronomy 18:15",
    "explanation": "Moses prophesied that God would raise up a prophet like him, pointing directly to Jesus Christ."
  },
  "15": {
    "question": "By what divine strategy did the massive fortified walls of Jericho collapse in Joshua 6?",
    "options": [
      "Battering rams breaking the iron gates",
      "Marching around the city for 7 days, blowing ram's horns, and shouting",
      "A sudden earthquake at midnight",
      "Sapping beneath the city foundations"
    ],
    "correctIndex": 1,
    "verse": "Joshua 6:20",
    "explanation": "When the trumpets sounded and the army shouted with a great shout, the wall fell down flat by faith!"
  },
  "16": {
    "question": "During Joshua's battle at Gibeon against the Amorites, what unprecedented miracle occurred in the heavens?",
    "options": [
      "The sun and moon stood still in the sky for about a full day",
      "A solar eclipse turned day into pitch black night",
      "A shower of falling stars destroyed the enemy camps",
      "Lightning burned the enemy chariots"
    ],
    "correctIndex": 0,
    "verse": "Joshua 10:12–14",
    "explanation": "Joshua cried out in the sight of Israel, and the sun stopped in the middle of the sky and delayed going down about a full day."
  },
  "17": {
    "question": "What famous declaration of family dedication did Joshua give in his farewell address in Joshua 24?",
    "options": [
      "'As for me and my household, we will serve the LORD'",
      "'Peace be within your walls and prosperity in your palaces'",
      "'Do not be afraid, stand firm and see salvation'",
      "'Great is your faithfulness O Lord'"
    ],
    "correctIndex": 0,
    "verse": "Joshua 24:15",
    "explanation": "Joshua challenged the nation, concluding: 'Choose this day whom you will serve... But as for me and my household, we will serve the LORD.'"
  },
  "18": {
    "question": "What loyal covenant vow did Ruth profess to Naomi when urged to stay in Moab?",
    "options": [
      "'Where you go I will go; your people will be my people and your God my God'",
      "'I will build a dwelling in Bethlehem on my own'",
      "'Provide me with my portion of the inheritance'",
      "'I shall return to the temple of Chemosh'"
    ],
    "correctIndex": 0,
    "verse": "Ruth 1:16–17",
    "explanation": "Ruth's steadfast devotion brought her into the lineage of King David and Jesus Christ."
  },
  "19": {
    "question": "How did the young boy Samuel respond when the Lord called his name three times at Shiloh?",
    "options": [
      "'Here I am, Eli, for you called me'",
      "'Speak, LORD, for your servant is listening'",
      "'Depart from me, for I am only a youth'",
      "'Who speaks to me in the dark?'"
    ],
    "correctIndex": 1,
    "verse": "1 Samuel 3:9–10",
    "explanation": "Taught by the priest Eli, Samuel answered: 'Speak, LORD, for your servant is listening.'"
  },
  "20": {
    "question": "What weapon and confidence did young David use to strike down the Philistine champion Goliath?",
    "options": [
      "Saul's royal sword and bronze helmet",
      "A shepherd's sling and a single smooth stone in the Name of the LORD",
      "An iron spear from Bethlehem",
      "A flaming arrow fired from the hillside"
    ],
    "correctIndex": 1,
    "verse": "1 Samuel 17:45–50",
    "explanation": "David declared that the battle is the LORD's, defeating Goliath with a single sling stone."
  },
  "21": {
    "question": "How did King David celebrate when the Ark of God was successfully brought into Jerusalem in 2 Samuel 6?",
    "options": [
      "He sat silently on a golden royal chariot",
      "He danced before the LORD with all his might wearing a linen ephod",
      "He declared thirty days of national fasting",
      "He hid the Ark in a mountain cave"
    ],
    "correctIndex": 1,
    "verse": "2 Samuel 6:14",
    "explanation": "David rejoiced with exuberant worship, leaping and dancing before the Lord with all his might."
  },
  "22": {
    "question": "What eternal covenant promise did God make to David through the prophet Nathan in 2 Samuel 7?",
    "options": [
      "David would never suffer physical illness",
      "David's royal throne and kingdom would be established forever",
      "David would personally construct the stone temple",
      "Israel would never have another king"
    ],
    "correctIndex": 1,
    "verse": "2 Samuel 7:16",
    "explanation": "God promised: 'Your house and your kingdom will endure forever before me; your throne will be established forever'—fulfilled in the Messiah Jesus!"
  },
  "23": {
    "question": "When God appeared to young King Solomon in a dream at Gibeon, what did Solomon ask for?",
    "options": [
      "Limitless gold and long life",
      "The defeat of all his political adversaries",
      "A discerning heart / wisdom to govern God's people",
      "Dominion over the kingdoms of Egypt and Assyria"
    ],
    "correctIndex": 2,
    "verse": "1 Kings 3:9–10",
    "explanation": "Solomon asked for wisdom and understanding to lead God's great people, which pleased the Lord greatly."
  },
  "24": {
    "question": "On Mount Carmel, how did the LORD answer Elijah's prayer to prove that He alone is God in 1 Kings 18?",
    "options": [
      "A gentle breeze passed over the mountain",
      "Fire fell from heaven and consumed the sacrifice, wood, stones, and water",
      "An earthquake split the altar in two",
      "A sudden torrential rain extinguished the pagan altars"
    ],
    "correctIndex": 1,
    "verse": "1 Kings 18:38",
    "explanation": "The fire of the LORD fell and consumed the burnt offering, the wood, the stones, and the dust, licking up the water in the trench."
  },
  "25": {
    "question": "How was the prophet Elijah miraculously taken up to heaven in 2 Kings 2?",
    "options": [
      "He died of old age on Mount Carmel",
      "A chariot of fire and horses of fire appeared, and he went up in a whirlwind",
      "He was carried across the Jordan by angels",
      "He vanished inside the holy place"
    ],
    "correctIndex": 1,
    "verse": "2 Kings 2:11",
    "explanation": "As Elijah and Elisha walked, a chariot of fire and horses of fire separated them, and Elijah ascended in a whirlwind."
  },
  "26": {
    "question": "Which godly young king of Judah wept, tore his robes, and sparked national revival when the Book of the Law was found?",
    "options": [
      "Josiah",
      "Manasseh",
      "Ahaz",
      "Rehoboam"
    ],
    "correctIndex": 0,
    "verse": "2 Kings 22:11–13",
    "explanation": "King Josiah had a tender and humble heart, turning to the Lord with all his soul when God's Law was read to him."
  },
  "27": {
    "question": "In 1 Chronicles 4:10, what was the earnest petition of Jabez that God granted?",
    "options": [
      "'Oh, that you would bless me and enlarge my territory! Let your hand be with me, and keep me from harm'",
      "'Make my name feared across all nations'",
      "'Grant me a royal palace of cedar'",
      "'Give me victory over the Philistines'"
    ],
    "correctIndex": 0,
    "verse": "1 Chronicles 4:10",
    "explanation": "Jabez cried out to the God of Israel for blessing, enlargement, and protection—and God granted his request."
  },
  "28": {
    "question": "Whom did King David appoint to lead continual musical praise and thanksgiving before the Ark of the Covenant in 1 Chronicles 16?",
    "options": [
      "Asaph and his fellow Levites",
      "Joab the commander of the army",
      "Hiram King of Tyre",
      "The elders of Gilead"
    ],
    "correctIndex": 0,
    "verse": "1 Chronicles 16:4–7",
    "explanation": "David appointed Asaph and his brethren to minister before the Ark regularly with cymbals, harps, and songs of praise."
  },
  "29": {
    "question": "What dramatic sign accompanied the dedication of Solomon's Temple in 2 Chronicles 7?",
    "options": [
      "Fire came down from heaven and consumed the offerings, and the glory of the LORD filled the temple",
      "A dense fog hid the city for seven days",
      "The bronze pillars sang aloud",
      "The Jordan river flowed backwards"
    ],
    "correctIndex": 0,
    "verse": "2 Chronicles 7:1–2",
    "explanation": "Fire came down from heaven and the glory of the LORD filled the temple so intensely that the priests could not enter."
  },
  "30": {
    "question": "When facing a vast confederation of enemies in 2 Chronicles 20, what did King Jehoshaphat position at the head of the army?",
    "options": [
      "His heaviest iron chariots",
      "Singers appointed to praise the beauty of God's holiness",
      "Foreign archers from Damascus",
      "Spies bearing peace treaties"
    ],
    "correctIndex": 1,
    "verse": "2 Chronicles 20:21–22",
    "explanation": "As the worshipers sang: 'Give thanks to the LORD, for His love endures forever,' the Lord ambushed and defeated the invaders!"
  },
  "31": {
    "question": "What famous imperial decree by King Cyrus of Persia at the end of 2 Chronicles fulfilled Jeremiah's prophecy?",
    "options": [
      "A decree allowing the exiled Jews to return to Jerusalem and rebuild the House of the LORD",
      "A decree making Persian pagan gods mandatory",
      "A decree forbidding all travel across the Euphrates",
      "A decree destroying Jerusalem's foundations"
    ],
    "correctIndex": 0,
    "verse": "2 Chronicles 36:22–23",
    "explanation": "Cyrus proclaimed that God appointed him to build a temple in Jerusalem, authorizing the exiles to return."
  },
  "32": {
    "question": "According to Ezra 7:10, what threefold commitment defined Ezra's life and ministry?",
    "options": [
      "To study the Law of the LORD, to practice it, and to teach its statutes in Israel",
      "To conquer neighboring lands, build fortresses, and collect gold",
      "To negotiate trade routes with Persia",
      "To administer legal trials in Susa"
    ],
    "correctIndex": 0,
    "verse": "Ezra 7:10",
    "explanation": "Ezra set his heart to study the Law of the LORD, to do it, and to teach His statutes and ordinances in Israel."
  },
  "33": {
    "question": "In how many days did Nehemiah and the people miraculously finish rebuilding Jerusalem's broken walls?",
    "options": [
      "7 days",
      "52 days",
      "100 days",
      "3 years"
    ],
    "correctIndex": 1,
    "verse": "Nehemiah 6:15",
    "explanation": "The wall was completed in 52 days, convincing surrounding nations that this work had been accomplished with God's help."
  },
  "34": {
    "question": "What penetrating question did Mordecai challenge Queen Esther with in Esther 4?",
    "options": [
      "'And who knows but that you have come to your royal position for such a time as this?'",
      "'Why have you forgotten your family in the palace?'",
      "'Can anyone challenge the decree of Haman?'",
      "'Will the king grant you half his treasures?'"
    ],
    "correctIndex": 0,
    "verse": "Esther 4:14",
    "explanation": "Mordecai reminded Esther that God had placed her on the throne 'for such a time as this' to deliver His people."
  },
  "35": {
    "question": "In the depths of his grief, what unwavering declaration of faith did Job speak in Job 19:25?",
    "options": [
      "'I know that my Redeemer lives, and that in the end He will stand on the earth'",
      "'There is no purpose under heaven'",
      "'God has forgotten me in my suffering'",
      "'My friends speak the truth about my sins'"
    ],
    "correctIndex": 0,
    "verse": "Job 19:25",
    "explanation": "Job looked beyond his earthly pain with prophetic assurance: 'I know that my Redeemer lives!'"
  },
  "36": {
    "question": "In Job 28:28, what does God declare to mankind regarding true wisdom and understanding?",
    "options": [
      "'The fear of the Lord—that is wisdom, and to shun evil is understanding'",
      "'Wisdom is found in the deepest silver mines'",
      "'Understanding belongs only to the angels'",
      "'Wisdom is gained by accumulating worldly power'"
    ],
    "correctIndex": 0,
    "verse": "Job 28:28",
    "explanation": "God declared that true wisdom is rooted in holy reverence for Him, and understanding is turning away from evil."
  },
  "37": {
    "question": "How did the LORD conclude Job's story after Job prayed for his companions in Job 42?",
    "options": [
      "God rebuked Job and left him in poverty",
      "God restored Job's fortunes and gave him twice as much as he had before",
      "Job remained in exile away from his family",
      "Job passed away immediately without seeing his children"
    ],
    "correctIndex": 1,
    "verse": "Job 42:10–12",
    "explanation": "The Lord blessed the latter half of Job's life even more than the beginning, giving him double of all he had lost."
  },
  "38": {
    "question": "In Psalm 46:1, what comforting assurance is given to every believer facing chaos or trouble?",
    "options": [
      "'God is our refuge and strength, an ever-present help in trouble'",
      "'We must rely solely on our own inner resilience'",
      "'Trouble is a sign that God has departed'",
      "'Only kings receive divine protection'"
    ],
    "correctIndex": 0,
    "verse": "Psalm 46:1",
    "explanation": "Psalm 46:1 assures us that God is our shelter and fortress, always close at hand whenever we face distress."
  },
  "39": {
    "question": "What heartfelt prayer of inner spiritual renewal did David pray in Psalm 51:10?",
    "options": [
      "'Create in me a pure heart, O God, and renew a steadfast spirit within me'",
      "'Destroy all my adversaries with fire'",
      "'Give me more gold than King Saul'",
      "'Make me the ruler of all surrounding nations'"
    ],
    "correctIndex": 0,
    "verse": "Psalm 51:10",
    "explanation": "David prayed for deep inward cleansing: 'Create in me a pure heart, O God, and renew a steadfast spirit within me.'"
  },
  "40": {
    "question": "What instruction for life guidance is given in Proverbs 3:5–6?",
    "options": [
      "'Trust in the LORD with all your heart and lean not on your own understanding; in all your ways submit to Him, and He will make your paths straight'",
      "'Follow your own feelings wherever they lead'",
      "'Depend first on human wisdom before praying'",
      "'Keep your plans hidden from God'"
    ],
    "correctIndex": 0,
    "verse": "Proverbs 3:5–6",
    "explanation": "Proverbs 3 calls for wholehearted reliance on God, promising that He will direct and straighten our paths."
  },
  "41": {
    "question": "What divine shelter is promised in Psalm 91:1 to those who seek intimacy with God?",
    "options": [
      "'Whoever dwells in the shelter of the Most High will rest in the shadow of the Almighty'",
      "'They will never encounter any opposition on earth'",
      "'They will gain automatic entry into royal palaces'",
      "'They will receive physical invincibility from all toil'"
    ],
    "correctIndex": 0,
    "verse": "Psalm 91:1",
    "explanation": "Those who dwell in secret communion with the Most High find unbroken peace under the shadow of the Almighty."
  },
  "42": {
    "question": "According to Psalm 103:12, how completely has God removed our sins from us?",
    "options": [
      "As far as the east is from the west",
      "Only a few paces away",
      "To the edge of the desert",
      "For a single generation"
    ],
    "correctIndex": 0,
    "verse": "Psalm 103:12",
    "explanation": "As far as the east is from the west—an immeasurable, infinite distance—so far has He removed our sins from us!"
  },
  "43": {
    "question": "Which psalm is the shortest chapter in the entire Bible, consisting of just two verses of praise?",
    "options": [
      "Psalm 23",
      "Psalm 117",
      "Psalm 119",
      "Psalm 150"
    ],
    "correctIndex": 1,
    "verse": "Psalm 117:1–2",
    "explanation": "Psalm 117 contains only two verses, calling all nations and peoples to extol the Lord for His enduring love and faithfulness."
  },
  "44": {
    "question": "In Psalm 119:105, how does the psalmist describe the practical guidance of God's Word?",
    "options": [
      "A heavy stone to carry",
      "A lamp to my feet and a light to my path",
      "A mystery that no one can fathom",
      "A seal for the priests only"
    ],
    "correctIndex": 1,
    "verse": "Psalm 119:105",
    "explanation": "God's living Word illuminates our immediate next step ('a lamp to my feet') and our future course ('a light to my path')."
  },
  "45": {
    "question": "Why does David express awe and praise regarding human creation in Psalm 139:14?",
    "options": [
      "'For I am fearfully and wonderfully made; marvelous are your works'",
      "'Because humans are the strongest animals'",
      "'Because our minds can master the universe'",
      "'Because we have dominion over the stars'"
    ],
    "correctIndex": 0,
    "verse": "Psalm 139:14",
    "explanation": "David rejoices in God's intimate craftsmanship: each person is fearfully, wonderfully, and intentionally fashioned by God."
  },
  "46": {
    "question": "With what glorious universal call to praise does the Book of Psalms conclude in Psalm 150:6?",
    "options": [
      "'Let everything that has breath praise the LORD. Praise the LORD!'",
      "'May peace remain in Jerusalem forever'",
      "'The prayers of David the son of Jesse are ended'",
      "'Let the earth be silent before Him'"
    ],
    "correctIndex": 0,
    "verse": "Psalm 150:6",
    "explanation": "The entire Psalter reaches its soaring summit: 'Let everything that has breath praise the LORD!'"
  },
  "47": {
    "question": "According to Proverbs 16:3, what happens when you surrender your activities to the Lord?",
    "options": [
      "'Commit to the LORD whatever you do, and He will establish your plans'",
      "'You will never have to work again'",
      "'All men will praise your accomplishments'",
      "'You will immediately gain royal authority'"
    ],
    "correctIndex": 0,
    "verse": "Proverbs 16:3",
    "explanation": "When our endeavors are committed and entrusted to God's guidance, He aligns and establishes our purposes."
  },
  "48": {
    "question": "In Proverbs 31:30, what timeless truth contrasts fleeting outward appearance with godly character?",
    "options": [
      "'Charm is deceptive, and beauty is fleeting; but a woman who fears the LORD is to be praised'",
      "'Wealth covers all shortcomings'",
      "'Wisdom belongs only to elders'",
      "'Beauty will never fade if tended carefully'"
    ],
    "correctIndex": 0,
    "verse": "Proverbs 31:30",
    "explanation": "Physical beauty is transient, but a heart that reveres the Lord possesses enduring honor and praise."
  },
  "49": {
    "question": "What is the ultimate conclusion of life according to the Teacher in Ecclesiastes 12:13?",
    "options": [
      "'Fear God and keep His commandments, for this is the duty of all mankind'",
      "'Pursue pleasure and leave legacy to chance'",
      "'Accumulate wisdom and riches without restraint'",
      "'Withdraw into solitude away from society'"
    ],
    "correctIndex": 0,
    "verse": "Ecclesiastes 12:13",
    "explanation": "After exploring every earthly pursuit under the sun, the conclusion of the whole matter is to fear God and obey His Word."
  },
  "50": {
    "question": "In Isaiah 6, when Isaiah saw the holy presence of God and heard 'Whom shall I send?', how did he answer?",
    "options": [
      "'Send someone with greater eloquence'",
      "'Here am I. Send me!'",
      "'Wait until I have completed my duties'",
      "'I am terrified and cannot go'"
    ],
    "correctIndex": 1,
    "verse": "Isaiah 6:8",
    "explanation": "Cleansed by the coal from the altar, Isaiah surrendered willingly: 'Here am I. Send me!'"
  },
  "51": {
    "question": "What wonderful promise of peace does Isaiah 26:3 declare to the faithful?",
    "options": [
      "'You will keep in perfect peace those whose minds are steadfast, because they trust in you'",
      "'Peace is only attainable through military dominance'",
      "'Peace will arrive only after all trials cease'",
      "'Those who seek wealth shall find inner peace'"
    ],
    "correctIndex": 0,
    "verse": "Isaiah 26:3",
    "explanation": "God bestows perfect peace (shalom shalom) upon the soul that remains steadfastly fixed on Him in faith."
  },
  "52": {
    "question": "What extraordinary promise of renewed vitality is given in Isaiah 40:31?",
    "options": [
      "'Those who hope in the LORD will renew their strength. They will soar on wings like eagles; they will run and not grow weary'",
      "'They will become political leaders in Babylon'",
      "'They will never have to face another valley'",
      "'Their youth will remain unchanged forever'"
    ],
    "correctIndex": 0,
    "verse": "Isaiah 40:31",
    "explanation": "Those who wait patiently upon God exchange their human weakness for His divine strength, soaring like eagles."
  },
  "53": {
    "question": "In the renowned prophecy of the Suffering Servant in Isaiah 53:5, why was He pierced?",
    "options": [
      "For our transgressions, and crushed for our iniquities; by His wounds we are healed",
      "Because He committed crimes against the empire",
      "By misfortune and accident of history",
      "To satisfy the political leaders of Jerusalem"
    ],
    "correctIndex": 0,
    "verse": "Isaiah 53:5",
    "explanation": "Isaiah foresaw Jesus Christ bearing the penalty for our sins on the cross, purchasing our complete spiritual healing."
  },
  "54": {
    "question": "What divine commission did God declare to young Jeremiah in Jeremiah 1:5?",
    "options": [
      "'Before I formed you in the womb I knew you, before you were born I set you apart; I appointed you as a prophet to the nations'",
      "'Wait until you are an elder before speaking'",
      "'Study in the libraries of Babylon first'",
      "'You are too young to be of any service'"
    ],
    "correctIndex": 0,
    "verse": "Jeremiah 1:5",
    "explanation": "God revealed that Jeremiah was known, chosen, and consecrated for divine mission before his physical conception!"
  },
  "55": {
    "question": "According to Jeremiah 9:23–24, what is the only thing in which a human being should boast?",
    "options": [
      "In understanding and knowing the LORD, that He exercises kindness, justice, and righteousness on earth",
      "In wisdom, military power, and financial riches",
      "In ancestry and tribal connections",
      "In personal accomplishments and awards"
    ],
    "correctIndex": 0,
    "verse": "Jeremiah 9:24",
    "explanation": "Neither wisdom, might, nor riches merit boasting—our sole glory is knowing the character and loving heart of God."
  },
  "56": {
    "question": "In Jeremiah 18, what metaphor does God use to illustrate His absolute sovereignty over nations and individuals?",
    "options": [
      "A potter shaping pliable clay on the wheel",
      "A captain steering a ship through a gale",
      "A builder laying foundation stones",
      "A farmer threshing wheat"
    ],
    "correctIndex": 0,
    "verse": "Jeremiah 18:6",
    "explanation": "'Like clay in the hand of the potter, so are you in my hand, O house of Israel'—God shapes and reshapes us for His glory."
  },
  "57": {
    "question": "What comforting assurance of future hope did God deliver to the Jewish exiles in Jeremiah 29:11?",
    "options": [
      "'For I know the plans I have for you,' declares the LORD, 'plans to prosper you and not to harm you, plans to give you hope and a future'",
      "'You will never see Jerusalem restored'",
      "'Expect only judgment for your remaining days'",
      "'Seek your peace in foreign idols'"
    ],
    "correctIndex": 0,
    "verse": "Jeremiah 29:11",
    "explanation": "God assured His people that His sovereign thoughts toward them were plans of peace, hope, and an expected end."
  },
  "58": {
    "question": "In Jeremiah 31:31–33, what revolutionary covenant did God promise to establish with His people?",
    "options": [
      "A New Covenant written upon their hearts and minds, where He will be their God and forgive their sins",
      "A covenant etched upon heavier granite tablets",
      "A temporary peace treaty with Babylon",
      "A sacrificial system requiring thousands of bulls"
    ],
    "correctIndex": 0,
    "verse": "Jeremiah 31:33",
    "explanation": "God foretold the New Covenant, fulfilled through Jesus's blood, transforming our inner hearts through the Holy Spirit."
  },
  "59": {
    "question": "In Lamentations 3:22–23, what steadfast truth gives hope in the midst of profound grief?",
    "options": [
      "'The steadfast love of the LORD never ceases; his mercies never come to an end; they are new every morning; great is your faithfulness'",
      "'Time heals all sorrows naturally'",
      "'Human resilience will eventually triumph'",
      "'Sorrow is permanent in this world'"
    ],
    "correctIndex": 0,
    "verse": "Lamentations 3:22–23",
    "explanation": "Even amid the ruins of Jerusalem, Jeremiah clung to God's unfailing mercies, renewed fresh with every dawn."
  },
  "60": {
    "question": "What spiritual renewal does God promise in Ezekiel 36:26 to perform within His people?",
    "options": [
      "'I will give you a new heart and put a new spirit in you; I will remove from you your heart of stone and give you a heart of flesh'",
      "'I will give you golden crowns of victory'",
      "'I will make you invincible against foreign armies'",
      "'I will restore the old legal rituals'"
    ],
    "correctIndex": 0,
    "verse": "Ezekiel 36:26",
    "explanation": "God promises supernatural regeneration: removing stubborn, lifeless hearts of stone and replacing them with soft, responsive hearts of flesh."
  },
  "61": {
    "question": "In Ezekiel 34, how does God contrast His pastoral care with the corrupt shepherds who exploited Israel?",
    "options": [
      "The Sovereign LORD Himself will search for His lost sheep, rescue them from danger, and tend them with justice",
      "God will hire foreign caretakers to govern the flock",
      "God will leave the sheep to wander in the wilderness",
      "God will divide the flock and abandon them"
    ],
    "correctIndex": 0,
    "verse": "Ezekiel 34:11–16",
    "explanation": "God promised: 'I myself will search for my sheep and look after them... I will bind up the injured and strengthen the weak.'"
  },
  "62": {
    "question": "In Ezekiel 37, what astonishing vision of national and spiritual resurrection did Ezekiel behold?",
    "options": [
      "A valley of dry bones coming together, covered with flesh, and brought to life by the breath of God's Spirit",
      "A great cedar tree reaching into heaven",
      "Four chariots emerging from between bronze mountains",
      "A river of fire flowing from the throne"
    ],
    "correctIndex": 0,
    "verse": "Ezekiel 37:4–10",
    "explanation": "Ezekiel prophesied to the dry bones, and the breath of the Spirit entered them, raising a vast living army for God."
  },
  "63": {
    "question": "Why was Daniel completely unharmed when thrown into the den of lions in Daniel 6?",
    "options": [
      "God sent His angel and shut the lions' mouths, because Daniel was found blameless before Him",
      "Daniel fought the lions using an iron spear",
      "The lions were asleep throughout the night",
      "The king secretly fed the lions before lowering Daniel"
    ],
    "correctIndex": 0,
    "verse": "Daniel 6:22",
    "explanation": "Daniel walked out unscathed because he trusted in his God, who sent His angel to shut the hungry lions' mouths."
  },
  "64": {
    "question": "In Joel 2:28, what momentous outpouring of the Holy Spirit did the prophet announce for the last days?",
    "options": [
      "'I will pour out my Spirit on all people. Your sons and daughters will prophesy, your old men will dream dreams'",
      "'Only ordained priests will hear God's voice'",
      "'The Spirit will be withdrawn from the nations'",
      "'Prophecy will cease across the earth'"
    ],
    "correctIndex": 0,
    "verse": "Joel 2:28",
    "explanation": "Joel foretold the Pentecostal outpouring of the Holy Spirit upon all flesh, fulfilling God's promise to empower every believer."
  },
  "65": {
    "question": "What urgent prophetic standard for genuine social righteousness is proclaimed in Amos 5:24?",
    "options": [
      "'Let justice roll on like a river, righteousness like a never-failing stream!'",
      "'Offer double sacrifices on holy days'",
      "'Build taller walls around your cities'",
      "'Keep silent and avoid public courts'"
    ],
    "correctIndex": 0,
    "verse": "Amos 5:24",
    "explanation": "Amos declared that external religious rituals are worthless unless accompanied by justice and active righteousness."
  },
  "66": {
    "question": "According to Micah 6:8, what does the LORD require of every human being?",
    "options": [
      "To act justly, to love mercy, and to walk humbly with your God",
      "To bring thousands of rams and rivers of olive oil",
      "To conquer foreign territories in battle",
      "To isolate oneself from society"
    ],
    "correctIndex": 0,
    "verse": "Micah 6:8",
    "explanation": "Micah summarizes true discipleship: 'He has shown you, O mortal, what is good... To act justly and to love mercy and to walk humbly with your God.'"
  },
  "67": {
    "question": "What foundational declaration in Habakkuk 2:4 is quoted three times in the New Testament (Romans, Galatians, Hebrews)?",
    "options": [
      "'The righteous person will live by his faith'",
      "'Wealth brings lasting peace'",
      "'Wisdom belongs only to kings'",
      "'All striving ends in dust'"
    ],
    "correctIndex": 0,
    "verse": "Habakkuk 2:4",
    "explanation": "'The just shall live by his faith' became the foundational pillar of the Gospel and Christian justification by faith alone."
  },
  "68": {
    "question": "What powerful word of divine empowerment did the Lord give to Zerubbabel in Zechariah 4:6?",
    "options": [
      "'Not by might nor by power, but by my Spirit,' says the LORD Almighty",
      "'Through military strategy and foreign gold'",
      "'By the sheer willpower of human leaders'",
      "'By building insurmountable stone towers'"
    ],
    "correctIndex": 0,
    "verse": "Zechariah 4:6",
    "explanation": "God's work is accomplished not by human strength or resources, but by the supernatural power of the Holy Spirit!"
  },
  "69": {
    "question": "On the road to Emmaus in Luke 24, how did the risen Jesus cause the hearts of the two disciples to burn within them?",
    "options": [
      "He explained to them what was said in all the Scriptures concerning Himself",
      "He performed miraculous signs and wonders",
      "He gave them earthly riches",
      "He offered political advice"
    ],
    "correctIndex": 0,
    "verse": "Luke 24:27, 32",
    "explanation": "Jesus opened the Scriptures to them, revealing how the Law, Prophets, and Psalms all pointed directly to His death and resurrection."
  },
  "70": {
    "question": "In John 14:6, what exclusive declaration did Jesus make regarding the way to the Father?",
    "options": [
      "'I am the way and the truth and the life. No one comes to the Father except through me'",
      "'I am one of many paths to enlightenment'",
      "'Follow your own conscience and you will arrive'",
      "'All religions lead to the same destination'"
    ],
    "correctIndex": 0,
    "verse": "John 14:6",
    "explanation": "Jesus revealed that He is the singular, living mediator: the Way, the Truth, and the Life, through whom alone we know the Father."
  },
  "71": {
    "question": "In Acts 9, who was dramatically converted by a blinding encounter with the risen Jesus on the road to Damascus?",
    "options": [
      "Saul of Tarsus (the Apostle Paul)",
      "Cornelius the Roman centurion",
      "Nicodemus the Pharisee",
      "Barnabas of Cyprus"
    ],
    "correctIndex": 0,
    "verse": "Acts 9:3–6",
    "explanation": "Saul, once a fierce persecutor of the church, was stopped by Jesus's light and transformed into Christ's chosen apostle to the nations."
  },
  "72": {
    "question": "In Acts 28, what happened when Paul was shipwrecked on Malta and bitten by a venomous viper as he laid wood on the fire?",
    "options": [
      "He shook the snake off into the fire and suffered no ill effects",
      "He fell ill and needed weeks of medicine",
      "He had to jump into the sea to neutralize the venom",
      "The islanders locked him away in quarantine"
    ],
    "correctIndex": 0,
    "verse": "Acts 28:5",
    "explanation": "Paul shook off the snake into the fire without suffering harm, demonstrating Christ's supernatural protection over His ambassadors."
  },
  "73": {
    "question": "In Romans 8:38–39, what power or circumstance can separate the believer from the love of God in Christ Jesus?",
    "options": [
      "Neither death nor life, angels nor demons, present nor future, nor any other creature—nothing can separate us!",
      "Extreme persecution and economic distress",
      "Human doubts and past failures",
      "The rulers and authorities of this dark world"
    ],
    "correctIndex": 0,
    "verse": "Romans 8:38–39",
    "explanation": "Paul triumphantly proclaims that absolutely nothing in all creation can ever sever us from the covenant love of God in Christ Jesus!"
  },
  "74": {
    "question": "According to 1 Corinthians 13:13, what three virtues endure forever, and which of them is the greatest?",
    "options": [
      "Faith, hope, and love; but the greatest of these is love",
      "Wisdom, knowledge, and power; but the greatest is power",
      "Fastings, prayers, and alms; but the greatest is prayer",
      "Zeal, obedience, and sacrifice; but the greatest is sacrifice"
    ],
    "correctIndex": 0,
    "verse": "1 Corinthians 13:13",
    "explanation": "'And now these three remain: faith, hope and love. But the greatest of these is love'—because God Himself is love!"
  },
  "75": {
    "question": "What life-changing truth does 2 Corinthians 5:17 proclaim for anyone who is united with Christ?",
    "options": [
      "'Therefore, if anyone is in Christ, the new creation has come: The old has gone, the new is here!'",
      "'They must first earn righteousness through good deeds'",
      "'They will never experience earthly challenges again'",
      "'They retain their old identity alongside a religious label'"
    ],
    "correctIndex": 0,
    "verse": "2 Corinthians 5:17",
    "explanation": "In Christ, our old sinful identity is eradicated and we are made completely new creations by the Holy Spirit."
  },
  "76": {
    "question": "In Galatians 5:22–23, what are the nine Christlike virtues that comprise the fruit of the Holy Spirit?",
    "options": [
      "Love, joy, peace, patience, kindness, goodness, faithfulness, gentleness, and self-control",
      "Wealth, fame, influence, eloquence, pride, power, ambition, honor, and beauty",
      "Rules, traditions, fasts, rituals, sacrifices, debates, phylacteries, titles, and garments",
      "Visions, prophecies, tongues, signs, wonders, authority, dreams, healings, and miracles"
    ],
    "correctIndex": 0,
    "verse": "Galatians 5:22–23",
    "explanation": "The Holy Spirit reproduces Christ's very nature within us through these nine beautiful, interrelated spiritual fruits."
  },
  "77": {
    "question": "According to Philippians 4:6–7, how are believers instructed to handle anxiety and worry?",
    "options": [
      "Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God",
      "Worry until solutions emerge through human effort",
      "Suppress your emotions and tell no one",
      "Seek counsel only from secular philosophies"
    ],
    "correctIndex": 0,
    "verse": "Philippians 4:6–7",
    "explanation": "Paul commands us to turn every worry into thankful prayer, and God's transcendent peace will guard our hearts and minds."
  },
  "78": {
    "question": "In 1 Thessalonians 5:16–18, what threefold practice is declared as God's will for you in Christ Jesus?",
    "options": [
      "Rejoice always, pray continually, give thanks in all circumstances",
      "Complain during hardships, pray only on Sundays, fast occasionally",
      "Withdraw from the community, keep silent, avoid strangers",
      "Seek personal ambition, work without rest, trust your instincts"
    ],
    "correctIndex": 0,
    "verse": "1 Thessalonians 5:16–18",
    "explanation": "Unceasing joy, continual prayer, and gratitude in every circumstance reflect the heartbeat of a disciple walking in God's will."
  },
  "79": {
    "question": "In 2 Timothy 1:7, what spirit has God imparted to believers instead of a spirit of fear and timidity?",
    "options": [
      "A spirit of power, of love, and of a sound mind (self-discipline)",
      "A spirit of worldly caution and doubt",
      "A spirit of pride and aggression",
      "A spirit of isolation and passivity"
    ],
    "correctIndex": 0,
    "verse": "2 Timothy 1:7",
    "explanation": "God does not give us a timid spirit; He fills us with divine power, selfless love, and sober spiritual self-discipline."
  },
  "80": {
    "question": "How does Hebrews 11:1 define the biblical essence of genuine faith?",
    "options": [
      "Faith is confidence in what we hope for and assurance about what we do not see",
      "Faith is positive thinking detached from evidence",
      "Faith is an emotional feeling that comes and goes",
      "Faith is blindly accepting whatever humans teach"
    ],
    "correctIndex": 0,
    "verse": "Hebrews 11:1",
    "explanation": "Faith is the title deed of things hoped for, the rock-solid conviction of eternal realities beyond physical sight."
  },
  "81": {
    "question": "In 1 John 4:18, what divine reality drives out all tormenting fear from the believer's heart?",
    "options": [
      "Perfect love drives out fear, because fear has to do with punishment",
      "Human bravery and physical courage",
      "Ignoring the reality of danger",
      "Accumulating earthly wealth and security"
    ],
    "correctIndex": 0,
    "verse": "1 John 4:18",
    "explanation": "Understanding God's unconditional, perfect love frees our hearts from fear, dread, and condemnation."
  },
  "82": {
    "question": "In Revelation 3:20, what tender personal invitation does Jesus offer to every person?",
    "options": [
      "'Here I am! I stand at the door and knock. If anyone hears my voice and opens the door, I will come in and eat with that person, and they with me'",
      "'I knock only when you have achieved perfection'",
      "'Only priests and scholars may open the door'",
      "'The door to fellowship is closed until judgment day'"
    ],
    "correctIndex": 0,
    "verse": "Revelation 3:20",
    "explanation": "Jesus gently knocks at the door of our hearts, seeking close, intimate fellowship with whoever opens to Him."
  },
  "83": {
    "question": "In the breathtaking vision of the New Jerusalem in Revelation 21:4, what will God wipe away forever?",
    "options": [
      "Every tear from their eyes; there will be no more death or mourning or crying or pain",
      "Only the memories of their past sins",
      "The light of the stars and planets",
      "The physical foundations of the new earth"
    ],
    "correctIndex": 0,
    "verse": "Revelation 21:4",
    "explanation": "In eternal glory with Christ, grief, death, pain, and tears are completely abolished forever!"
  },
  "84": {
    "question": "What is the primary biblical purpose of a Sabbath and catch-up day in a disciple's spiritual rhythm?",
    "options": [
      "To rest in God's presence, reflect on His goodness, and renew spiritual and physical strength",
      "To waste time in idleness and spiritual neglect",
      "To avoid all fellowship and interaction with others",
      "To read secular entertainment books instead of Scripture"
    ],
    "correctIndex": 0,
    "verse": "Exodus 20:8–11; Mark 2:27",
    "explanation": "Sabbath rest is God's gift to replenish our souls, recenter our focus on Christ, and celebrate His ongoing grace."
  },
  "85": {
    "question": "How many total canonical books comprise the Holy Bible that we read through in 92 days?",
    "options": [
      "66 books (39 Old Testament and 27 New Testament)",
      "50 books (25 Old and 25 New)",
      "73 books in all translations",
      "100 books from Genesis to Revelation"
    ],
    "correctIndex": 0,
    "verse": "2 Timothy 3:16",
    "explanation": "The Christian canon contains 66 divinely inspired books—39 Old Testament and 27 New Testament—telling one unified story of redemption."
  },
  "86": {
    "question": "In the Great Commission (Matthew 28:19–20), what command did Jesus entrust to all His followers?",
    "options": [
      "'Go and make disciples of all nations, baptizing them and teaching them to obey everything I have commanded you'",
      "'Build private monuments and remain inside Jerusalem'",
      "'Impose the faith through worldly political power'",
      "'Wait silently for the end without sharing the Gospel'"
    ],
    "correctIndex": 0,
    "verse": "Matthew 28:19–20",
    "explanation": "Christ commands every disciple to actively share the Gospel, make disciples across all nations, and walk in His abiding presence."
  },
  "87": {
    "question": "According to Ephesians 6:14–17, what is the single offensive spiritual weapon in the Armor of God?",
    "options": [
      "The sword of the Spirit, which is the word of God",
      "The shield of faith",
      "The helmet of salvation",
      "The breastplate of righteousness"
    ],
    "correctIndex": 0,
    "verse": "Ephesians 6:17",
    "explanation": "The sword of the Spirit is the living, active Word of God—our essential weapon to overcome spiritual temptation and lies."
  },
  "88": {
    "question": "In the Lord's Prayer (Matthew 6:9–13), what petition teaches us daily dependence upon God's provision?",
    "options": [
      "'Give us this day our daily bread'",
      "'Grant us more wealth than our neighbors'",
      "'Protect our worldly treasures from decay'",
      "'Spare us from having to labor'"
    ],
    "correctIndex": 0,
    "verse": "Matthew 6:11",
    "explanation": "'Give us this day our daily bread' trains us to look to our Heavenly Father day by day for physical and spiritual sustenance."
  },
  "89": {
    "question": "In Romans 12:1–2, what does the Apostle Paul urge believers to present to God as spiritual worship?",
    "options": [
      "Our bodies as a living sacrifice, holy and pleasing to God, not conforming to this world but transformed by the renewing of our mind",
      "Extravagant financial donations only",
      "Animal sacrifices like the Old Testament temple",
      "Formal religious rituals performed once a year"
    ],
    "correctIndex": 0,
    "verse": "Romans 12:1–2",
    "explanation": "True worship is a surrendered life: presenting our whole self as a living sacrifice to be renewed and transformed by God."
  },
  "90": {
    "question": "When asked which commandment in the Law is the greatest in Matthew 22:37–40, how did Jesus reply?",
    "options": [
      "'Love the Lord your God with all your heart, soul, and mind; and love your neighbor as yourself'",
      "'Observe all ceremonial washings without fail'",
      "'Fast twice a week and tithe your herbs'",
      "'Keep all your traditions strictly separated from Gentiles'"
    ],
    "correctIndex": 0,
    "verse": "Matthew 22:37–40",
    "explanation": "Jesus declared that all the Law and the Prophets hang on these two great commandments: wholehearted love for God and love for our neighbor."
  },
  "91": {
    "question": "According to 1 John 1:7, what happens when we walk in the light as God is in the light?",
    "options": [
      "We have fellowship with one another, and the blood of Jesus His Son purifies us from all sin",
      "We become morally perfect and never sin again",
      "We will never face any criticism or opposition",
      "We no longer have need of God's forgiveness"
    ],
    "correctIndex": 0,
    "verse": "1 John 1:7",
    "explanation": "Walking in honest, transparent obedience with God fosters authentic Christian fellowship and continual cleansing through Christ's blood."
  },
  "92": {
    "question": "At the end of his apostolic race in 2 Timothy 4:7, what triumphant testimony did Paul declare?",
    "options": [
      "'I have fought the good fight, I have finished the race, I have kept the faith'",
      "'I regret that I sacrificed so much for the Gospel'",
      "'I wish I had accumulated more earthly security'",
      "'The race was too difficult to complete'"
    ],
    "correctIndex": 0,
    "verse": "2 Timothy 4:7",
    "explanation": "Paul celebrated a life wholly spent for Jesus: 'I have fought the good fight, I have finished the race, I have kept the faith. Now there is in store for me the crown of righteousness!'"
  }
};

function getDailyQuizForDay(portionText, dayNum) {
  const d = dayNum || (typeof currentDayNum !== 'undefined' ? currentDayNum : null);
  if (d && DAILY_BIBLE_QUIZ_BANK[d]) {
    return DAILY_BIBLE_QUIZ_BANK[d];
  }
  const parsed = parsePassage(portionText);
  const bookName = (parsed.chapters && parsed.chapters[0]) ? parsed.chapters[0].bookName : 'Scripture';
  return {
    question: "Which key spiritual discipline helps you carry the truth of " + bookName + " into your daily life?",
    options: [
      "Consistent prayer and meditating on God's Word",
      "Reading only when in trouble",
      "Keeping Scripture closed until Sunday",
      "Relying solely on your own wisdom"
    ],
    correctIndex: 0,
    verse: "Psalm 119:105",
    explanation: "Consistent prayer and meditation on God's Word illuminates our path and anchors our faith daily!"
  };
}

function initDailyQuiz(portionText, dayNum) {
  const quizCard = document.getElementById('daily-quiz-card');
  const questionEl = document.getElementById('quiz-question-text');
  const optionsGrid = document.getElementById('quiz-options-grid');
  const feedbackBox = document.getElementById('quiz-feedback-box');
  const feedbackMsg = document.getElementById('quiz-feedback-msg');
  const explanationEl = document.getElementById('quiz-explanation-text');
  const statusPill = document.getElementById('quiz-status-pill');

  if (!quizCard || !questionEl || !optionsGrid || !feedbackBox) return;

  const quiz = getDailyQuizForDay(portionText, dayNum);
  const todayStr = formatDDMMYY(new Date());
  const session = getSession();
  const uname = session ? session.username.toLowerCase() : 'guest';
  const solvedKey = `bible92_quiz_status_${todayStr}_${uname}`;
  const correctKey = `bible92_quiz_correct_${todayStr}_${uname}`;

  questionEl.textContent = quiz.question;
  optionsGrid.innerHTML = '';
  feedbackBox.hidden = true;

  const previousAnswer = localStorage.getItem(solvedKey);

  quiz.options.forEach((optText, optIdx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option-btn';
    const optLetter = document.createElement('span');
    optLetter.className = 'opt-letter';
    optLetter.textContent = `${String.fromCharCode(65 + optIdx)}. `;
    const optTextSpan = document.createElement('span');
    optTextSpan.textContent = optText;
    btn.append(optLetter, optTextSpan);

    if (previousAnswer !== null) {
      btn.disabled = true;
      const chosenIdx = parseInt(previousAnswer, 10);
      if (optIdx === quiz.correctIndex) {
        btn.classList.add('selected-correct');
      } else if (optIdx === chosenIdx) {
        btn.classList.add('selected-wrong');
      }
    } else {
      btn.addEventListener('click', () => {
        handleQuizSubmission(optIdx, quiz, todayStr, uname);
      });
    }

    optionsGrid.appendChild(btn);
  });

  if (previousAnswer !== null) {
    const isCorrect = localStorage.getItem(correctKey) === '1';
    statusPill.textContent = isCorrect ? '🌟 Solved · Scholar Awarded' : '✓ Completed';
    feedbackBox.hidden = false;
    feedbackMsg.className = 'quiz-feedback-msg ' + (isCorrect ? 'correct' : 'wrong');
    feedbackMsg.textContent = isCorrect ? '🎉 Correct! You unlocked the Scholar Crown!' : 'Keep digging in God\'s Word!';
    explanationEl.textContent = `${quiz.explanation} (${quiz.verse})`;
  } else {
    statusPill.textContent = '1 Question';
  }
}

function handleQuizSubmission(chosenIdx, quiz, todayStr, uname) {
  const solvedKey = `bible92_quiz_status_${todayStr}_${uname}`;
  const correctKey = `bible92_quiz_correct_${todayStr}_${uname}`;
  const isCorrect = chosenIdx === quiz.correctIndex;

  localStorage.setItem(solvedKey, String(chosenIdx));
  if (isCorrect) {
    localStorage.setItem(correctKey, '1');
    celebrate(false);
  }

  const feedbackBox = document.getElementById('quiz-feedback-box');
  const feedbackMsg = document.getElementById('quiz-feedback-msg');
  const explanationEl = document.getElementById('quiz-explanation-text');
  const statusPill = document.getElementById('quiz-status-pill');
  const optionsGrid = document.getElementById('quiz-options-grid');

  if (optionsGrid) {
    const buttons = optionsGrid.querySelectorAll('.quiz-option-btn');
    buttons.forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === quiz.correctIndex) {
        btn.classList.add('selected-correct');
      } else if (idx === chosenIdx) {
        btn.classList.add('selected-wrong');
      }
    });
  }

  if (statusPill) {
    statusPill.textContent = isCorrect ? '🌟 Solved · Scholar Awarded' : '✓ Completed';
  }

  if (feedbackBox && feedbackMsg && explanationEl) {
    feedbackBox.hidden = false;
    feedbackMsg.className = 'quiz-feedback-msg ' + (isCorrect ? 'correct' : 'wrong');
    feedbackMsg.textContent = isCorrect
      ? '🎉 Correct! You earned the 📜 Scholar badge on the leaderboard!'
      : `Almost! The correct answer is: ${quiz.options[quiz.correctIndex]}`;
    explanationEl.textContent = `${quiz.explanation} (${quiz.verse})`;
  }

  // Re-render leaderboard to immediately reflect the 📜 Scholar badge
  const curSession = getSession();
  if (currentLeaderboard && currentLeaderboard.length > 0) {
    renderLeaderboard(currentLeaderboard, curSession);
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
        currentEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    }, 150);
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

  const searchClearBtn = document.getElementById('sidebar-search-clear');
  const onSearchChange = (val) => {
    const q = val || '';
    if (searchClearBtn) {
      searchClearBtn.hidden = !q.trim();
    }
    filterSidebarPortions(q);
  };

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      onSearchChange(e.target.value);
    });
  }

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      onSearchChange('');
    });
  }
}

function buildScheduleItemSearchIndex(item) {
  const dNum = item.day !== undefined && item.day !== null ? String(item.day).trim() : '';
  const portionStr = item.portion ? String(item.portion).trim() : '';
  const dateStr = item.date ? String(item.date).trim() : '';

  let chaptersList = [];
  try {
    const parsed = parsePassage(portionStr);
    if (parsed && parsed.chapters && Array.isArray(parsed.chapters)) {
      parsed.chapters.forEach(c => {
        if (c.abbr) {
          chaptersList.push(c.abbr.toLowerCase());
          chaptersList.push(`${c.abbr.toLowerCase()} ${c.chapter}`);
          chaptersList.push(`${c.abbr.toLowerCase()}${c.chapter}`);
        }
        if (c.book) {
          chaptersList.push(c.book.toLowerCase());
          chaptersList.push(`${c.book.toLowerCase()} ${c.chapter}`);
        }
      });
    }
  } catch (e) {}

  const normPortion = portionStr.toLowerCase().replace(/[\u2013\u2014\u2212]/g, '-');
  const normDate = dateStr.toLowerCase().replace(/[\u2013\u2014\u2212]/g, '-');
  const compactPortion = normPortion.replace(/\s*([-\:\/\&])\s*/g, '$1');

  return {
    dayNum: Number(dNum),
    dayStr: dNum,
    portion: normPortion,
    compactPortion: compactPortion,
    date: normDate,
    chapters: chaptersList
  };
}

function matchesScheduleQuery(idx, rawQuery) {
  if (!rawQuery) return true;
  let q = rawQuery.trim().toLowerCase().replace(/[\u2013\u2014\u2212]/g, '-');
  if (!q) return true;

  // 1. Explicit day query: "day 1", "day 05", "d1", "d 5", "#25"
  const dayMatch = q.match(/^(?:day|d|#)\s*(\d+)$/);
  if (dayMatch) {
    const targetDay = parseInt(dayMatch[1], 10);
    return idx.dayNum === targetDay;
  }

  // 2. Compact query (remove spaces around hyphens/colons, e.g. "1 - 3" -> "1-3")
  const qCompact = q.replace(/\s*([-\:\/\&])\s*/g, '$1');

  // 3. Exact substring match in portion, compact portion, or date (handles partial symbols, letters, digits)
  if (idx.portion.includes(q) || idx.compactPortion.includes(qCompact) || idx.date.includes(q)) {
    return true;
  }

  // 4. Exact day number match
  if (idx.dayStr === q) {
    return true;
  }

  // 5. Check if query matches any chapter abbreviations/variations
  if (idx.chapters.some(c => c.includes(q) || c.includes(qCompact))) {
    return true;
  }

  // 6. Multi-token match: e.g. "1 Cor 15", "Aug 10", "Gen 1"
  const qSpaced = qCompact.replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2');
  const tokens = qSpaced.split(/\s+/).filter(Boolean);

  if (tokens.length > 1) {
    // Check if all tokens match within portion + chapters
    const portionAndChapters = [idx.portion, idx.compactPortion, ...idx.chapters].join(' ');
    const allPortion = tokens.every(tok => portionAndChapters.includes(tok));
    if (allPortion) return true;

    // Check if all tokens match within date
    const allDate = tokens.every(tok => idx.date.includes(tok));
    if (allDate) return true;
  }

  return false;
}

function renderReadingSidebar(portions) {
  allPortionsCache = portions || [];
  filterSidebarPortions('');
}

function filterSidebarPortions(query) {
  const listEl = document.getElementById('sidebar-portions-list');
  const countEl = document.getElementById('sidebar-search-count');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!allPortionsCache.length) {
    listEl.innerHTML = '<p class="sidebar-loading">No reading schedule available.</p>';
    if (countEl) countEl.hidden = true;
    return;
  }

  const qTrimmed = (query || '').trim();
  const filtered = allPortionsCache.filter(item => {
    if (!qTrimmed) return true;
    const indexItem = buildScheduleItemSearchIndex(item);
    return matchesScheduleQuery(indexItem, qTrimmed);
  });

  if (/^\d+$/.test(qTrimmed)) {
    const qNum = parseInt(qTrimmed, 10);

    const getPortionChapterMatch = (item) => {
      const parsed = parsePassage(item.portion);
      if (!parsed || !parsed.chapters || parsed.chapters.length === 0) {
        return { bookId: 999, chapter: 999 };
      }
      const exactCh = parsed.chapters.find(c => c.chapter === qNum);
      if (exactCh) return { bookId: exactCh.bookId || 999, chapter: exactCh.chapter };

      const subCh = parsed.chapters.find(c => String(c.chapter).includes(qTrimmed));
      if (subCh) return { bookId: subCh.bookId || 999, chapter: subCh.chapter };

      const firstCh = parsed.chapters[0];
      return { bookId: firstCh.bookId || 999, chapter: firstCh.chapter };
    };

    filtered.sort((a, b) => {
      const dStrA = String(a.day !== undefined && a.day !== null ? a.day : '').trim();
      const dStrB = String(b.day !== undefined && b.day !== null ? b.day : '').trim();

      const aIsDayMatch = dStrA.includes(qTrimmed) || a.day === qNum;
      const bIsDayMatch = dStrB.includes(qTrimmed) || b.day === qNum;

      // 1. Days first in ascending order
      if (aIsDayMatch && !bIsDayMatch) return -1;
      if (!aIsDayMatch && bIsDayMatch) return 1;

      if (aIsDayMatch && bIsDayMatch) {
        const aExact = (dStrA === qTrimmed || a.day === qNum);
        const bExact = (dStrB === qTrimmed || b.day === qNum);
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        return (a.day || 0) - (b.day || 0);
      }

      // 2. Bible chapters in canonical biblical order (bookId 1 to 66)
      const matchA = getPortionChapterMatch(a);
      const matchB = getPortionChapterMatch(b);

      if (matchA.bookId !== matchB.bookId) {
        return matchA.bookId - matchB.bookId;
      }

      // 3. Chapters in ascending order
      if (matchA.chapter !== matchB.chapter) {
        return matchA.chapter - matchB.chapter;
      }

      // 4. Fallback to Day ascending
      return (a.day || 0) - (b.day || 0);
    });
  }

  if (countEl) {
    if (qTrimmed) {
      countEl.textContent = filtered.length === 1 
        ? `1 matching portion found` 
        : `${filtered.length} of ${allPortionsCache.length} portions match`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  if (!filtered.length) {
    listEl.innerHTML = `<p class="sidebar-loading">No matching portions found for &ldquo;${escapeHtml(qTrimmed)}&rdquo;.</p>`;
    return;
  }

  filtered.forEach(item => {
    const el = document.createElement('div');
    const isCurrent = currentDayNum !== null && item.day === currentDayNum;
    el.className = 'sidebar-portion-item' + (isCurrent ? ' current-day' : '');

    const parsed = parsePassage(item.portion);
    let chipsHtml = '';
    if (!parsed.isCatchUp && parsed.chapters.length > 0) {
      chipsHtml = `<div class="sidebar-chips-row">${parsed.chapters.slice(0, 8).map(c => `<span class="sidebar-mini-chip">${escapeHtml(c.abbr)} ${escapeHtml(c.chapter)}</span>`).join('')}${parsed.chapters.length > 8 ? `<span class="sidebar-mini-chip">+${parsed.chapters.length - 8} more</span>` : ''}</div>`;
    }

    el.innerHTML = `
      <div class="sidebar-item-top">
        <span class="sidebar-day-tag">Day ${escapeHtml(item.day)} ${isCurrent ? '• TODAY' : ''}</span>
        <span class="sidebar-date-tag">${escapeHtml(item.date || '')}</span>
      </div>
      <div class="sidebar-portion-text">${escapeHtml(item.portion || '')}</div>
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

  if (!qTrimmed) {
    requestAnimationFrame(() => {
      const currentEl = listEl.querySelector('.sidebar-portion-item.current-day');
      if (currentEl) {
        currentEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        currentEl.classList.add('pulse-highlight');
        setTimeout(() => currentEl.classList.remove('pulse-highlight'), 1200);
      }
    });
  }
}

// ====== SECTION SCROLL TRANSITIONS ======

function initScrollTransitions() {
  const sections = document.querySelectorAll('main section');
  sections.forEach(sec => sec.classList.add('scroll-animate'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.06,
    rootMargin: '0px 0px -30px 0px'
  });

  sections.forEach(sec => observer.observe(sec));
}

// ====== PROCEDURAL WEB AUDIO HARMONICS (ANCIENT HARP & CELESTIAL CHIME) ======

let proceduralAudioCtx = null;
let lastHarpSoundTime = 0;
let lastMedallionSoundTime = 0;

function getProceduralAudioContext() {
  try {
    if (localStorage.getItem('bible92_sound_muted') === 'true') {
      return null;
    }
    if (!proceduralAudioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      proceduralAudioCtx = new AudioContextClass();
    }
    if (proceduralAudioCtx.state === 'suspended') {
      proceduralAudioCtx.resume().catch(() => {});
    }
    return proceduralAudioCtx;
  } catch (err) {
    return null;
  }
}

function playPluckedHarpString(ctx, masterGain, freq, startTime, duration = 1.4, noteGainVal = 0.12) {
  try {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const noteGain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, startTime);

    // Warm triangle partial with subtle detuning (+0.2%) for wood-chamber acoustic chorusing
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(freq * 1.002, startTime);

    filter.type = 'lowpass';
    filter.Q.setValueAtTime(2.4, startTime);
    // Initial bright pluck transient settling rapidly into warm string resonance
    filter.frequency.setValueAtTime(Math.min(freq * 6, 2800), startTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.9, 320), startTime + duration * 0.7);

    // Dynamic amplitude envelope: crisp 3ms pluck attack, followed by smooth exponential decay
    noteGain.gain.setValueAtTime(0.0001, startTime);
    noteGain.gain.linearRampToValueAtTime(noteGainVal, startTime + 0.004);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(masterGain);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + duration);
    osc2.stop(startTime + duration);
  } catch (err) {}
}

function playBellHarmonic(ctx, masterGain, freq, startTime, duration, vol) {
  try {
    if (freq > 8000) return;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, startTime);
    filter.Q.setValueAtTime(6.0, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(vol, startTime + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    osc.start(startTime);
    osc.stop(startTime + duration);
  } catch (err) {}
}

// Ancient Davidic Harp (Kinnor) arpeggio on Scripture Reader Parchment Scroll unfurl
function playScrollUnfurlHarp() {
  try {
    const ctx = getProceduralAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastHarpSoundTime < 0.4) return;
    lastHarpSoundTime = now;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.18, now);
    masterGain.connect(ctx.destination);

    // Ancient Davidic Pentatonic modal scale: D4, F#4, A4, B4, D5 (luminous biblical chord)
    const harpNotes = [
      { freq: 293.66, delay: 0.000, dur: 1.5, vol: 0.11 }, // D4
      { freq: 369.99, delay: 0.042, dur: 1.5, vol: 0.13 }, // F#4
      { freq: 440.00, delay: 0.084, dur: 1.6, vol: 0.14 }, // A4
      { freq: 493.88, delay: 0.126, dur: 1.6, vol: 0.13 }, // B4
      { freq: 587.33, delay: 0.168, dur: 1.8, vol: 0.12 }  // D5
    ];

    harpNotes.forEach(({ freq, delay, dur, vol }) => {
      playPluckedHarpString(ctx, masterGain, freq, now + delay, dur, vol);
    });
  } catch (err) {
    // Silent fail
  }
}

// Radiant Celestial Medallion chime on 3D inspection or level unlock
function playMedallionChime() {
  try {
    const ctx = getProceduralAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastMedallionSoundTime < 0.35) return;
    lastMedallionSoundTime = now;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.16, now);
    masterGain.connect(ctx.destination);

    const chord = [
      { freq: 293.66, delay: 0.00, dur: 1.8, vol: 0.09 }, // D4
      { freq: 440.00, delay: 0.03, dur: 2.0, vol: 0.11 }, // A4
      { freq: 587.33, delay: 0.06, dur: 2.2, vol: 0.13 }, // D5
      { freq: 739.99, delay: 0.09, dur: 2.4, vol: 0.12 }, // F#5
      { freq: 880.00, delay: 0.12, dur: 2.5, vol: 0.10 }, // A5
      { freq: 1174.66, delay: 0.16, dur: 2.6, vol: 0.08 }  // D6
    ];

    chord.forEach(({ freq, delay, dur, vol }) => {
      const t = now + delay;
      playPluckedHarpString(ctx, masterGain, freq, t, dur, vol);
      playBellHarmonic(ctx, masterGain, freq * 2, t, dur * 0.8, vol * 0.35);
    });
  } catch (err) {
    // Silent fail
  }
}

window.playScrollUnfurlHarp = playScrollUnfurlHarp;
window.playMedallionChime = playMedallionChime;

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
  // English
  { id: 'us_male', label: 'US (Male)', group: 'English', region: 'US', gender: 'Male', lang: 'en-US', fallbackPitch: 0.92 },
  { id: 'us_female', label: 'United States (Female)', group: 'English', region: 'US', gender: 'Female', lang: 'en-US', fallbackPitch: 1.05 },
  { id: 'uk_male', label: 'United Kingdom (Male)', group: 'English', region: 'UK', gender: 'Male', lang: 'en-GB', fallbackPitch: 0.92 },
  { id: 'uk_female', label: 'United Kingdom (Female)', group: 'English', region: 'UK', gender: 'Female', lang: 'en-GB', fallbackPitch: 1.05 },

  // Nepali (नेपाली)
  { id: 'nep_male', label: 'Nepali नेपाली (Male)', group: 'Nepali (नेपाली)', region: 'NP', gender: 'Male', lang: 'ne-NP', fallbackPitch: 0.92 },
  { id: 'nep_female', label: 'Nepali नेपाली (Female)', group: 'Nepali (नेपाली)', region: 'NP', gender: 'Female', lang: 'ne-NP', fallbackPitch: 1.08 },

  // Tibetan (བོད་སྐད)
  { id: 'tib_male', label: 'Tibetan བོད་སྐད། (Male)', group: 'Tibetan (བོད་སྐད)', region: 'BO', gender: 'Male', lang: 'bo', fallbackPitch: 0.90 },
  { id: 'tib_female', label: 'Tibetan བོད་སྐད། (Female)', group: 'Tibetan (བོད་སྐད)', region: 'BO', gender: 'Female', lang: 'bo', fallbackPitch: 1.08 },

  // Afrikaans
  { id: 'afr_male', label: 'Afrikaans (Male)', group: 'Afrikaans', region: 'ZA', gender: 'Male', lang: 'af-ZA', fallbackPitch: 0.92 },
  { id: 'afr_female', label: 'Afrikaans (Female)', group: 'Afrikaans', region: 'ZA', gender: 'Female', lang: 'af-ZA', fallbackPitch: 1.05 },

  // Hindi (हिन्दी)
  { id: 'hin_male', label: 'Hindi हिन्दी (Male)', group: 'Hindi (हिन्दी)', region: 'IN', gender: 'Male', lang: 'hi-IN', fallbackPitch: 0.92 },
  { id: 'hin_female', label: 'Hindi हिन्दी (Female)', group: 'Hindi (हिन्दी)', region: 'IN', gender: 'Female', lang: 'hi-IN', fallbackPitch: 1.08 }
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

      // Check if user's device has a native voice installed for this language
      const selectedConfig = NARRATOR_VOICES.find(v => v.id === selectedVoiceId);
      if (selectedConfig && selectedConfig.lang) {
        const langPrefix = selectedConfig.lang.split('-')[0].toLowerCase();
        if (langPrefix !== 'en') {
          const available = audioAvailableVoices.length ? audioAvailableVoices : (audioSpeechSynth ? audioSpeechSynth.getVoices() || [] : []);
          const hasNativeVoice = available.some(v => (v.lang || '').replace(/_/g, '-').toLowerCase().startsWith(langPrefix));
          if (!hasNativeVoice && typeof showNudgeToast === 'function') {
            const langName = selectedConfig.group || selectedConfig.label;
            showNudgeToast(`ℹ️ No native ${langName} voice installed on this device. Using ${selectedConfig.gender} fallback voice.`, false);
          }
        }
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

  const femaleKeywords = /\b(female|woman|girl|vrou|महिला|स्त्री|བུད་མེད|zira|samantha|victoria|karen|fiona|moira|tessa|jenny|aria|emma|sonia|libby|natasha|mia|clara|stephanie|anita|heera|veena|susan|linda|hazel|catherine|elizabeth|serena|ava|allison|joana|salli|ivy|kendra|kimberly|amy|alice|olivia|emily|sarah|chloe|aditi|raveena|kalpana|priya|sangita|chundak)\b/i;
  const maleKeywords = /\b(male|man|boy|manlik|पुरुष|སྐྱེས་པ|david|mark|guy|george|daniel|oliver|james|arthur|ryan|liam|aaron|alex|richard|tom|matthew|justin|joey|brian|russell|eric|christopher|benjamin|stefan|steve|steven|john|paul|peter|luke|connor|fred|nate|evan|ravi|hemant|madhav|tashi|dorje)\b/i;

  let bestVoice = null;
  let bestScore = -999;

  const targetLang = (targetConfig.lang || '').toLowerCase();
  const targetLangPrefix = targetLang.split('-')[0];

  for (const v of voices) {
    const name = (v.name || '').toLowerCase();
    const lang = (v.lang || '').replace(/_/g, '-').toLowerCase();
    const voiceLangPrefix = lang.split('-')[0];
    let score = 0;

    const isTargetUS = targetConfig.region === 'US';
    const isTargetUK = targetConfig.region === 'UK';

    // 1. Language & Region Matching
    if (isTargetUS) {
      if (lang.startsWith('en-us')) score += 60;
      else if (name.includes('united states') || name.includes('us english') || name.includes('(us)')) score += 50;
      else if (lang.startsWith('en') && !lang.startsWith('en-gb') && !name.includes('uk') && !name.includes('british')) score += 15;
      else score -= 40;
    } else if (isTargetUK) {
      if (lang.startsWith('en-gb')) score += 60;
      else if (name.includes('united kingdom') || name.includes('uk english') || name.includes('british') || name.includes('(uk)')) score += 50;
      else if (lang.startsWith('en') && !lang.startsWith('en-us')) score += 15;
      else score -= 40;
    } else if (targetLangPrefix) {
      if (lang === targetLang) {
        score += 70;
      } else if (voiceLangPrefix === targetLangPrefix) {
        score += 50;
      } else {
        score -= 50;
      }
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

  // If a language match was found with positive score
  if (bestScore > 0 && bestVoice) {
    return bestVoice;
  }

  // Gender-aware fallback so Female NEVER falls back to Male David
  const isFemaleTarget = targetConfig.gender === 'Female';
  const matchingGenderVoice = voices.find(v => {
    const n = (v.name || '').toLowerCase();
    return isFemaleTarget ? (femaleKeywords.test(n) || n.includes('female')) : (maleKeywords.test(n) || n.includes('male'));
  });

  return matchingGenderVoice || voices[0] || null;
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

  const groups = {};
  NARRATOR_VOICES.forEach(v => {
    const grp = v.group || 'Other';
    if (!groups[grp]) groups[grp] = [];
    groups[grp].push(v);
  });

  const available = audioAvailableVoices.length ? audioAvailableVoices : (audioSpeechSynth ? audioSpeechSynth.getVoices() || [] : []);

  Object.entries(groups).forEach(([groupName, voices]) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;

      const langPrefix = (v.lang || '').split('-')[0].toLowerCase();
      const hasNative = langPrefix === 'en' || available.some(av => (av.lang || '').replace(/_/g, '-').toLowerCase().startsWith(langPrefix));
      opt.textContent = hasNative ? v.label : `${v.label} (Fallback)`;

      if (v.id === savedVoiceId) {
        opt.selected = true;
      }
      optgroup.appendChild(opt);
    });
    voiceSelect.appendChild(optgroup);
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
    const headingEl = sectionEl.querySelector('.reader-chapter-heading');
    const foundIdx = audioVerseQueue.findIndex(chunk => 
      chunk.element && (chunk.element === headingEl || chunk.element === sectionEl || sectionEl.contains(chunk.element))
    );
    if (foundIdx !== -1) {
      targetIdx = foundIdx;
    }
  }

  if (currentUtterance) {
    currentUtterance.onstart = null;
    currentUtterance.onend = null;
    currentUtterance.onerror = null;
  }
  if (audioSpeechSynth) {
    try { audioSpeechSynth.cancel(); } catch (e) {}
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

  // Nullify old utterance handlers BEFORE cancel to prevent race condition skips
  if (currentUtterance) {
    currentUtterance.onstart = null;
    currentUtterance.onend = null;
    currentUtterance.onerror = null;
  }

  // Highlight active verse in reader UI and scroll gently if out of view
  document.querySelectorAll('.verse-row.speaking-verse, .reader-chapter-heading.speaking-verse').forEach(el => el.classList.remove('speaking-verse'));
  if (chunk.element) {
    chunk.element.classList.add('speaking-verse');
    const contentEl = document.getElementById('reader-content');
    if (contentEl) {
      const cRect = contentEl.getBoundingClientRect();
      const eRect = chunk.element.getBoundingClientRect();
      const isVisible = (eRect.top >= cRect.top + 10 && eRect.bottom <= cRect.bottom - 10);
      if (!isVisible) {
        chunk.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } else {
      chunk.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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
    const voiceLangPrefix = (voice.lang || '').replace(/_/g, '-').split('-')[0].toLowerCase();
    const configLangPrefix = (config.lang || '').split('-')[0].toLowerCase();
    if (voiceLangPrefix === configLangPrefix) {
      utterance.lang = voice.lang || config.lang;
    }
  }

  // Multilingual voice routing for non-English Scripture translations
  const TRANSLATION_LANG_MAP = {
    'NNRV': 'ne-NP',
    'NEPS': 'ne-NP',
    'HIN': 'hi-IN',
    'HIOV': 'hi-IN',
    'AFR': 'af-ZA',
    'AFR53': 'af-ZA',
    'TIB': 'bo'
  };

  const targetTranslationLang = TRANSLATION_LANG_MAP[activeReaderVersion];
  if (targetTranslationLang) {
    const selectedVoicePrefix = (config.lang || '').split('-')[0].toLowerCase();
    const translationLangPrefix = targetTranslationLang.split('-')[0].toLowerCase();

    // If user's selected voice is not already in the Scripture's language, route to translation's language
    if (selectedVoicePrefix !== translationLangPrefix) {
      utterance.lang = targetTranslationLang;
      if (audioSpeechSynth && typeof audioSpeechSynth.getVoices === 'function') {
        const allVoices = audioSpeechSynth.getVoices();
        const matchingVoice = allVoices.find(v => v.lang && v.lang.replace(/_/g, '-').toLowerCase().startsWith(translationLangPrefix));
        if (matchingVoice) {
          utterance.voice = matchingVoice;
        }
      }
    }
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
    if (window._speechActiveUtterance !== utterance) return;
    if (index < audioVerseQueue.length - 1) {
      playAudioVerseChunk(index + 1);
    } else {
      stopAudioPlayback();
    }
  };

  utterance.onerror = (evt) => {
    // Ignore deliberate cancels/interruptions when seeking or pausing
    if (evt && (evt.error === 'canceled' || evt.error === 'interrupted')) {
      return;
    }
    if (window._speechActiveUtterance !== utterance) return;
    console.warn('Speech synthesis chunk error:', evt);
    if (isAudioPlaying && index < audioVerseQueue.length - 1) {
      playAudioVerseChunk(index + 1);
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

// ====== LENIS SMOOTH SCROLLING ======

let lenisInstance = null;

function initLenisSmoothScroll() {
  if (typeof Lenis === 'undefined') {
    return null;
  }
  try {
    lenisInstance = new Lenis({
      lerp: 0.1,
      wheelMultiplier: 1.0,
      touchMultiplier: 1.2,
      smoothWheel: true,
      syncTouch: false
    });

    if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
      gsap.registerPlugin(ScrollTrigger);
      lenisInstance.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((time) => {
        lenisInstance.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);
    } else {
      function raf(time) {
        lenisInstance.raf(time);
        requestAnimationFrame(raf);
      }
      requestAnimationFrame(raf);
    }

    return lenisInstance;
  } catch (err) {
    console.warn('Lenis smooth scroll notice:', err);
    return null;
  }
}

// ====== VERTICAL SCROLL SCRUBBER RAIL ======

function initScrollScrubberRail() {
  const railEl = document.getElementById('scroll-scrubber-rail');
  const trackEl = document.getElementById('scrubber-track');
  const fillEl = document.getElementById('scrubber-fill');
  const thumbEl = document.getElementById('scrubber-glow-thumb');
  const markersContainer = document.getElementById('scrubber-markers-container');

  if (!railEl || !trackEl || !fillEl || !thumbEl || !markersContainer) {
    return;
  }

  const DASHBOARD_SECTIONS = [
    { id: 'boys-vs-girls-card', label: 'Boys vs Girls' },
    { id: 'section-today', label: "Today's Portion" },
    { id: 'section-heatmap', label: 'Streak Heatmap' },
    { id: 'section-level-progress', label: 'Level Progress' },
    { id: 'section-leaderboard', label: 'Leaderboard' },
    { id: 'section-all-time', label: 'Hall of Fame' },
    { id: 'section-comments', label: 'Community Chat' },
    { id: 'section-prayers', label: 'Prayer Wall' },
    { id: 'section-playground', label: 'Playground' }
  ];

  const PUBLIC_SECTIONS = [
    { id: 'public-today-preview', label: "Today's Portion" },
    { id: 'reading-syllabus', label: 'Reading Syllabus' },
    { id: 'pacing-comparison-section', label: 'Pacing Tiers' },
    { id: 'full-schedule-section', label: '92-Day Full Plan' },
    { id: 'frequently-asked-questions', label: 'FAQ & Features' }
  ];

  let currentActiveMarkers = [];
  let isTicking = false;

  function refreshMarkers() {
    markersContainer.innerHTML = '';
    currentActiveMarkers = [];

    const siteEl = document.getElementById('site');
    const publicOverview = document.getElementById('public-overview');
    const loginScreen = document.getElementById('login-screen');

    const isSiteVisible = siteEl && !siteEl.hidden;
    const isPublicVisible = publicOverview && !publicOverview.hidden;

    if (!isSiteVisible && !isPublicVisible) {
      railEl.hidden = true;
      return;
    }

    railEl.hidden = false;
    const targetDefs = isSiteVisible ? DASHBOARD_SECTIONS : PUBLIC_SECTIONS;
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const docHeight = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);

    targetDefs.forEach((def) => {
      const el = document.getElementById(def.id);
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const elTop = rect.top + scrollY;
      const percent = Math.min(1, Math.max(0, elTop / docHeight));

      const marker = document.createElement('div');
      marker.className = 'scrubber-marker';
      marker.style.top = `${(percent * 100).toFixed(2)}%`;
      marker.setAttribute('role', 'button');
      marker.setAttribute('tabindex', '0');
      marker.setAttribute('aria-label', `Jump to ${def.label}`);

      const tooltip = document.createElement('span');
      tooltip.className = 'scrubber-tooltip';
      tooltip.textContent = def.label;
      marker.appendChild(tooltip);

      const scrollToTarget = (e) => {
        if (e) e.stopPropagation();
        if (lenisInstance) {
          lenisInstance.scrollTo(el, { offset: -24, duration: 0.7 });
        } else {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };

      marker.addEventListener('click', scrollToTarget);
      marker.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          scrollToTarget(e);
        }
      });

      markersContainer.appendChild(marker);
      currentActiveMarkers.push({ el, marker, def });
    });

    updateScrubberProgress();
  }

  function updateScrubberProgress() {
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const docHeight = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, scrollY / docHeight));
    const percentStr = `${(progress * 100).toFixed(2)}%`;

    fillEl.style.height = percentStr;
    thumbEl.style.top = percentStr;
    thumbEl.style.opacity = progress > 0.005 ? '1' : '0';

    if (currentActiveMarkers.length === 0) return;

    const viewportCenter = scrollY + window.innerHeight * 0.35;
    let activeIdx = 0;
    let closestDist = Infinity;

    currentActiveMarkers.forEach((item, idx) => {
      const rect = item.el.getBoundingClientRect();
      const itemTop = rect.top + scrollY;
      const itemBottom = itemTop + rect.height;

      if (viewportCenter >= itemTop && viewportCenter <= itemBottom) {
        activeIdx = idx;
        closestDist = 0;
      } else {
        const dist = Math.abs(itemTop - viewportCenter);
        if (dist < closestDist) {
          closestDist = dist;
          activeIdx = idx;
        }
      }
    });

    currentActiveMarkers.forEach((item, idx) => {
      item.marker.classList.toggle('active', idx === activeIdx);
    });
  }

  function onScroll() {
    if (!isTicking) {
      window.requestAnimationFrame(() => {
        updateScrubberProgress();
        isTicking = false;
      });
      isTicking = true;
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  if (lenisInstance) {
    lenisInstance.on('scroll', onScroll);
  }

  // Live drag & click scrub on rail track
  let isDraggingRail = false;

  function scrubToEvent(e) {
    const rect = trackEl.getBoundingClientRect();
    const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : rect.top);
    const clampY = Math.min(rect.height, Math.max(0, clientY - rect.top));
    const ratio = clampY / rect.height;
    const docHeight = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const targetY = ratio * docHeight;

    if (lenisInstance) {
      lenisInstance.scrollTo(targetY, { immediate: true });
    } else {
      window.scrollTo({ top: targetY, behavior: 'auto' });
    }
  }

  trackEl.parentElement.addEventListener('pointerdown', (e) => {
    isDraggingRail = true;
    railEl.classList.add('active-scrub');
    scrubToEvent(e);

    const onPointerMove = (moveEvent) => {
      if (!isDraggingRail) return;
      scrubToEvent(moveEvent);
    };

    const onPointerUp = () => {
      isDraggingRail = false;
      railEl.classList.remove('active-scrub');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  window.refreshScrollScrubber = refreshMarkers;
  window.addEventListener('resize', () => {
    setTimeout(refreshMarkers, 100);
  }, { passive: true });

  refreshMarkers();
}

// ====== AMBIENT THREE.JS 3D CELESTIAL BACKGROUND ======

function initAmbientCelestialBackground() {
  const canvas = document.getElementById('ambient-canvas');
  if (!canvas || typeof THREE === 'undefined') {
    return;
  }

  let renderer, scene, camera;
  let starField, starMaterial, starGeometry;
  let dustField, dustMaterial, dustGeometry;
  let animFrameId = null;
  let lastTime = 0;

  // Parallax reaction coordinates
  let mouseX = 0, mouseY = 0;
  let targetMouseX = 0, targetMouseY = 0;
  let baseRotY = 0, baseRotX = 0;
  let scrollTargetY = 0;
  let scrollCurrentY = 0;

  // Battery and resource pause management
  const pauseReasons = new Set();

  function checkLoopState() {
    if (pauseReasons.size === 0) {
      if (!animFrameId) {
        lastTime = performance.now();
        animFrameId = requestAnimationFrame(renderLoop);
      }
    } else {
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    }
  }

  function pause(reason) {
    pauseReasons.add(reason);
    checkLoopState();
  }

  function resume(reason) {
    pauseReasons.delete(reason);
    checkLoopState();
  }

  // Brilliant circular glowing star alpha texture (64x64)
  function createCircularStarTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.18, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.42, 'rgba(255, 255, 255, 0.6)');
    grad.addColorStop(0.72, 'rgba(255, 255, 255, 0.18)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    return new THREE.CanvasTexture(c);
  }

  // Soft ambient cosmic dust texture (64x64)
  function createDustMoteTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.45)');
    grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.1)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    return new THREE.CanvasTexture(c);
  }

  try {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Renderer with battery saving options
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, width / height, 1, 3000);
    camera.position.z = 800;

    // Calibrated atmospheric fog
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const isDark = currentTheme !== 'light';
    scene.fog = new THREE.FogExp2(isDark ? 0x14162b : 0xf6efe1, isDark ? 0.00028 : 0.00035);

    // Color palettes
    const darkPalette = [
      new THREE.Color('#38bdf8'), // sky cyan
      new THREE.Color('#f59e0b'), // warm gold
      new THREE.Color('#f472b6'), // cosmic rose
      new THREE.Color('#ffffff'), // diamond white
      new THREE.Color('#a78bfa')  // celestial purple
    ];

    const lightPalette = [
      new THREE.Color('#d97706'), // warm amber gold
      new THREE.Color('#0284c7'), // celestial azure
      new THREE.Color('#7c3aed'), // ethereal purple
      new THREE.Color('#b45309'), // warm bronze
      new THREE.Color('#0369a1')  // sapphire sky
    ];

    const activePalette = isDark ? darkPalette : lightPalette;
    const sharedStarTexture = createCircularStarTexture();

    // 1. PRIMARY STARFIELD (1,800 radiant celestial stars)
    const PRIMARY_STAR_COUNT = 1800;
    starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PRIMARY_STAR_COUNT * 3);
    const colors = new Float32Array(PRIMARY_STAR_COUNT * 3);

    for (let i = 0; i < PRIMARY_STAR_COUNT; i++) {
      const i3 = i * 3;
      positions[i3] = (Math.random() - 0.5) * 1800;
      positions[i3 + 1] = (Math.random() - 0.5) * 1800;
      positions[i3 + 2] = (Math.random() - 0.5) * 1600 - 100;

      const col = activePalette[Math.floor(Math.random() * activePalette.length)];
      colors[i3] = col.r;
      colors[i3 + 1] = col.g;
      colors[i3 + 2] = col.b;
    }

    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    starMaterial = new THREE.PointsMaterial({
      size: isDark ? 16 : 13,
      vertexColors: true,
      map: sharedStarTexture,
      transparent: true,
      opacity: isDark ? 0.95 : 0.55,
      blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false
    });

    starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);

    // 2. ETHEREAL NEBULA DUST (450 larger, soft glowing cosmic motes)
    const DUST_COUNT = 450;
    dustGeometry = new THREE.BufferGeometry();
    const dustPositions = new Float32Array(DUST_COUNT * 3);
    const dustColors = new Float32Array(DUST_COUNT * 3);

    for (let i = 0; i < DUST_COUNT; i++) {
      const i3 = i * 3;
      dustPositions[i3] = (Math.random() - 0.5) * 2000;
      dustPositions[i3 + 1] = (Math.random() - 0.5) * 2000;
      dustPositions[i3 + 2] = (Math.random() - 0.5) * 1800 - 200;

      const col = activePalette[Math.floor(Math.random() * activePalette.length)];
      dustColors[i3] = col.r;
      dustColors[i3 + 1] = col.g;
      dustColors[i3 + 2] = col.b;
    }

    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColors, 3));

    dustMaterial = new THREE.PointsMaterial({
      size: isDark ? 36 : 28,
      vertexColors: true,
      map: createDustMoteTexture(),
      transparent: true,
      opacity: isDark ? 0.55 : 0.35,
      blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false
    });

    dustField = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dustField);

    // 3. RIVER OF LIGHT WARP STREAMERS (Rev 22:1 - Multi-hued theme light streamers)
    const WARP_STREAMER_COUNT = 160;
    const warpGeometry = new THREE.BufferGeometry();
    const warpPositions = new Float32Array(WARP_STREAMER_COUNT * 2 * 3);
    const warpColors = new Float32Array(WARP_STREAMER_COUNT * 2 * 3);
    const warpOrigins = [];

    const WARP_THEME_COLORS_DARK = [
      new THREE.Color('#f59e0b'), // warm gold
      new THREE.Color('#38bdf8'), // sky cyan
      new THREE.Color('#a78bfa'), // celestial purple
      new THREE.Color('#f472b6'), // cosmic rose
      new THREE.Color('#34d399'), // river mint
      new THREE.Color('#ffffff'), // diamond white
      new THREE.Color('#fbbf24'), // radiant amber
      new THREE.Color('#67e8f9')  // azure light
    ];

    const WARP_THEME_COLORS_LIGHT = [
      new THREE.Color('#d97706'), // warm bronze
      new THREE.Color('#0284c7'), // sapphire azure
      new THREE.Color('#7c3aed'), // royal purple
      new THREE.Color('#db2777'), // deep rose
      new THREE.Color('#059669'), // river emerald
      new THREE.Color('#b45309'), // rich amber
      new THREE.Color('#0891b2'), // deep cyan
      new THREE.Color('#475569')  // slate
    ];

    const activeWarpPalette = isDark ? WARP_THEME_COLORS_DARK : WARP_THEME_COLORS_LIGHT;

    for (let i = 0; i < WARP_STREAMER_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 80 + Math.random() * 520;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const z = (Math.random() - 0.5) * 1600;
      const len = 70 + Math.random() * 140;
      warpOrigins.push({ x, y, z, len });

      const i6 = i * 6;
      warpPositions[i6] = x;
      warpPositions[i6 + 1] = y;
      warpPositions[i6 + 2] = z;
      warpPositions[i6 + 3] = x;
      warpPositions[i6 + 4] = y;
      warpPositions[i6 + 5] = z - 20;

      const col = activeWarpPalette[i % activeWarpPalette.length];
      warpColors[i6] = col.r;
      warpColors[i6 + 1] = col.g;
      warpColors[i6 + 2] = col.b;
      warpColors[i6 + 3] = col.r;
      warpColors[i6 + 4] = col.g;
      warpColors[i6 + 5] = col.b;
    }

    warpGeometry.setAttribute('position', new THREE.BufferAttribute(warpPositions, 3));
    warpGeometry.setAttribute('color', new THREE.BufferAttribute(warpColors, 3));

    const warpMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false
    });
    const warpStreamers = new THREE.LineSegments(warpGeometry, warpMaterial);
    scene.add(warpStreamers);

    // 4. MILESTONE CONSTELLATIONS (Star Map of Scripture - Centered in Viewport & Progress-Bound)
    const CONSTELLATIONS_DATA = [
      {
        id: 'torch',
        name: 'The Lamp of Torah',
        phase: 'Days 1–25 • Pentateuch & Torah',
        verse: '"Thy word is a lamp unto my feet, and a light unto my path." (Psalm 119:105)',
        icon: '🪔',
        nodes: [
          [-28, -95, 0], [28, -95, 0], [0, -70, 0], [0, -45, 0],
          [-48, -30, 0], [48, -30, 0], [-68, -18, 0], [62, -15, 0],
          [52, -45, 0], [-68, -5, 0], [-72, 28, 0], [-62, 10, 0]
        ],
        segments: [
          [0, 1], [0, 2], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5],
          [4, 6], [5, 7], [7, 8], [6, 9], [9, 10], [9, 11], [10, 11]
        ]
      },
      {
        id: 'harp',
        name: 'The Harp of David',
        phase: 'Days 26–50 • Poetry & Psalms',
        verse: '"Awake, harp and lyre! I will awaken the dawn." (Psalm 57:8)',
        icon: '🎵',
        nodes: [
          [-35, -90, 0], [35, -90, 0], [-55, -50, 0], [-68, 0, 0],
          [-62, 50, 0], [-42, 80, 0], [0, 92, 0], [42, 75, 0],
          [62, 40, 0], [-35, 75, 0], [-25, -75, 0], [-15, 82, 0],
          [-8, -75, 0], [5, 88, 0], [10, -75, 0], [25, 80, 0], [26, -75, 0]
        ],
        segments: [
          [0, 1], [0, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 1],
          [9, 10], [11, 12], [13, 14], [15, 16]
        ]
      },
      {
        id: 'lion',
        name: 'The Lion of Judah',
        phase: 'Days 51–75 • Major & Minor Prophets',
        verse: '"The Lion of the tribe of Judah, the Root of David, has triumphed." (Rev 5:5)',
        icon: '🦁',
        nodes: [
          [35, -10, 0], [58, 15, 0], [52, 48, 0], [30, 68, 0],
          [8, 62, 0], [12, 38, 0], [-18, 5, 0], [-60, 0, 0],
          [-90, -18, 0], [-95, -75, 0], [-78, -82, 0], [38, -75, 0],
          [55, -82, 0], [-110, 10, 0], [-102, 32, 0]
        ],
        segments: [
          [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0],
          [0, 6], [6, 7], [7, 8], [8, 9], [9, 10], [0, 11], [11, 12],
          [8, 13], [13, 14]
        ]
      },
      {
        id: 'cross',
        name: 'The Living Cross & Morning Star',
        phase: 'Days 76–91 • Gospels & Epistles',
        verse: '"I am the Root and the Offspring of David, and the bright Morning Star." (Rev 22:16)',
        icon: '✝️',
        nodes: [
          [0, 10, 0], [0, 105, 0], [0, -95, 0], [-65, 35, 0],
          [65, 35, 0], [0, 45, 0], [30, 10, 0], [0, -25, 0],
          [-30, 10, 0], [-42, 65, 0], [42, 65, 0], [42, -45, 0], [-42, -45, 0]
        ],
        segments: [
          [1, 5], [5, 0], [0, 7], [7, 2], [3, 8], [8, 0], [0, 6], [6, 4],
          [5, 6], [6, 7], [7, 8], [8, 5],
          [0, 9], [0, 10], [0, 11], [0, 12]
        ]
      },
      {
        id: 'crown',
        name: 'The Victor’s Crown 🏆',
        phase: 'Day 92 • Revelation & Finisher',
        verse: '"Now there is in store for me the crown of righteousness..." (2 Tim 4:8)',
        icon: '👑',
        nodes: [
          [-85, -45, 0], [-42, -52, 0], [0, -54, 0], [42, -52, 0], [85, -45, 0],
          [-80, 10, 0], [-40, 45, 0], [0, 80, 0], [40, 45, 0], [80, 10, 0],
          [-20, -10, 0], [20, -10, 0],
          [-80, 18, 0], [-40, 53, 0], [0, 88, 0], [40, 53, 0], [80, 18, 0]
        ],
        segments: [
          [0, 1], [1, 2], [2, 3], [3, 4],
          [0, 5], [1, 6], [2, 7], [3, 8], [4, 9],
          [5, 1], [6, 2], [7, 3], [8, 4],
          [1, 10], [10, 2], [2, 11], [11, 3],
          [5, 12], [6, 13], [7, 14], [8, 15], [9, 16]
        ]
      }
    ];

    const constellationsMasterGroup = new THREE.Group();
    constellationsMasterGroup.position.z = 240;
    scene.add(constellationsMasterGroup);

    const constellationMeshes = [];

    // Construct each constellation centered mathematically at local origin (0, 0, 0)
    CONSTELLATIONS_DATA.forEach((data) => {
      const cGroup = new THREE.Group();

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      data.nodes.forEach(pt => {
        minX = Math.min(minX, pt[0]);
        maxX = Math.max(maxX, pt[0]);
        minY = Math.min(minY, pt[1]);
        maxY = Math.max(maxY, pt[1]);
      });
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      const centeredNodes = data.nodes.map(pt => [pt[0] - midX, pt[1] - midY, pt[2] || 0]);

      // Nodes
      const nodePos = new Float32Array(centeredNodes.length * 3);
      centeredNodes.forEach((pt, n) => {
        nodePos[n * 3] = pt[0];
        nodePos[n * 3 + 1] = pt[1];
        nodePos[n * 3 + 2] = pt[2];
      });
      const nodeGeom = new THREE.BufferGeometry();
      nodeGeom.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
      const nodeMat = new THREE.PointsMaterial({
        size: isDark ? 15 : 12,
        color: isDark ? 0xfffbeb : 0xd97706,
        map: sharedStarTexture,
        transparent: true,
        opacity: 0,
        blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false
      });
      const nodePoints = new THREE.Points(nodeGeom, nodeMat);
      cGroup.add(nodePoints);

      // Lines
      const linePos = new Float32Array(data.segments.length * 2 * 3);
      data.segments.forEach((seg, s) => {
        const p1 = centeredNodes[seg[0]];
        const p2 = centeredNodes[seg[1]];
        const s6 = s * 6;
        linePos[s6] = p1[0];
        linePos[s6 + 1] = p1[1];
        linePos[s6 + 2] = p1[2];
        linePos[s6 + 3] = p2[0];
        linePos[s6 + 4] = p2[1];
        linePos[s6 + 5] = p2[2];
      });
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: isDark ? 0xf59e0b : 0xb45309,
        transparent: true,
        opacity: 0,
        blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false,
        linewidth: 2.2
      });
      const lineMesh = new THREE.LineSegments(lineGeom, lineMat);
      cGroup.add(lineMesh);

      cGroup.visible = false;
      constellationsMasterGroup.add(cGroup);

      constellationMeshes.push({
        data,
        group: cGroup,
        nodeMat,
        lineMat,
        targetOpacity: 0,
        currentOpacity: 0
      });
    });

    // Milestone calculation and HUD sync
    function getMilestoneConstellationIndex(days) {
      const d = Math.max(0, Number(days) || 0);
      if (d >= 92) return 4; // Day 92: The Victor's Crown 🏆
      if (d >= 76) return 3; // Days 76–91: The Living Cross & Morning Star
      if (d >= 51) return 2; // Days 51–75: The Lion of Judah
      if (d >= 26) return 1; // Days 26–50: The Harp of David
      return 0;              // Days 1–25: The Lamp of Torah
    }

    const hudEl = document.getElementById('constellation-hud');
    const hudIconEl = document.getElementById('constellation-hud-icon');
    const hudPhaseEl = document.getElementById('constellation-hud-phase');
    const hudNameEl = document.getElementById('constellation-hud-name');
    const hudDaysEl = document.getElementById('constellation-hud-days');
    const hudPrevBtn = document.getElementById('constellation-prev-btn');
    const hudNextBtn = document.getElementById('constellation-next-btn');
    const hudMenuBtn = document.getElementById('constellation-menu-btn');
    const pickerMenuEl = document.getElementById('constellation-picker-menu');
    const pickerCloseBtn = document.getElementById('constellation-picker-close');
    const pickerListEl = document.getElementById('constellation-picker-list');
    const pickerResetBtn = document.getElementById('constellation-reset-current');

    let activeMilestoneDays = getUserDaysCompleted();
    let activeMilestoneIdx = getMilestoneConstellationIndex(activeMilestoneDays);
    let selectedConstellationIdx = activeMilestoneIdx;

    function updateConstellationHUD(days, displayedIdx, progressIdx) {
      if (!hudEl) return;
      const activeData = CONSTELLATIONS_DATA[displayedIdx];
      if (!activeData) return;

      if (hudIconEl) hudIconEl.textContent = activeData.icon;
      if (hudPhaseEl) {
        if (displayedIdx === progressIdx) {
          hudPhaseEl.textContent = 'Active Milestone Constellation';
        } else {
          hudPhaseEl.textContent = 'Viewing Milestone • Past Unlocked';
        }
      }
      if (hudNameEl) hudNameEl.textContent = activeData.name;

      if (hudDaysEl) {
        if (displayedIdx === progressIdx) {
          if (displayedIdx === 0) {
            const inM = Math.min(25, days);
            const pct = Math.round((inM / 25) * 100);
            hudDaysEl.textContent = `Days 1–25 • ${inM} / 25 Days in Milestone (${pct}%)`;
          } else if (displayedIdx === 1) {
            const inM = Math.max(0, Math.min(25, days - 25));
            const pct = Math.round((inM / 25) * 100);
            hudDaysEl.textContent = `Days 26–50 • ${inM} / 25 Days in Milestone (${pct}%)`;
          } else if (displayedIdx === 2) {
            const inM = Math.max(0, Math.min(25, days - 50));
            const pct = Math.round((inM / 25) * 100);
            hudDaysEl.textContent = `Days 51–75 • ${inM} / 25 Days in Milestone (${pct}%)`;
          } else if (displayedIdx === 3) {
            const inM = Math.max(0, Math.min(16, days - 75));
            const pct = Math.round((inM / 16) * 100);
            hudDaysEl.textContent = `Days 76–91 • ${inM} / 16 Days in Milestone (${pct}%)`;
          } else {
            hudDaysEl.textContent = `Day 92 • Completed Challenge 🏆 (100%)`;
          }
        } else {
          hudDaysEl.textContent = `${activeData.phase} • Unlocked ✓`;
        }
      }

      if (hudPrevBtn) {
        hudPrevBtn.disabled = (displayedIdx <= 0);
      }
      if (hudNextBtn) {
        hudNextBtn.disabled = (displayedIdx >= progressIdx);
      }

      hudEl.classList.add('active');
    }

    function applyDisplayedConstellation(idx, showToast = false) {
      const targetIdx = Math.max(0, Math.min(activeMilestoneIdx, Number(idx) || 0));
      selectedConstellationIdx = targetIdx;

      // Exclusively activate target constellation
      constellationMeshes.forEach((item, i) => {
        item.targetOpacity = (i === selectedConstellationIdx) ? 1.0 : 0.0;
      });

      updateConstellationHUD(activeMilestoneDays, selectedConstellationIdx, activeMilestoneIdx);
      renderConstellationPickerMenu();

      if (showToast && typeof showNudgeToast === 'function') {
        const itemData = CONSTELLATIONS_DATA[selectedConstellationIdx];
        if (selectedConstellationIdx === activeMilestoneIdx) {
          showNudgeToast(`✨ Illuminating current milestone: ${itemData.name}`);
        } else {
          showNudgeToast(`✨ Illuminating unlocked milestone: ${itemData.name}`);
        }
      }
    }

    function renderConstellationPickerMenu() {
      if (!pickerListEl) return;
      pickerListEl.innerHTML = '';

      CONSTELLATIONS_DATA.forEach((item, idx) => {
        const isUnlocked = (idx <= activeMilestoneIdx);
        const isActive = (idx === selectedConstellationIdx);
        const isCurrentProgress = (idx === activeMilestoneIdx);

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `constellation-picker-item ${isUnlocked ? 'unlocked' : 'locked'} ${isActive ? 'active' : ''}`;

        let badgeHtml = '';
        if (isActive) {
          badgeHtml = `<span class="constellation-picker-item-badge">Active ✨</span>`;
        } else if (isCurrentProgress) {
          badgeHtml = `<span class="constellation-picker-item-badge" style="background: rgba(245, 158, 11, 0.2); color: #fef08a;">Current</span>`;
        } else if (isUnlocked) {
          badgeHtml = `<span class="constellation-picker-item-badge">Unlocked ✓</span>`;
        } else {
          const reqDay = idx === 1 ? 26 : idx === 2 ? 51 : idx === 3 ? 76 : 92;
          badgeHtml = `<span class="constellation-picker-item-badge">🔒 Day ${reqDay}</span>`;
        }

        row.innerHTML = `
          <div class="constellation-picker-item-icon">${item.icon}</div>
          <div class="constellation-picker-item-info">
            <div class="constellation-picker-item-title">${item.name}</div>
            <div class="constellation-picker-item-sub">${item.phase}</div>
          </div>
          ${badgeHtml}
        `;

        row.addEventListener('click', () => {
          if (isUnlocked) {
            applyDisplayedConstellation(idx, true);
            closeConstellationPickerMenu();
          } else {
            const reqDay = idx === 1 ? 26 : idx === 2 ? 51 : idx === 3 ? 76 : 92;
            if (typeof showNudgeToast === 'function') {
              showNudgeToast(`🔒 ${item.name} is locked. Complete ${reqDay} reading days to unlock this constellation!`, true);
            }
          }
        });

        pickerListEl.appendChild(row);
      });
    }

    function openConstellationPickerMenu() {
      if (!pickerMenuEl) return;
      renderConstellationPickerMenu();
      pickerMenuEl.removeAttribute('hidden');
      if (hudMenuBtn) hudMenuBtn.setAttribute('aria-expanded', 'true');
    }

    function closeConstellationPickerMenu() {
      if (!pickerMenuEl) return;
      pickerMenuEl.setAttribute('hidden', '');
      if (hudMenuBtn) hudMenuBtn.setAttribute('aria-expanded', 'false');
    }

    // Navigation & Dropdown Click Handlers
    if (hudPrevBtn) {
      hudPrevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedConstellationIdx > 0) {
          applyDisplayedConstellation(selectedConstellationIdx - 1, true);
        }
      });
    }

    if (hudNextBtn) {
      hudNextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedConstellationIdx < activeMilestoneIdx) {
          applyDisplayedConstellation(selectedConstellationIdx + 1, true);
        }
      });
    }

    if (hudMenuBtn) {
      hudMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pickerMenuEl && pickerMenuEl.hasAttribute('hidden')) {
          openConstellationPickerMenu();
        } else {
          closeConstellationPickerMenu();
        }
      });
    }

    if (pickerCloseBtn) {
      pickerCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeConstellationPickerMenu();
      });
    }

    if (pickerResetBtn) {
      pickerResetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyDisplayedConstellation(activeMilestoneIdx, true);
        closeConstellationPickerMenu();
      });
    }

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (pickerMenuEl && !pickerMenuEl.hasAttribute('hidden')) {
        if (!pickerMenuEl.contains(e.target) && !hudEl.contains(e.target)) {
          closeConstellationPickerMenu();
        }
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pickerMenuEl && !pickerMenuEl.hasAttribute('hidden')) {
        closeConstellationPickerMenu();
      }
    });

    function setDaysCompleted(days) {
      activeMilestoneDays = Math.max(0, Number(days) || 0);
      const newActiveIdx = getMilestoneConstellationIndex(activeMilestoneDays);

      // Advance selection if user leveled up
      if (newActiveIdx !== activeMilestoneIdx) {
        activeMilestoneIdx = newActiveIdx;
        selectedConstellationIdx = activeMilestoneIdx;
      }

      applyDisplayedConstellation(selectedConstellationIdx);
    }

    // Initialize with current user progress
    setDaysCompleted(activeMilestoneDays);

    // Velocity state
    let smoothVelocity = 0;
    let lastVelocityTime = performance.now();
    let lastScrollYForVelocity = window.pageYOffset || document.documentElement.scrollTop;

    // Mouse parallax reaction with responsive sensitivity
    window.addEventListener('mousemove', (e) => {
      targetMouseX = (e.clientX - window.innerWidth / 2) * 0.00085;
      targetMouseY = (e.clientY - window.innerHeight / 2) * 0.00085;
    }, { passive: true });

    // Scroll parallax reaction
    window.addEventListener('scroll', () => {
      const st = window.pageYOffset || document.documentElement.scrollTop;
      scrollTargetY = st * 0.07;
    }, { passive: true });

    // Window resize handler
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }, { passive: true });

    // Page visibility listener
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pause('hidden');
      } else {
        resume('hidden');
      }
    });

    // Prefers reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pause('motion');
    }

    // Dynamic Theme Adaptation
    function setTheme(theme) {
      const isLightMode = theme === 'light';
      if (scene.fog) {
        scene.fog.color.setHex(isLightMode ? 0xf6efe1 : 0x14162b);
        scene.fog.density = isLightMode ? 0.00035 : 0.00028;
      }

      if (starMaterial) {
        starMaterial.size = isLightMode ? 13 : 16;
        starMaterial.opacity = isLightMode ? 0.55 : 0.95;
        starMaterial.blending = isLightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
        starMaterial.needsUpdate = true;
      }

      if (dustMaterial) {
        dustMaterial.size = isLightMode ? 28 : 36;
        dustMaterial.opacity = isLightMode ? 0.35 : 0.55;
        dustMaterial.blending = isLightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
        dustMaterial.needsUpdate = true;
      }

      if (warpMaterial && warpGeometry) {
        const targetWarpPalette = isLightMode ? WARP_THEME_COLORS_LIGHT : WARP_THEME_COLORS_DARK;
        const warpColorArr = warpGeometry.attributes.color.array;
        for (let i = 0; i < WARP_STREAMER_COUNT; i++) {
          const col = targetWarpPalette[i % targetWarpPalette.length];
          const i6 = i * 6;
          warpColorArr[i6] = col.r;
          warpColorArr[i6 + 1] = col.g;
          warpColorArr[i6 + 2] = col.b;
          warpColorArr[i6 + 3] = col.r;
          warpColorArr[i6 + 4] = col.g;
          warpColorArr[i6 + 5] = col.b;
        }
        warpGeometry.attributes.color.needsUpdate = true;
        warpMaterial.blending = isLightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
        warpMaterial.needsUpdate = true;
      }

      const targetPalette = isLightMode ? lightPalette : darkPalette;

      if (starGeometry) {
        const colorAttr = starGeometry.attributes.color;
        for (let i = 0; i < PRIMARY_STAR_COUNT; i++) {
          const i3 = i * 3;
          const col = targetPalette[Math.floor(Math.random() * targetPalette.length)];
          colorAttr.array[i3] = col.r;
          colorAttr.array[i3 + 1] = col.g;
          colorAttr.array[i3 + 2] = col.b;
        }
        colorAttr.needsUpdate = true;
      }

      if (dustGeometry) {
        const dustColAttr = dustGeometry.attributes.color;
        for (let i = 0; i < DUST_COUNT; i++) {
          const i3 = i * 3;
          const col = targetPalette[Math.floor(Math.random() * targetPalette.length)];
          dustColAttr.array[i3] = col.r;
          dustColAttr.array[i3 + 1] = col.g;
          dustColAttr.array[i3 + 2] = col.b;
        }
        dustColAttr.needsUpdate = true;
      }

      constellationMeshes.forEach((item) => {
        item.nodeMat.color.setHex(isLightMode ? 0xd97706 : 0xfffbeb);
        item.nodeMat.blending = isLightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
        item.nodeMat.needsUpdate = true;
        item.lineMat.color.setHex(isLightMode ? 0xb45309 : 0xf59e0b);
        item.lineMat.blending = isLightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
        item.lineMat.needsUpdate = true;
      });
    }

    // Render loop
    function renderLoop(timestamp) {
      if (pauseReasons.size > 0) {
        animFrameId = null;
        return;
      }

      const delta = timestamp - lastTime;
      lastTime = timestamp;

      // Parallax lerp
      mouseX += (targetMouseX - mouseX) * 0.05;
      mouseY += (targetMouseY - mouseY) * 0.05;

      // Scroll parallax lerp
      scrollCurrentY += (scrollTargetY - scrollCurrentY) * 0.05;
      camera.position.y = -scrollCurrentY;

      // Base orbital rotation
      baseRotY += 0.00045;
      baseRotX += 0.00015;

      // Velocity tracking for River of Light Warp Streamers
      let instantVelocity = 0;
      if (lenisInstance && typeof lenisInstance.velocity === 'number') {
        instantVelocity = Math.abs(lenisInstance.velocity);
      } else {
        const now = performance.now();
        const currentScrollY = window.pageYOffset || document.documentElement.scrollTop;
        const dt = Math.max(1, now - lastVelocityTime);
        instantVelocity = (Math.abs(currentScrollY - lastScrollYForVelocity) / dt) * 10;
        lastVelocityTime = now;
        lastScrollYForVelocity = currentScrollY;
      }

      smoothVelocity += (instantVelocity - smoothVelocity) * 0.14;

      // Multi-hued River of Light Warp Streamers Stretch
      if (warpMaterial && warpStreamers) {
        const currentThemeNow = document.documentElement.getAttribute('data-theme') || 'dark';
        const isDarkNow = currentThemeNow !== 'light';
        const warpFactor = Math.min(smoothVelocity / 5, 1);
        warpMaterial.opacity = warpFactor * (isDarkNow ? 0.75 : 0.45);
        warpStreamers.scale.z = 1 + smoothVelocity * 0.22;

        const posArr = warpGeometry.attributes.position.array;
        for (let i = 0; i < WARP_STREAMER_COUNT; i++) {
          const orig = warpOrigins[i];
          const dynamicLen = orig.len * (1 + smoothVelocity * 0.35);
          const i6 = i * 6;
          posArr[i6 + 5] = orig.z - dynamicLen;
        }
        warpGeometry.attributes.position.needsUpdate = true;
      }

      // Particle Z stretch along scroll velocity
      if (dustField) {
        dustField.scale.z = 1 + smoothVelocity * 0.16;
        dustField.rotation.y = -(baseRotY * 0.6) + mouseX * 0.5;
        dustField.rotation.x = -(baseRotX * 0.6) + mouseY * 0.5;
      }

      if (starField) {
        starField.scale.z = 1 + smoothVelocity * 0.06;
        starField.rotation.y = baseRotY + mouseX;
        starField.rotation.x = baseRotX + mouseY;
      }

      camera.position.z = 800 - Math.min(smoothVelocity * 15, 110);

      // CENTER IN VIEWPORT: Synchronize constellation position with camera.position.y
      if (constellationsMasterGroup) {
        constellationsMasterGroup.position.set(0, camera.position.y, 240);
        constellationsMasterGroup.rotation.y = baseRotY * 0.35 + mouseX * 0.4;
        constellationsMasterGroup.rotation.x = baseRotX * 0.35 + mouseY * 0.4;
      }

      // Constellation smooth fading and subtle breathing
      const currentThemeNow = document.documentElement.getAttribute('data-theme') || 'dark';
      const isDarkNow = currentThemeNow !== 'light';

      constellationMeshes.forEach((item, idx) => {
        item.currentOpacity += (item.targetOpacity - item.currentOpacity) * 0.08;
        if (item.currentOpacity > 0.005) {
          item.nodeMat.opacity = item.currentOpacity * (isDarkNow ? 0.95 : 0.75);
          item.lineMat.opacity = item.currentOpacity * (isDarkNow ? 0.85 : 0.65);
          item.group.visible = true;
          item.group.rotation.z = Math.sin(timestamp * 0.0008) * 0.03;
        } else {
          item.group.visible = false;
        }
      });

      renderer.render(scene, camera);
      animFrameId = requestAnimationFrame(renderLoop);
    }

    // Export controller
    window.ambientCelestialBg = {
      setTheme,
      setDaysCompleted,
      selectConstellation: (idx) => applyDisplayedConstellation(idx, true),
      resetToCurrentMilestone: () => applyDisplayedConstellation(activeMilestoneIdx, true),
      pause,
      resume
    };

    // Kick off render loop if visible
    if (!document.hidden) {
      animFrameId = requestAnimationFrame(renderLoop);
    }
  } catch (err) {
    console.warn('Three.js celestial starfield init error:', err);
  }
}

// ====== INTERACTIVE 3D LEVEL MEDALLION (METALLIC SHIELD & RIBBON) ======

function initLevelMedallion3D() {
  const modal = document.getElementById('medallion-modal');
  const backdrop = document.getElementById('medallion-modal-backdrop');
  const closeBtn = document.getElementById('close-medallion-btn');
  const canvas = document.getElementById('medallion-canvas');
  const titleEl = document.getElementById('medallion-modal-title');
  const tierBadgeEl = document.getElementById('medallion-tier-badge');
  const verseTextEl = document.getElementById('medallion-verse-text');
  const verseRefEl = document.getElementById('medallion-verse-ref');
  const flipBtn = document.getElementById('medallion-flip-btn');
  const shareBtn = document.getElementById('medallion-share-btn');
  const tiersScroll = document.getElementById('medallion-tiers-scroll');

  if (!modal || !backdrop || !canvas || typeof THREE === 'undefined') {
    return;
  }

  const MEDALLION_TIERS = [
    { tier: 1, title: 'Disciple I', roman: 'I', days: 'Days 0–9', metal: 'bronze', verse: '"Thy word is a lamp unto my feet, and a light unto my path."', ref: 'Psalm 119:105' },
    { tier: 2, title: 'Disciple II', roman: 'II', days: 'Days 10–19', metal: 'bronze', verse: '"The law of the Lord is perfect, refreshing the soul."', ref: 'Psalm 19:7' },
    { tier: 3, title: 'Disciple III', roman: 'III', days: 'Days 20–29', metal: 'bronze', verse: '"Your word I have hidden in my heart, that I might not sin against You."', ref: 'Psalm 119:11' },
    { tier: 4, title: 'Disciple IV', roman: 'IV', days: 'Days 30–39', metal: 'silver', verse: '"Awake, my soul! Awake, harp and lyre! I will awaken the dawn."', ref: 'Psalm 57:8' },
    { tier: 5, title: 'Disciple V', roman: 'V', days: 'Days 40–49', metal: 'silver', verse: '"The Lord is my strength and my shield; my heart trusts in Him."', ref: 'Psalm 28:7' },
    { tier: 6, title: 'Disciple VI', roman: 'VI', days: 'Days 50–59', metal: 'silver', verse: '"Those who hope in the Lord will renew their strength; they will soar on wings like eagles."', ref: 'Isaiah 40:31' },
    { tier: 7, title: 'Disciple VII', roman: 'VII', days: 'Days 60–69', metal: 'gold', verse: '"The Lion of the tribe of Judah, the Root of David, has triumphed."', ref: 'Revelation 5:5' },
    { tier: 8, title: 'Disciple VIII', roman: 'VIII', days: 'Days 70–79', metal: 'gold', verse: '"For I know the plans I have for you, declares the Lord, to give you hope and a future."', ref: 'Jeremiah 29:11' },
    { tier: 9, title: 'Disciple IX', roman: 'IX', days: 'Days 80–89', metal: 'gold', verse: '"I am the light of the world. Whoever follows me will never walk in darkness."', ref: 'John 8:12' },
    { tier: 10, title: 'Disciple X', roman: 'X', days: 'Days 90–91', metal: 'electrum', verse: '"I can do all things through Christ who gives me strength."', ref: 'Philippians 4:13' },
    { tier: 11, title: 'Finisher 🏆', roman: '🏆', days: 'Day 92+', metal: 'finisher', verse: '"I have fought the good fight, I have finished the race, I have kept the faith."', ref: '2 Timothy 4:7' }
  ];

  let activeTierIdx = 0;
  let animId = null;
  let isDragging = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let rotX = 0.05, rotY = 0;
  let targetRotY = 0;
  let velX = 0, velY = 0;
  let pointerNormX = 0, pointerNormY = 0;

  // Metal Palettes
  const METAL_PRESETS = {
    bronze: { color: 0x92400e, roughness: 0.35, metalness: 0.50, specular: 0xd97706 },
    silver: { color: 0x64748b, roughness: 0.32, metalness: 0.50, specular: 0xcbd5e1 },
    gold: { color: 0xb45309, roughness: 0.30, metalness: 0.55, specular: 0xf59e0b },
    electrum: { color: 0xa16207, roughness: 0.28, metalness: 0.55, specular: 0xfde047 },
    finisher: { color: 0xb45309, roughness: 0.25, metalness: 0.58, specular: 0xfbbf24 }
  };

  // High-Resolution Procedural Texture Generator
  function createMedallionTexture(tierData, isBack) {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 1024;
    const ctx = c.getContext('2d');

    const isGold = tierData.metal === 'gold' || tierData.metal === 'electrum' || tierData.metal === 'finisher';
    const isSilver = tierData.metal === 'silver';

    // Base background radial gradient (deep burnished antique metallic field)
    const grad = ctx.createRadialGradient(512, 512, 30, 512, 512, 505);
    if (isGold) {
      grad.addColorStop(0, '#d97706');
      grad.addColorStop(0.3, '#b45309');
      grad.addColorStop(0.65, '#92400e');
      grad.addColorStop(0.85, '#78350f');
      grad.addColorStop(1, '#451a03');
    } else if (isSilver) {
      // Deep burnished antique silver / pewter (perceptual 50% middle ground)
      grad.addColorStop(0, '#94a3b8');
      grad.addColorStop(0.28, '#64748b');
      grad.addColorStop(0.62, '#475569');
      grad.addColorStop(0.85, '#334155');
      grad.addColorStop(1, '#1e293b');
    } else {
      grad.addColorStop(0, '#d97706');
      grad.addColorStop(0.3, '#b45309');
      grad.addColorStop(0.65, '#92400e');
      grad.addColorStop(0.85, '#78350f');
      grad.addColorStop(1, '#3b1704');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(512, 512, 500, 0, Math.PI * 2);
    ctx.fill();

    // Concentric hairline etched rings
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(512, 512, 485, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(512, 512, 478, 0, Math.PI * 2);
    ctx.stroke();

    // 64 Beaded rim pearls
    const beadCount = 64;
    for (let b = 0; b < beadCount; b++) {
      const angle = (b / beadCount) * Math.PI * 2;
      const bx = 512 + Math.cos(angle) * 455;
      const by = 512 + Math.sin(angle) * 455;
      const beadGrad = ctx.createRadialGradient(bx - 2, by - 2, 1, bx, by, 7);
      beadGrad.addColorStop(0, '#cbd5e1');
      beadGrad.addColorStop(0.5, isGold ? '#d97706' : isSilver ? '#64748b' : '#b45309');
      beadGrad.addColorStop(1, '#0f172a');
      ctx.fillStyle = beadGrad;
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Recessed Circular Legend Track for perimeter text
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.lineWidth = 76;
    ctx.beginPath();
    ctx.arc(512, 512, 396, 0, Math.PI * 2);
    ctx.stroke();

    // Boundary rings of legend track
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(512, 512, 434, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(512, 512, 358, 0, Math.PI * 2);
    ctx.stroke();

    // Inner field border ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(512, 512, 354, 0, Math.PI * 2);
    ctx.stroke();

    // Curved circular text with crisp white fill on darker track
    const textStr = isBack
      ? '★ 2 TIMOTHY 4:7 ★ I HAVE KEPT THE FAITH ★ YOUTH GATHERING 2026 ★'
      : '★ PROJECT BIBLE IN 92 DAYS ★ THE YOUTH GATHERING 2026 ★';

    ctx.save();
    ctx.font = 'bold 36px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.lineWidth = 4;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    const angleStep = (Math.PI * 1.7) / textStr.length;
    const startAngle = -Math.PI * 0.85;

    for (let i = 0; i < textStr.length; i++) {
      const charAngle = startAngle + i * angleStep;
      ctx.save();
      ctx.translate(512, 512);
      ctx.rotate(charAngle);
      ctx.translate(0, -396);
      ctx.strokeText(textStr[i], 0, 0);
      ctx.fillText(textStr[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // Central Core Artwork
    if (!isBack) {
      ctx.save();
      ctx.translate(512, 512);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Roman numeral: bold brilliant face with subtle metallic sheen
      const numGrad = ctx.createLinearGradient(0, -110, 0, 70);
      numGrad.addColorStop(0, '#ffffff');
      numGrad.addColorStop(0.65, isSilver ? '#f1f5f9' : isGold ? '#fef08a' : '#fed7aa');
      numGrad.addColorStop(1, isSilver ? '#cbd5e1' : isGold ? '#f59e0b' : '#d97706');

      ctx.font = tierData.roman === '🏆' ? '190px serif' : 'bold 205px "Fraunces", serif';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.lineWidth = 5.5;
      ctx.strokeText(tierData.roman, 0, -25);

      ctx.fillStyle = numGrad;
      ctx.fillText(tierData.roman, 0, -25);

      // Tier Title: Crisp white bold lettering
      ctx.font = 'bold 42px "Space Grotesk", sans-serif';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.lineWidth = 4.5;
      ctx.strokeText(tierData.title.toUpperCase(), 0, 105);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(tierData.title.toUpperCase(), 0, 105);

      // Subtitle
      ctx.font = '700 24px "Space Grotesk", sans-serif';
      ctx.shadowBlur = 6;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.lineWidth = 3.5;
      ctx.strokeText('DISCIPLESHIP COVENANT', 0, 152);

      ctx.fillStyle = '#ffffff';
      ctx.fillText('DISCIPLESHIP COVENANT', 0, 152);

      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(512, 512);

      ctx.fillStyle = isGold ? '#f59e0b' : isSilver ? '#94a3b8' : '#d97706';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.lineWidth = 4.5;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 3;

      ctx.strokeRect(-16, -210, 32, 170);
      ctx.fillRect(-16, -210, 32, 170);
      ctx.strokeRect(-80, -170, 160, 30);
      ctx.fillRect(-80, -170, 160, 30);

      ctx.textAlign = 'center';
      ctx.font = 'italic 600 30px "Fraunces", serif';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.lineWidth = 4.5;
      ctx.shadowBlur = 6;

      ctx.strokeText('"I have fought the good fight,', 0, 20);
      ctx.fillText('"I have fought the good fight,', 0, 20);
      ctx.strokeText('I have finished the race,', 0, 65);
      ctx.fillText('I have finished the race,', 0, 65);
      ctx.strokeText('I have kept the faith."', 0, 110);
      ctx.fillText('I have kept the faith."', 0, 110);

      ctx.font = 'bold 26px "Space Grotesk", sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.lineWidth = 4;
      ctx.strokeText('— 2 TIMOTHY 4:7 —', 0, 170);
      ctx.fillText('— 2 TIMOTHY 4:7 —', 0, 170);

      ctx.restore();
    }

    return new THREE.CanvasTexture(c);
  }

  // Create Bump Map Canvas for High-Relief 3D Embossing
  function createMedallionBumpMap(tierData, isBack) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 512, 512);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(256, 256, 240, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#404040';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 256, 220, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.translate(256, 256);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (!isBack) {
      ctx.font = tierData.roman === '🏆' ? '90px serif' : 'bold 95px "Fraunces", serif';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 6;
      ctx.fillText(tierData.roman, 0, -10);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-10, -105, 20, 95);
      ctx.fillRect(-45, -85, 90, 18);
    }
    ctx.restore();

    return new THREE.CanvasTexture(c);
  }

  let mRenderer, mScene, mCamera;
  let medallionGroup, frontMesh, backMesh, rimMesh, bezelMesh, bailMesh, ribbonMesh;
  let specularLight, keyLight, rimLight;

  function getMaxUnlockedTier() {
    const session = getSession();
    if (!session || session.isGuest) return 1;
    const days = getUserDaysCompleted();
    const info = getLevelProgressInfo(days);
    return info.currentLevelNum || 1;
  }

  try {
    const width = 400;
    const height = 400;

    mRenderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    mRenderer.setSize(width, height);
    mRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    mScene = new THREE.Scene();
    mCamera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    mCamera.position.set(0, 0, 8.2);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    mScene.add(ambientLight);

    keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(3, 4, 6);
    mScene.add(keyLight);

    rimLight = new THREE.DirectionalLight(0xf59e0b, 1.2);
    rimLight.position.set(-4, -2, -4);
    mScene.add(rimLight);

    specularLight = new THREE.PointLight(0xffffff, 2.2, 18);
    specularLight.position.set(0, 0, 5);
    mScene.add(specularLight);

    medallionGroup = new THREE.Group();
    mScene.add(medallionGroup);

    // Geometry components
    const coinRadius = 2.4;
    const coinThickness = 0.22;

    // Front Face Disc
    const frontGeom = new THREE.CircleGeometry(coinRadius, 64);
    const frontMat = new THREE.MeshStandardMaterial({
      roughness: 0.32,
      metalness: 0.35
    });
    frontMesh = new THREE.Mesh(frontGeom, frontMat);
    frontMesh.position.z = coinThickness / 2 + 0.005;
    medallionGroup.add(frontMesh);

    // Back Face Disc
    const backGeom = new THREE.CircleGeometry(coinRadius, 64);
    const backMat = new THREE.MeshStandardMaterial({
      roughness: 0.32,
      metalness: 0.35
    });
    backMesh = new THREE.Mesh(backGeom, backMat);
    backMesh.rotation.y = Math.PI;
    backMesh.position.z = -(coinThickness / 2 + 0.005);
    medallionGroup.add(backMesh);

    // Edge Cylinder Rim
    const rimGeom = new THREE.CylinderGeometry(coinRadius, coinRadius, coinThickness, 64, 1, true);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xcd7f32,
      roughness: 0.32,
      metalness: 0.55
    });
    rimMesh = new THREE.Mesh(rimGeom, rimMat);
    rimMesh.rotation.x = Math.PI / 2;
    medallionGroup.add(rimMesh);

    // Beaded Bezel Rim
    const bezelGeom = new THREE.TorusGeometry(coinRadius + 0.04, 0.08, 16, 64);
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0xcd7f32,
      roughness: 0.28,
      metalness: 0.55
    });
    bezelMesh = new THREE.Mesh(bezelGeom, bezelMat);
    medallionGroup.add(bezelMesh);

    // Top Suspension Bail Loop
    const bailGeom = new THREE.TorusGeometry(0.38, 0.07, 16, 32);
    const bailMat = new THREE.MeshStandardMaterial({
      color: 0xcd7f32,
      roughness: 0.28,
      metalness: 0.55
    });
    bailMesh = new THREE.Mesh(bailGeom, bailMat);
    bailMesh.position.y = coinRadius + 0.32;
    medallionGroup.add(bailMesh);

    // Liturgical Split-Tail Fabric Ribbon at top
    const ribbonGeom = new THREE.PlaneGeometry(1.6, 2.2, 8, 8);
    const ribbonMat = new THREE.MeshStandardMaterial({
      color: 0x881337,
      roughness: 0.65,
      metalness: 0.15,
      side: THREE.DoubleSide
    });
    ribbonMesh = new THREE.Mesh(ribbonGeom, ribbonMat);
    ribbonMesh.position.set(0, coinRadius + 1.25, -0.15);
    medallionGroup.add(ribbonMesh);

    function applyTierTextures(tierData) {
      const frontTex = createMedallionTexture(tierData, false);
      const backTex = createMedallionTexture(tierData, true);
      const frontBump = createMedallionBumpMap(tierData, false);
      const backBump = createMedallionBumpMap(tierData, true);

      const metal = METAL_PRESETS[tierData.metal] || METAL_PRESETS.bronze;

      frontMesh.material.map = frontTex;
      frontMesh.material.bumpMap = frontBump;
      frontMesh.material.bumpScale = 0.025;
      frontMesh.material.color.setHex(0xffffff);
      frontMesh.material.roughness = 0.32;
      frontMesh.material.metalness = 0.35;
      frontMesh.material.needsUpdate = true;

      backMesh.material.map = backTex;
      backMesh.material.bumpMap = backBump;
      backMesh.material.bumpScale = 0.025;
      backMesh.material.color.setHex(0xffffff);
      backMesh.material.roughness = 0.32;
      backMesh.material.metalness = 0.35;
      backMesh.material.needsUpdate = true;

      rimMesh.material.color.setHex(metal.color);
      rimMesh.material.roughness = metal.roughness;
      rimMesh.material.metalness = metal.metalness;
      rimMesh.material.needsUpdate = true;

      bezelMesh.material.color.setHex(metal.color);
      bezelMesh.material.roughness = metal.roughness;
      bezelMesh.material.metalness = metal.metalness;
      bezelMesh.material.needsUpdate = true;

      bailMesh.material.color.setHex(metal.color);
      bailMesh.material.roughness = metal.roughness;
      bailMesh.material.metalness = metal.metalness;
      bailMesh.material.needsUpdate = true;

      rimLight.color.setHex(metal.specular);

      const isBlueRibbon = tierData.metal === 'silver' || tierData.metal === 'electrum';
      ribbonMesh.material.color.setHex(isBlueRibbon ? 0x1e3a8a : 0x881337);
      ribbonMesh.material.needsUpdate = true;

      if (titleEl) titleEl.textContent = `${tierData.title} Medallion`;
      if (tierBadgeEl) {
        tierBadgeEl.textContent = `${tierData.days} • ${tierData.metal.toUpperCase()}`;
      }
      if (verseTextEl) verseTextEl.textContent = tierData.verse;
      if (verseRefEl) verseRefEl.textContent = tierData.ref;

      const allPills = tiersScroll ? tiersScroll.querySelectorAll('.medallion-tier-pill') : [];
      allPills.forEach((p, idx) => {
        if (!p.classList.contains('locked')) {
          p.classList.toggle('active', idx === activeTierIdx);
        }
      });
    }

    // Build Tier Selector with strict access gating
    function buildTierSelector() {
      if (!tiersScroll) return;
      tiersScroll.innerHTML = '';
      const maxUnlocked = getMaxUnlockedTier();

      MEDALLION_TIERS.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isUnlocked = (item.tier <= maxUnlocked);

        if (isUnlocked) {
          btn.className = 'medallion-tier-pill' + (idx === activeTierIdx ? ' active' : '');
          btn.textContent = item.roman === '🏆' ? '🏆 Finisher' : `Tier ${item.roman}`;
          btn.setAttribute('aria-label', `Inspect ${item.title}`);
          btn.addEventListener('click', () => {
            activeTierIdx = idx;
            applyTierTextures(MEDALLION_TIERS[activeTierIdx]);
            targetRotY = rotY + 0.4;
            if (typeof playMedallionChime === 'function') {
              playMedallionChime();
            }
          });
        } else {
          btn.className = 'medallion-tier-pill locked';
          btn.textContent = item.roman === '🏆' ? '🔒 Finisher' : `🔒 Tier ${item.roman}`;
          const reqDays = item.tier === 11 ? 92 : (item.tier - 1) * 10;
          btn.title = `Locked: Complete ${reqDays} days of reading to unlock`;
          btn.setAttribute('aria-label', `Locked: ${item.title} requires ${reqDays} days`);
          btn.addEventListener('click', () => {
            showNudgeToast(`🔒 ${item.title} is locked! Complete ${reqDays} reading days to unlock this medallion.`, true);
          });
        }
        tiersScroll.appendChild(btn);
      });
    }

    buildTierSelector();
    window.updateMedallionUnlockedTiers = buildTierSelector;

    // Interactive pointer drag controls
    function onPointerDown(e) {
      isDragging = true;
      startX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      startY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      lastX = startX;
      lastY = startY;
      velX = 0;
      velY = 0;
    }

    function onPointerMove(e) {
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

      const rect = canvas.getBoundingClientRect();
      pointerNormX = ((clientX - rect.left) / rect.width - 0.5) * 2;
      pointerNormY = ((clientY - rect.top) / rect.height - 0.5) * 2;

      specularLight.position.x = pointerNormX * 4;
      specularLight.position.y = -pointerNormY * 4;

      if (!isDragging) return;

      const dx = clientX - lastX;
      const dy = clientY - lastY;
      lastX = clientX;
      lastY = clientY;

      velY = dx * 0.007;
      velX = dy * 0.007;

      rotY += velY;
      rotX += velX;
      targetRotY = rotY;
    }

    function onPointerUp() {
      isDragging = false;
    }

    canvas.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    canvas.addEventListener('touchstart', onPointerDown, { passive: true });
    window.addEventListener('touchmove', onPointerMove, { passive: true });
    window.addEventListener('touchend', onPointerUp, { passive: true });

    // Flip Medallion button
    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        targetRotY += Math.PI;
      });
    }

    // Share Medallion as High-Resolution Image Card (Vanilla Canvas 2D)
    async function shareMedallionCard() {
      const tierData = MEDALLION_TIERS[activeTierIdx];
      const curDays = getUserDaysCompleted();
      const session = getSession();
      const discipleName = (session && !session.isGuest && session.username) ? session.username : 'Youth Disciple';

      const shareCanvas = document.createElement('canvas');
      shareCanvas.width = 1080;
      shareCanvas.height = 1080;
      const ctx = shareCanvas.getContext('2d');

      // 1. Deep Celestial Space Gradient Background
      const bgGrad = ctx.createRadialGradient(540, 480, 80, 540, 540, 720);
      bgGrad.addColorStop(0, '#1e1b4b');
      bgGrad.addColorStop(0.4, '#0f172a');
      bgGrad.addColorStop(0.85, '#070913');
      bgGrad.addColorStop(1, '#020408');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, 1080, 1080);

      // 2. Decorative Double Gold Frame
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
      ctx.lineWidth = 3;
      ctx.strokeRect(36, 36, 1008, 1008);

      ctx.strokeStyle = 'rgba(245, 158, 11, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(46, 46, 988, 988);

      const drawCorner = (x, y, sx, sy) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(sx, sy);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, 32);
        ctx.lineTo(0, 0);
        ctx.lineTo(32, 0);
        ctx.stroke();
        ctx.restore();
      };
      drawCorner(36, 36, 1, 1);
      drawCorner(1044, 36, -1, 1);
      drawCorner(36, 1044, 1, -1);
      drawCorner(1044, 1044, -1, -1);

      // 3. Top Branding & Header
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px "Space Grotesk", sans-serif';
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('THE YOUTH GATHERING 2026', 540, 95);

      ctx.font = 'bold 40px "Fraunces", serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('Project Bible in 92 Days', 540, 145);

      // Disciple Milestone Pill
      const pillText = `${discipleName.toUpperCase()} • ${tierData.title.toUpperCase()}`;
      ctx.font = '600 20px "Space Grotesk", sans-serif';
      const pWidth = ctx.measureText(pillText).width + 44;
      ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(540 - pWidth / 2, 175, pWidth, 38, 19);
      } else {
        ctx.rect(540 - pWidth / 2, 175, pWidth, 38);
      }
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fef08a';
      ctx.fillText(pillText, 540, 201);

      // 4. Medallion Ambient Halo Glow & Snapshot
      const isSilverMedal = tierData.metal === 'silver';
      const isBronzeMedal = tierData.metal === 'bronze';
      const glowGrad = ctx.createRadialGradient(540, 475, 40, 540, 475, 275);
      if (isSilverMedal) {
        glowGrad.addColorStop(0, 'rgba(147, 197, 253, 0.30)');
        glowGrad.addColorStop(0.4, 'rgba(96, 165, 250, 0.14)');
        glowGrad.addColorStop(0.75, 'rgba(30, 58, 138, 0.05)');
      } else if (isBronzeMedal) {
        glowGrad.addColorStop(0, 'rgba(251, 146, 60, 0.35)');
        glowGrad.addColorStop(0.4, 'rgba(217, 119, 6, 0.18)');
        glowGrad.addColorStop(0.75, 'rgba(120, 53, 15, 0.05)');
      } else {
        glowGrad.addColorStop(0, 'rgba(254, 240, 138, 0.35)');
        glowGrad.addColorStop(0.4, 'rgba(245, 158, 11, 0.18)');
        glowGrad.addColorStop(0.75, 'rgba(146, 64, 14, 0.05)');
      }
      glowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(540, 475, 275, 0, Math.PI * 2);
      ctx.fill();

      // Ensure crisp, radiant, front-facing middle-ground rendering for the share card
      const savedMedRotX = medallionGroup.rotation.x;
      const savedMedRotY = medallionGroup.rotation.y;
      const savedMedRotZ = medallionGroup.rotation.z;
      const savedAmbInt = ambientLight.intensity;
      const savedKeyInt = keyLight.intensity;
      const savedKeyPos = keyLight.position.clone();
      const savedSpecInt = specularLight.intensity;
      const savedSpecPos = specularLight.position.clone();

      // Position medal front-facing with calibrated middle-ground lighting (lower brightness)
      medallionGroup.rotation.set(0.04, -0.02, 0);
      ambientLight.intensity = 0.35;
      keyLight.intensity = 0.65;
      keyLight.position.set(2.5, 3.5, 4.5);
      specularLight.intensity = 0.25;
      specularLight.position.set(1.6, 2.0, 4.5);

      try {
        mRenderer.setSize(800, 800, false);
        mCamera.aspect = 1;
        mCamera.updateProjectionMatrix();
        mRenderer.render(mScene, mCamera);
        ctx.drawImage(canvas, 540 - 240, 475 - 240, 480, 480);
      } catch (e) {
        const fallbackTex = createMedallionTexture(tierData, false).image;
        if (fallbackTex) {
          ctx.drawImage(fallbackTex, 540 - 220, 475 - 220, 440, 440);
        }
      } finally {
        mRenderer.setSize(400, 400, false);
        mCamera.aspect = 1;
        mCamera.updateProjectionMatrix();
        medallionGroup.rotation.set(savedMedRotX, savedMedRotY, savedMedRotZ);
        ambientLight.intensity = savedAmbInt;
        keyLight.intensity = savedKeyInt;
        keyLight.position.copy(savedKeyPos);
        specularLight.intensity = savedSpecInt;
        specularLight.position.copy(savedSpecPos);
      }

      // 5. Inscribed Scripture Verse
      ctx.font = 'italic 28px "Fraunces", serif';
      ctx.fillStyle = '#f8fafc';
      const wrapText = (text, maxWidth) => {
        const words = text.split(' ');
        const lines = [];
        let curLine = '';
        words.forEach(w => {
          const testLine = curLine ? curLine + ' ' + w : w;
          if (ctx.measureText(testLine).width > maxWidth) {
            lines.push(curLine);
            curLine = w;
          } else {
            curLine = testLine;
          }
        });
        if (curLine) lines.push(curLine);
        return lines;
      };

      const verseLines = wrapText(tierData.verse, 860);
      let curY = 760;
      verseLines.forEach(vl => {
        ctx.fillText(vl, 540, curY);
        curY += 38;
      });

      ctx.font = 'bold 22px "Space Grotesk", sans-serif';
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(`— ${tierData.ref} —`, 540, curY + 12);

      // 6. Footer Stats & URL (clean URL without redundant verse)
      ctx.font = '600 20px "Space Grotesk", sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${curDays} of 92 Days Completed • August 10 – November 9, 2026`, 540, 975);

      ctx.font = '500 16px "Space Grotesk", sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillText('paulzhub.github.io/Bible-in-92-Days', 540, 1005);

      // 7. Output / Native Web Share or Download
      shareCanvas.toBlob(async (blob) => {
        if (!blob) return;
        const fileName = `Bible92-Medallion-${tierData.title.replace(/\s+/g, '-')}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              title: `${tierData.title} Discipleship Medallion`,
              text: `I've unlocked the ${tierData.title} on Project Bible in 92 Days! ${tierData.verse} (${tierData.ref})`,
              files: [file]
            });
            return;
          } catch (err) {
            if (err.name === 'AbortError') return;
          }
        }

        // Fallback file download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showNudgeToast(`✓ Medallion card downloaded! Share it with your squad.`);
      }, 'image/png');
    }

    if (shareBtn) {
      shareBtn.addEventListener('click', shareMedallionCard);
    }

    // Medallion Animation Loop
    function medallionRenderLoop(t) {
      if (modal.hidden) {
        animId = null;
        return;
      }

      if (!isDragging) {
        rotY += (targetRotY - rotY) * 0.12;
        rotY += velY;
        rotX += velX;
        velY *= 0.93;
        velX *= 0.93;

        medallionGroup.position.y = Math.sin(t * 0.0025) * 0.08;
      }

      rotX = Math.max(-0.65, Math.min(0.65, rotX));

      medallionGroup.rotation.y = rotY;
      medallionGroup.rotation.x = rotX;

      mRenderer.render(mScene, mCamera);
      animId = requestAnimationFrame(medallionRenderLoop);
    }

    function openMedallionModal(tierNum) {
      const maxUnlocked = getMaxUnlockedTier();
      let targetTier = typeof tierNum === 'number' ? tierNum : maxUnlocked;
      if (targetTier > maxUnlocked) {
        targetTier = maxUnlocked;
      }

      const idx = Math.min(MEDALLION_TIERS.length - 1, Math.max(0, targetTier - 1));
      activeTierIdx = idx;

      buildTierSelector();
      applyTierTextures(MEDALLION_TIERS[activeTierIdx]);

      rotX = 0.08;
      rotY = 0;
      targetRotY = 0;
      velX = 0;
      velY = 0;

      modal.hidden = false;
      backdrop.hidden = false;
      requestAnimationFrame(() => {
        modal.classList.add('active');
        backdrop.classList.add('active');
        if (typeof playMedallionChime === 'function') {
          playMedallionChime();
        }
      });

      if (!animId) {
        animId = requestAnimationFrame(medallionRenderLoop);
      }
    }

    function closeMedallionModal() {
      modal.classList.remove('active');
      backdrop.classList.remove('active');
      setTimeout(() => {
        modal.hidden = true;
        backdrop.hidden = true;
        if (animId) {
          cancelAnimationFrame(animId);
          animId = null;
        }
      }, 300);
    }

    if (closeBtn) closeBtn.addEventListener('click', closeMedallionModal);
    if (backdrop) backdrop.addEventListener('click', closeMedallionModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) {
        closeMedallionModal();
      } else if (!modal.hidden) {
        if (e.key === 'ArrowLeft') {
          targetRotY -= 0.5;
        } else if (e.key === 'ArrowRight') {
          targetRotY += 0.5;
        }
      }
    });

    // Expose global hook
    window.openLevelMedallion = openMedallionModal;
    window.closeLevelMedallion = closeMedallionModal;

  } catch (err) {
    console.warn('3D Medallion initialization notice:', err);
  }
}

// ====== 3D PERSPECTIVE GYRO CARD TILT & DYNAMIC SPECULAR SHEEN ======

let kineticCardsList = [];
let kineticTiltInitialized = false;

function initKineticCardTilt() {
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  // Ensure section-today is cleared of tilt and sheen
  const sectionToday = document.getElementById('section-today');
  if (sectionToday) {
    sectionToday.classList.remove('kinetic-tilt-card', 'is-hovered');
    sectionToday.style.transform = '';
    sectionToday.style.boxShadow = '';
    const oldSheen = sectionToday.querySelector('.kinetic-sheen');
    if (oldSheen) oldSheen.remove();
  }

  const cardSelectors = [
    '#boys-vs-girls-card',
    '#section-level-progress',
    '#section-heatmap',
    '#section-all-time',
    '#public-today-preview'
  ];

  cardSelectors.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;

    let existing = kineticCardsList.find(c => c.el === el);
    let sheen = el.querySelector('.kinetic-sheen');
    if (!sheen) {
      sheen = document.createElement('div');
      sheen.className = 'kinetic-sheen';
      sheen.setAttribute('aria-hidden', 'true');
      el.insertBefore(sheen, el.firstChild);
    }

    if (!el.classList.contains('kinetic-tilt-card')) {
      el.classList.add('kinetic-tilt-card');
    }

    if (!existing) {
      const cardObj = {
        el,
        sheen,
        isHovered: false,
        targetRx: 0,
        targetRy: 0,
        targetTz: 0,
        targetSheenX: 50,
        targetSheenY: 50,
        targetSheenOpacity: 0,
        currentRx: 0,
        currentRy: 0,
        currentTz: 0,
        currentSheenX: 50,
        currentSheenY: 50,
        currentSheenOpacity: 0,
        scrollPitchX: 0,
        needsUpdate: true
      };

      const maxTilt = 10.5;

      function handlePointerMove(e) {
        cardObj.isHovered = true;
        el.classList.add('is-hovered');
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const normX = (x / rect.width) * 2 - 1;
        const normY = (y / rect.height) * 2 - 1;

        cardObj.targetRx = -normY * maxTilt;
        cardObj.targetRy = normX * maxTilt;
        cardObj.targetTz = 8;
        cardObj.targetSheenX = (x / rect.width) * 100;
        cardObj.targetSheenY = (y / rect.height) * 100;
        cardObj.targetSheenOpacity = 1;
        cardObj.needsUpdate = true;
      }

      function handlePointerLeave() {
        cardObj.isHovered = false;
        el.classList.remove('is-hovered');
        cardObj.targetRx = 0;
        cardObj.targetRy = 0;
        cardObj.targetTz = 0;
        cardObj.targetSheenOpacity = 0;
        cardObj.needsUpdate = true;
      }

      el.addEventListener('pointerenter', handlePointerMove, { passive: true });
      el.addEventListener('pointermove', handlePointerMove, { passive: true });
      el.addEventListener('pointerleave', handlePointerLeave, { passive: true });

      kineticCardsList.push(cardObj);
    } else {
      existing.sheen = sheen;
      existing.needsUpdate = true;
    }
  });

  if (kineticTiltInitialized) return;
  kineticTiltInitialized = true;

  let gyroPitchX = 0;
  let gyroRollY = 0;
  let hasGyro = false;

  if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission !== 'function') {
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma !== null && e.beta !== null) {
        hasGyro = true;
        const roll = Math.max(-1, Math.min(1, e.gamma / 20));
        const pitch = Math.max(-1, Math.min(1, (e.beta - 45) / 25));
        gyroRollY = roll * 6.5;
        gyroPitchX = -pitch * 5.0;
        kineticCardsList.forEach((card) => { card.needsUpdate = true; });
      }
    }, { passive: true });
  }

  function updateScrollParallax() {
    const vhHalf = window.innerHeight / 2;
    kineticCardsList.forEach((c) => {
      const rect = c.el.getBoundingClientRect();
      if (rect.bottom >= -100 && rect.top <= window.innerHeight + 100) {
        const cardCenterY = rect.top + rect.height / 2;
        const normDist = (cardCenterY - vhHalf) / vhHalf;
        const clampedDist = Math.max(-1, Math.min(1, normDist));
        c.scrollPitchX = clampedDist * -2.5;
        c.needsUpdate = true;
      }
    });
  }

  if (typeof lenisInstance !== 'undefined' && lenisInstance) {
    lenisInstance.on('scroll', updateScrollParallax);
  } else {
    window.addEventListener('scroll', updateScrollParallax, { passive: true });
  }
  updateScrollParallax();

  const lerpFactor = 0.14;
  const sheenLerp = 0.18;

  function tick() {
    kineticCardsList.forEach((c) => {
      const effectiveRx = c.targetRx + c.scrollPitchX + (hasGyro && !c.isHovered ? gyroPitchX : 0);
      const effectiveRy = c.targetRy + (hasGyro && !c.isHovered ? gyroRollY : 0);
      const effectiveTz = c.targetTz;
      const effectiveSheenOpacity = c.targetSheenOpacity;

      const diffRx = effectiveRx - c.currentRx;
      const diffRy = effectiveRy - c.currentRy;
      const diffTz = effectiveTz - c.currentTz;
      const diffSheenOp = effectiveSheenOpacity - c.currentSheenOpacity;
      const diffSheenX = c.targetSheenX - c.currentSheenX;
      const diffSheenY = c.targetSheenY - c.currentSheenY;

      const isMoving = Math.abs(diffRx) > 0.01 || Math.abs(diffRy) > 0.01 ||
                       Math.abs(diffTz) > 0.05 || Math.abs(diffSheenOp) > 0.005 ||
                       Math.abs(diffSheenX) > 0.1 || Math.abs(diffSheenY) > 0.1;

      if (isMoving || c.needsUpdate) {
        c.currentRx += diffRx * lerpFactor;
        c.currentRy += diffRy * lerpFactor;
        c.currentTz += diffTz * lerpFactor;
        c.currentSheenOpacity += diffSheenOp * sheenLerp;
        c.currentSheenX += diffSheenX * sheenLerp;
        c.currentSheenY += diffSheenY * sheenLerp;

        const rx = c.currentRx.toFixed(2);
        const ry = c.currentRy.toFixed(2);
        const tz = c.currentTz.toFixed(1);
        const sx = c.currentSheenX.toFixed(1);
        const sy = c.currentSheenY.toFixed(1);
        const sop = c.currentSheenOpacity.toFixed(3);

        c.el.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(${tz}px)`;

        c.sheen.style.setProperty('--sheen-x', `${sx}%`);
        c.sheen.style.setProperty('--sheen-y', `${sy}%`);
        c.sheen.style.opacity = sop;

        const shadowX = (-ry * 1.3).toFixed(1);
        const shadowY = (rx * 1.3 + 18).toFixed(1);
        const shadowBlur = (26 + Math.abs(tz * 2)).toFixed(0);
        c.el.style.boxShadow = `${shadowX}px ${shadowY}px ${shadowBlur}px -12px rgba(0, 0, 0, 0.58)`;

        if (!isMoving && !c.isHovered && !hasGyro) {
          c.needsUpdate = false;
        }
      }
    });
  }

  if (typeof gsap !== 'undefined' && gsap.ticker) {
    gsap.ticker.add(tick);
  } else {
    function loop() {
      tick();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  window.kineticTiltCards = kineticCardsList;
}

// ====== "LIVING INK" SCRIPTURE TYPOGRAPHY REVEAL ======

let livingInkTimeline = null;
let livingInkHasTriggered = false;
let userHasInitiatedScroll = false;

window._livingInkHasRevealedOnce = false;

function onLivingInkUserScroll() {
  userHasInitiatedScroll = true;
}
window.addEventListener('scroll', onLivingInkUserScroll, { passive: true });
if (typeof lenisInstance !== 'undefined' && lenisInstance) {
  lenisInstance.on('scroll', onLivingInkUserScroll);
}

function primeLivingInkVerse(verseEl, refEl) {
  if (!verseEl) verseEl = document.getElementById('key-verse-text');
  if (!refEl) refEl = document.getElementById('key-verse-ref');
  if (!verseEl) return;

  const rawText = (verseEl.getAttribute('data-raw-verse') || verseEl.textContent || '').trim();
  if (!rawText) return;

  verseEl.setAttribute('aria-label', rawText.replace(/^"|"$/g, ''));
  verseEl.setAttribute('data-raw-verse', rawText);

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    verseEl.textContent = rawText;
    if (refEl) {
      refEl.style.opacity = '1';
      refEl.style.transform = 'none';
      refEl.style.filter = 'none';
    }
    return;
  }

  if (livingInkTimeline) {
    livingInkTimeline.kill();
    livingInkTimeline = null;
  }

  verseEl.innerHTML = '';
  const tokens = rawText.split(/(\s+)/);
  const charSpans = [];

  tokens.forEach((token) => {
    if (/^\s+$/.test(token)) {
      const spaceSpan = document.createElement('span');
      spaceSpan.className = 'living-ink-space';
      spaceSpan.innerHTML = token.replace(/ /g, '&nbsp;');
      verseEl.appendChild(spaceSpan);
    } else {
      const wordSpan = document.createElement('span');
      wordSpan.className = 'living-ink-word';
      for (let i = 0; i < token.length; i++) {
        const charSpan = document.createElement('span');
        charSpan.className = 'living-ink-char';
        charSpan.textContent = token[i];
        charSpan.style.opacity = '0';
        charSpan.style.filter = 'blur(4px)';
        charSpan.style.transform = 'translateY(3px) scale(0.95)';
        charSpan.style.color = '#FDE68A';
        charSpan.style.textShadow = '0 0 10px rgba(245, 158, 11, 0.9), 0 0 20px rgba(232, 169, 59, 0.5)';
        wordSpan.appendChild(charSpan);
        charSpans.push(charSpan);
      }
      verseEl.appendChild(wordSpan);
    }
  });

  const quill = document.createElement('span');
  quill.className = 'living-ink-quill';
  quill.innerHTML = '✦';
  quill.setAttribute('aria-hidden', 'true');
  quill.style.opacity = '0';

  if (charSpans.length > 0) {
    charSpans[0].before(quill);
  } else {
    verseEl.appendChild(quill);
  }

  if (refEl) {
    refEl.style.opacity = '0';
    refEl.style.transform = 'translateX(10px)';
    refEl.style.filter = 'blur(4px)';
  }
}

function triggerLivingInkVerseReveal(verseEl, refEl, force = false) {
  if (!verseEl) verseEl = document.getElementById('key-verse-text');
  if (!refEl) refEl = document.getElementById('key-verse-ref');
  if (!verseEl) return;

  const rawText = (verseEl.getAttribute('data-raw-verse') || verseEl.textContent || '').trim();
  if (!rawText) return;

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    verseEl.textContent = rawText;
    if (refEl) {
      refEl.style.opacity = '1';
      refEl.style.transform = 'none';
      refEl.style.filter = 'none';
    }
    window._livingInkHasRevealedOnce = true;
    return;
  }

  let charSpans = Array.from(verseEl.querySelectorAll('.living-ink-char'));
  let quill = verseEl.querySelector('.living-ink-quill');

  if (charSpans.length === 0 || force) {
    primeLivingInkVerse(verseEl, refEl);
    charSpans = Array.from(verseEl.querySelectorAll('.living-ink-char'));
    quill = verseEl.querySelector('.living-ink-quill');
  }

  if (livingInkTimeline) {
    livingInkTimeline.kill();
    livingInkTimeline = null;
  }

  window._livingInkHasRevealedOnce = true;

  if (quill) {
    quill.style.opacity = '1';
  }

  if (typeof gsap !== 'undefined') {
    livingInkTimeline = gsap.timeline({
      onComplete: () => {
        if (quill) {
          gsap.to(quill, {
            opacity: 0,
            scale: 0.2,
            duration: 0.35,
            ease: 'power2.in',
            onComplete: () => {
              if (quill.parentNode) quill.parentNode.removeChild(quill);
            }
          });
        }
      }
    });

    const charStagger = 0.024;
    charSpans.forEach((charSpan, idx) => {
      const startTime = idx * charStagger;
      livingInkTimeline.to(charSpan, {
        opacity: 1,
        filter: 'blur(0px)',
        y: 0,
        scale: 1,
        color: 'inherit',
        textShadow: '0 0 0px transparent',
        duration: 0.32,
        ease: 'power2.out',
        onStart: () => {
          if (quill) charSpan.after(quill);
        }
      }, startTime);
    });

    if (refEl) {
      const finishTime = charSpans.length * charStagger + 0.08;
      livingInkTimeline.to(refEl, {
        opacity: 1,
        x: 0,
        filter: 'blur(0px)',
        duration: 0.65,
        ease: 'power2.out'
      }, finishTime);
    }
  } else {
    charSpans.forEach((cs) => {
      cs.style.opacity = '1';
      cs.style.filter = 'none';
      cs.style.transform = 'none';
      cs.style.color = 'inherit';
      cs.style.textShadow = 'none';
    });
    if (quill && quill.parentNode) quill.parentNode.removeChild(quill);
    if (refEl) {
      refEl.style.opacity = '1';
      refEl.style.transform = 'none';
      refEl.style.filter = 'none';
    }
  }
}

function initLivingInkKeyVerse() {
  const box = document.getElementById('key-verse-box');
  const verseEl = document.getElementById('key-verse-text');
  const refEl = document.getElementById('key-verse-ref');
  const replayBtn = document.getElementById('re-ink-verse-btn');

  if (!box || !verseEl) return;

  if (replayBtn) {
    replayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerLivingInkVerseReveal(verseEl, refEl, true);
    });
  }

  // Prime verse at startup
  primeLivingInkVerse(verseEl, refEl);

  function checkAndTrigger() {
    if (livingInkHasTriggered) return;

    if (!userHasInitiatedScroll && window.scrollY < 20) {
      return;
    }

    const rect = box.getBoundingClientRect();
    if (rect.top <= window.innerHeight * 0.82 && rect.bottom >= 0) {
      livingInkHasTriggered = true;
      triggerLivingInkVerseReveal(verseEl, refEl);
    }
  }

  function onScrollCheck() {
    userHasInitiatedScroll = true;
    checkAndTrigger();
  }

  window.addEventListener('scroll', onScrollCheck, { passive: true });
  if (typeof lenisInstance !== 'undefined' && lenisInstance) {
    lenisInstance.on('scroll', onScrollCheck);
  }

  if (typeof ScrollTrigger !== 'undefined' && typeof gsap !== 'undefined') {
    ScrollTrigger.create({
      trigger: box,
      start: 'top 82%',
      onEnter: () => {
        if (!userHasInitiatedScroll && window.scrollY < 20) {
          return;
        }
        if (!livingInkHasTriggered) {
          livingInkHasTriggered = true;
          triggerLivingInkVerseReveal(verseEl, refEl);
        }
      },
      once: true
    });
  }
}

// Global hooks
window.initKineticCardTilt = initKineticCardTilt;
window.primeLivingInkVerse = primeLivingInkVerse;
window.triggerLivingInkVerseReveal = triggerLivingInkVerseReveal;
window.initLivingInkKeyVerse = initLivingInkKeyVerse;
window.triggerBvgShockwave = triggerBvgShockwave;
window.initBoysVsGirlsRivalryObserver = initBoysVsGirlsRivalryObserver;
window.wireBoysVsGirlsShareButton = wireBoysVsGirlsShareButton;
window.openBoysVsGirlsShareModal = openBoysVsGirlsShareModal;

// ====== INIT ======

initTheme();
initLogin();
initLenisSmoothScroll();
initScrollScrubberRail();
initAmbientCelestialBackground();
initLevelMedallion3D();
initKineticCardTilt();
initLivingInkKeyVerse();
initBoysVsGirlsRivalryObserver();



