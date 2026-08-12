// ====== CONFIG ======
// Paste your Apps Script /exec URL here once deployed.
const API_URL = 'https://script.google.com/macros/s/AKfycbwwB94GWz7lxHIlL8YjGotKuetc7oaHjTOfYQxRcVJfEnCGpW7MPQPNw-8l73ZMXOmF/exec';

// Challenge window (DD/MM/YY)
const CHALLENGE_START = { d: 10, m: 8, y: 26 };
const CHALLENGE_END = { d: 9, m: 11, y: 26 };

// ====== HELPERS ======

function pad(n) { return String(n).padStart(2, '0'); }

function formatDDMMYY(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)}`;
}

function apiGet(params) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url.toString()).then(r => r.json());
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
  loadToday();
  wireUpdateForm(session);
  loadLeaderboard(session);
  loadComments(session);
  wireCommentForm(session);
  startAutoRefresh(session);
}

// Keeps the leaderboard and comments in sync with manual edits made
// directly in the Google Sheet (e.g. an admin correcting a user's
// entry), without requiring the viewer to do anything themselves.
function startAutoRefresh(session) {
  setInterval(() => {
    loadLeaderboard(session);
    loadComments(session);
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadLeaderboard(session);
      loadComments(session);
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

async function loadToday() {
  const portionEl = document.getElementById('today-portion');
  const dateEl = document.getElementById('today-date');
  try {
    const res = await apiGet({ action: 'getToday' });
    if (res.success) {
      portionEl.textContent = res.portion;
      dateEl.textContent = res.date;
    } else {
      portionEl.textContent = "No portion listed for today yet — check back soon.";
      dateEl.textContent = res.date || '';
    }
  } catch (err) {
    portionEl.textContent = "Couldn't load today's portion. Check your connection.";
  }
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
        loadLeaderboard(session);
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

// ====== SECTION 2: LEADERBOARD ======

async function loadLeaderboard(session) {
  const body = document.getElementById('leaderboard-body');
  const errorEl = document.getElementById('leaderboard-error');
  errorEl.hidden = true;

  try {
    const res = await apiGet({ action: 'getLeaderboard' });
    if (!res.success) {
      body.innerHTML = '';
      errorEl.textContent = res.error || 'Could not load the leaderboard.';
      errorEl.hidden = false;
      return;
    }
    renderLeaderboard(res.leaderboard, session);
  } catch (err) {
    body.innerHTML = '';
    errorEl.textContent = "Couldn't reach the server.";
    errorEl.hidden = false;
  }
}

function renderLeaderboard(rows, session) {
  const body = document.getElementById('leaderboard-body');
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

async function loadComments(session) {
  const listEl = document.getElementById('comments-list');
  try {
    const res = await apiGet({ action: 'getComments' });
    if (!res.success) {
      listEl.innerHTML = '<p class="comments-empty">Could not load comments.</p>';
      return;
    }
    commentsCache = res.comments;
    renderComments(session);
    updateCommentFormVisibility(session);
  } catch (err) {
    listEl.innerHTML = '<p class="comments-empty">Couldn\'t reach the server.</p>';
  }
}

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

// ====== INIT ======

initTheme();
initLogin();