// ====== CONFIG ======
// Paste your Apps Script /exec URL here once deployed.
const API_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';

// Challenge window (DD/MM/YY)
const CHALLENGE_START = { d: 10, m: 8, y: 26 };
const CHALLENGE_END = { d: 9, m: 11, y: 26 };

// ====== HELPERS ======

function pad(n) { return String(n).padStart(2, '0'); }

function formatDDMMYY(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)}`;
}

// Fetches from the Apps Script backend with a timeout (so a stuck
// request fails fast instead of hanging) and one quiet retry (so a
// single transient blip — common with Apps Script — doesn't surface
// as a hard error to the user).
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

function getSession() {
  const raw = localStorage.getItem('bible92_session');
  return raw ? JSON.parse(raw) : null;
}

function setSession(session) {
  localStorage.setItem('bible92_session', JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem('bible92_session');
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

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });
}

// ====== LOGIN ======

function initLogin() {
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

    try {
      const res = await apiGet({ action: 'login', username, password });
      if (res.success) {
        const session = { username: res.username, password };
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

function showSite(session) {
  document.getElementById('login-screen').hidden = true;
  const siteEl = document.getElementById('site');
  siteEl.hidden = false;
  siteEl.classList.add('fade-in');
  document.getElementById('welcome-user').textContent = `Hi, ${session.username}`;

  document.getElementById('logout-btn').addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  initMobileMenu();
  initDateDropdown();
  wireUpdateForm(session);
  wireCommentForm(session);
  loadInitialData(session);
  startAutoRefresh(session);
}

// Keeps the leaderboard and comments in sync with manual edits made
// directly in the Google Sheet (e.g. an admin correcting a user's
// entry), without requiring the viewer to do anything themselves.
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

  // Close the dropdown after choosing an action inside it, or when tapping outside.
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
  // default to today (or the latest available date)
  select.value = formatDDMMYY(end);
}

function wireUpdateForm(session) {
  const form = document.getElementById('update-form');
  const feedback = document.getElementById('update-feedback');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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

// ====== COMBINED DATA LOADS ======
// One round trip for the initial page load (today + leaderboard +
// comments), and one for each periodic refresh (leaderboard +
// comments) — instead of firing several separate Apps Script calls
// at once, which was the main source of both the slow loads and the
// occasional "couldn't reach the server" errors.

async function loadInitialData(session) {
  const portionEl = document.getElementById('today-portion');
  const dateEl = document.getElementById('today-date');
  const lbBody = document.getElementById('leaderboard-body');
  const lbError = document.getElementById('leaderboard-error');
  const commentsListEl = document.getElementById('comments-list');

  try {
    const res = await apiGet({ action: 'getInitialData' });

    if (res.today.success) {
      portionEl.textContent = res.today.portion;
      dateEl.textContent = res.today.date;
    } else {
      portionEl.textContent = "No portion listed for today yet — check back soon.";
      dateEl.textContent = res.today.date || '';
    }

    if (res.leaderboard.success) {
      renderLeaderboard(res.leaderboard.leaderboard, session);
      renderPlayground(res.leaderboard.leaderboard);
    } else {
      lbBody.innerHTML = '';
      lbError.textContent = res.leaderboard.error || 'Could not load the leaderboard.';
      lbError.hidden = false;
    }

    if (res.comments.success) {
      commentsCache = res.comments.comments;
      renderComments(session);
      updateCommentFormVisibility(session);
    } else {
      commentsListEl.innerHTML = '<p class="comments-empty">Could not load comments.</p>';
    }
  } catch (err) {
    portionEl.textContent = "Couldn't load today's portion. Check your connection.";
    lbBody.innerHTML = '';
    lbError.textContent = "Couldn't reach the server.";
    lbError.hidden = false;
    commentsListEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
  }
}

async function loadUpdates(session) {
  const lbBody = document.getElementById('leaderboard-body');
  const lbError = document.getElementById('leaderboard-error');

  try {
    const res = await apiGet({ action: 'getUpdates' });
    if (res.leaderboard.success) {
      renderLeaderboard(res.leaderboard.leaderboard, session);
      renderPlayground(res.leaderboard.leaderboard);
    }
    if (res.comments.success) {
      commentsCache = res.comments.comments;
      renderComments(session);
      updateCommentFormVisibility(session);
    }
  } catch (err) {
    // Background refresh — fail quietly and keep the last known-good
    // state on screen rather than interrupting the user.
  }
}

// ====== SECTION 2: LEADERBOARD ======

function renderLeaderboard(rows, session) {
  const body = document.getElementById('leaderboard-body');
  document.getElementById('leaderboard-error').hidden = true;
  body.innerHTML = '';

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const isYou = session && row.username === session.username;
    if (isYou) tr.classList.add('is-you');

    const rankTd = document.createElement('td');
    rankTd.className = 'rank-cell';
    rankTd.textContent = row.rank;

    const readerTd = document.createElement('td');
    readerTd.className = 'reader-cell' + (isYou ? ' is-you' : '');
    readerTd.textContent = row.username;
    if (isYou) {
      const tag = document.createElement('span');
      tag.className = 'you-tag';
      tag.textContent = 'YOU';
      readerTd.appendChild(tag);
    }

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

// ====== SECTION 3: COMMENTS ======

const HEART_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

// Local cache of today's comments, kept in sync with the server but
// mutated instantly on interaction so likes/posts feel immediate
// instead of waiting on a full Apps Script round-trip.
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

function buildCommentElement(comment, session) {
  const isYou = session && comment.username === session.username;
  const liked = session && comment.likedBy.includes(session.username);

  const item = document.createElement('div');
  item.className = 'comment-item' + (isYou ? ' is-you' : '');
  item.dataset.username = comment.username;

  const head = document.createElement('div');
  head.className = 'comment-head';

  const author = document.createElement('span');
  author.className = 'comment-author';
  author.textContent = comment.username;
  if (isYou) {
    const tag = document.createElement('span');
    tag.className = 'you-tag';
    tag.textContent = 'YOU';
    author.appendChild(tag);
  }

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'like-btn' + (liked ? ' liked' : '');
  likeBtn.innerHTML = `${HEART_ICON}<span class="like-count">${comment.likes}</span>`;
  likeBtn.addEventListener('click', () => handleLike(comment.username, session, likeBtn));

  head.append(author, likeBtn);

  const text = document.createElement('p');
  text.className = 'comment-text';
  text.textContent = comment.text;

  item.append(head, text);
  return item;
}

function updateCommentFormVisibility(session) {
  const form = document.getElementById('comment-form');
  const already = document.getElementById('comment-already');
  const hasCommented = session && commentsCache.some(c => c.username === session.username);
  form.hidden = hasCommented;
  already.hidden = !hasCommented;
}

async function handleLike(targetUsername, session, likeBtn) {
  const comment = commentsCache.find(c => c.username === targetUsername);
  if (!comment) return;

  // Optimistic update: flip the heart and count immediately, before the
  // server confirms, so it feels instant. Reconciled/reverted below.
  const wasLiked = comment.likedBy.includes(session.username);
  const countEl = likeBtn.querySelector('.like-count');

  if (wasLiked) {
    comment.likedBy = comment.likedBy.filter(u => u !== session.username);
    comment.likes -= 1;
  } else {
    comment.likedBy.push(session.username);
    comment.likes += 1;
  }
  likeBtn.classList.toggle('liked', !wasLiked);
  countEl.textContent = comment.likes;
  likeBtn.disabled = true;

  try {
    const res = await apiGet({
      action: 'likeComment',
      likerUsername: session.username,
      password: session.password,
      targetUsername
    });
    if (res.success) {
      // Reconcile with the server's actual count in case of a race
      // with someone else liking the same comment at once.
      comment.likes = res.likes;
      comment.likedBy = res.liked
        ? Array.from(new Set([...comment.likedBy, session.username]))
        : comment.likedBy.filter(u => u !== session.username);
      countEl.textContent = comment.likes;
      likeBtn.classList.toggle('liked', res.liked);
    } else {
      revertLike(comment, wasLiked, likeBtn, countEl);
    }
  } catch (err) {
    revertLike(comment, wasLiked, likeBtn, countEl);
  } finally {
    likeBtn.disabled = false;
  }
}

function revertLike(comment, wasLiked, likeBtn, countEl) {
  comment.likes += wasLiked ? 1 : -1;
  countEl.textContent = comment.likes;
  likeBtn.classList.toggle('liked', wasLiked);
}

function wireCommentForm(session) {
  const form = document.getElementById('comment-form');
  const already = document.getElementById('comment-already');
  const feedback = document.getElementById('comment-feedback');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    feedback.hidden = true;
    const textarea = document.getElementById('comment-input');
    const text = textarea.value.trim();
    if (!text) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    // Optimistic post: show it and hide the form right away.
    const optimisticComment = { username: session.username, text, likes: 0, likedBy: [] };
    commentsCache.push(optimisticComment);
    document.getElementById('comments-list').appendChild(buildCommentElement(optimisticComment, session));
    document.querySelector('.comments-empty')?.remove();
    textarea.value = '';
    form.hidden = true;
    already.hidden = false;

    try {
      const res = await apiGet({
        action: 'postComment',
        username: session.username,
        password: session.password,
        text
      });
      if (!res.success) {
        // Roll back the optimistic comment and let them try again.
        commentsCache = commentsCache.filter(c => c !== optimisticComment);
        renderComments(session);
        form.hidden = false;
        already.hidden = true;
        textarea.value = text;
        feedback.hidden = false;
        feedback.textContent = res.error || 'Something went wrong.';
        feedback.className = 'form-feedback error';
      }
    } catch (err) {
      commentsCache = commentsCache.filter(c => c !== optimisticComment);
      renderComments(session);
      form.hidden = false;
      already.hidden = true;
      textarea.value = text;
      feedback.hidden = false;
      feedback.textContent = "Couldn't reach the server. Try again.";
      feedback.className = 'form-feedback error';
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ====== SECTION 4: PROGRESS PLAYGROUND ======

// Fixed, consistent color per reader.
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
const TOTAL_CHALLENGE_DAYS = 92;
const CIRCLE_MIN = 52;
const CIRCLE_MAX = 132;

function colorFor(username) {
  return USER_COLORS[username] || FALLBACK_COLOR;
}

function circleSizeFor(daysCompleted) {
  const fraction = Math.max(0, Math.min(1, daysCompleted / TOTAL_CHALLENGE_DAYS));
  return CIRCLE_MIN + (CIRCLE_MAX - CIRCLE_MIN) * fraction;
}

// Tracks each circle's DOM element and current drag position so re-renders
// (from the 30s auto-refresh) can resize in place without resetting
// wherever the person has dragged them.
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

// ====== INIT ======

initTheme();
initLogin();
