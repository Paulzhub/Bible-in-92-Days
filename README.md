# 📖 Project Bible in 92 Days

> **The Youth Gathering 2026** • August 10, 2026 – November 9, 2026  
> A high-engagement, gamified, mobile-first Scripture accountability Progressive Web App designed for a 13-member youth cohort reading through the entire Bible in 92 days.

[![GitHub Pages](https://img.shields.io/badge/Hosted%20On-GitHub%20Pages-blue?style=flat-square&logo=github)](https://paulzhub.github.io/Bible-in-92-Days/)
[![Architecture](https://img.shields.io/badge/Architecture-Vanilla%20JS%20%2B%20Apps%20Script-gold?style=flat-square)](https://github.com/Paulzhub/Bible-in-92-Days)
[![PWA](https://img.shields.io/badge/PWA-Installable%20%26%20Offline-purple?style=flat-square)](#pwa-standalone-immersion--swr-engine)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20Runtime%20Build-emerald?style=flat-square)](#tech-stack)

---

## 🌟 Overview

**Project Bible in 92 Days** is an all-in-one digital discipleship companion built to keep 13 youth members synchronized, motivated, and spiritually accountable as they read through all 66 books and 1,189 chapters of the Holy Bible in 92 days (~12–14 chapters daily, ~45–60 minutes).

Engineered with a high-performance, zero-build vanilla HTML5/CSS3/JavaScript frontend and a Google Apps Script + Google Sheets serverless backend, the platform delivers instantaneous (<50ms) client hydration, seamless in-app Scripture reading, continuous multi-voice audio narration, real-time leaderboard overtaking alerts, team showdowns, communal prayers, squad reflections, and gamified progress tracking.

---

## ✨ Key Features

### 📖 1. In-App Scripture Reader
- **13 Multi-Translation & Multilingual Versions**: Instant switching across 5 languages without leaving the app:
  - **English**:
    - `NIV` (New International Version)
    - `ESV` (English Standard Version)
    - `CSB` (Christian Standard Bible)
    - `NLT` (New Living Translation)
    - `KJV` (King James Version)
    - `NKJV` (New King James Version)
    - `WEB` (World English Bible)
    - `NASB` (New American Standard Bible)
  - **Nepali (नेपाली)**:
    - `NNRV` (Nepali New Revised Version)
    - `NEPS` (सरल नेपाली पवित्र बाइबल - Easy Nepali)
  - **Hindi (हिन्दी)**:
    - `HIN` (Hindi O.V. Re-edited)
  - **Afrikaans**:
    - `AFR` (Afrikaans 1933/1953)
  - **Tibetan (བོད་ཡིག)**:
    - `TIB` (New Tibetan Bible / དམ་པའི་གསུང་རབ་བོད་འགྱུར་གསར་མ།) with Bible SuperSearch API fallback
- **Persistent Version Selection**: Remembers the reader's preferred Bible translation in `localStorage` across page reloads and sessions (defaulting to NIV).
- **Fluid Chapter Quick-Jump Tabs**: Seamless navigation bar with dedicated tabs for every assigned chapter of the day, featuring live verse narration synchronization.
- **Custom Reader Experience**: Adjustable typography scaling (`0.85rem` to `1.45rem`), font styles, line spacing, parchment reading mode, and dynamic viewport header controls.
- **ScrollSpy & Progress Tracking**: Real-time reading progress indicator with active chapter tab highlighting and external Bible Gateway deep-linking.

### 🎙️ 2. Audio Bible Narrator (Screen-Off & Background Playback)
- **12 Curated Voice Profiles across 5 Languages**: Natural speech synthesis with pitch modulation and language targeting:
  - **English**: `US (Male)`, `United States (Female)`, `United Kingdom (Male)`, `United Kingdom (Female)`
  - **Nepali (नेपाली)**: `Nepali (Male)`, `Nepali (Female)`
  - **Tibetan (བོད་སྐད)**: `Tibetan (Male)`, `Tibetan (Female)`
  - **Afrikaans**: `Afrikaans (Male)`, `Afrikaans (Female)`
  - **Hindi (हिन्दी)**: `Hindi (Male)`, `Hindi (Female)`
- **Chunked Speech Queue Engine**: Eliminates Chromium/browser speech synthesis timeouts by chunking verses into manageable text queues with synchronized verse highlights.
- **Screen-Off & Background Keep-Alive**:
  - **Screen Wake Lock API**: Prevents devices from dimming or sleeping during active narration.
  - **Silent Looped Audio Stream**: Maintains OS media playback priority when minimized or backgrounded.
  - **MediaSession API**: Enables lockscreen and control center media controls with track artwork, chapter metadata, and OS notifications.
- **Speed Modulation**: Fine-tuned playback speeds (`0.75x`, `1.0x`, `1.25x`, `1.5x`, `1.75x`, `2.0x`).
- **Chapter-Tab Tap-to-Narrate**: Tapping any chapter quick-jump tab immediately begins narration from that specific chapter.

### ⚔️ 3. Cohort Showdown (Boys vs Girls)
- **Team-Based Velocity Tracker**: Real-time aggregate reading progress comparing overall completion velocity between Boys and Girls.
- **Dynamic Tug-of-War Visualization**: Segmented progress bar featuring glowing seam indicators and dynamic particle bursts whenever leads fluctuate.
- **Showdown Story Share Card**: One-tap canvas generator creating branded social graphics celebrating team milestones for Instagram Stories and group chats.

### 🔔 4. Hybrid Notification Center & Activity Engine
- **Illuminated Header Bell (`🔔`)**: Prominently placed notification button in the navigation header with an amber unread badge counter that animates gently when new alerts are pending.
- **Slide-Out Activity Drawer**: High-contrast glassmorphic notification center categorizing activity feeds:
  - **Leaderboard Overtaking Alerts (`⚡`)**: Instant detection when cohort peers pass you on the leaderboard, with a 1-tap `[📖 Read Now]` button to fight back and reclaim your rank!
  - **Squad Nudges (`⚡`)**: Real-time notifications when a squadmate pings you to complete today's reading.
  - **Streak Freeze Safety-Net Notices (`🧊`)**: Automated confirmation when a streak freeze preserves an active reading streak after a missed day.
  - **Scheduled Daily Reading Alarms (`📖`)**: Configurable local time notifications via Web Notifications API (custom ON/OFF toggle, time picker, and instant test notification).
  - **Automated Feature Release Notes (`🚀`)**: In-app plain-English release summaries announcing new features and enhancements.
  - **Rank Advancement Alerts (`🏆`)**: Milestone celebration alerts whenever you climb leaderboard positions.
- **Notification Management**: Relative timestamps (`formatRelativeTime`), 1-tap action deep-links, mark all read, clear all, and individual item dismissal with smooth red hover transitions.

### 🏆 5. Gamified Squad Leaderboard & Heatmap
- **Real-Time Ranking Algorithm**:
  1. Most total reading days completed.
  2. Earliest daily submission timestamp (tie-breaker for same-day completion).
  3. Active streak length.
  4. Alphabetical tie-breaker.
- **Streak Freeze Safety-Net System**: 1 Streak Freeze token earned every 5 days completed (strictly capped at 3), automatically protecting streaks against missed days with status badges (`🧊 X left`).
- **10 Disciple XP Tiers & 3D Interactive Medallions**: Visual progression system spanning from `Disciple I` to `Disciple X` and the coveted `Finisher 🏆` crown, rendered with interactive 3D WebGL medallions.
- **Weekly Recap & All-Time Milestones**: Interactive week selector displaying Group Completion Rate, Most Consistent Reader(s), Top Weekly Streak, and cumulative All-Time achievements.
- **92-Day Visual Heatmap**: Interactive calendar grid mapping completed vs. pending reading days throughout the challenge.
- **Squad Flame Gauge**: Real-time 13-member co-op completion bar with Squad Heatwave alerts when all members finish on the same day.
- **Squad Nudges (`⚡`)**: Send encouragement pings to members who have not read today, complete with translucent glassmorphic confirmation toasts and sender attribution hover tooltips.

### 💬 6. Daily Reflections & Discussion
- **Reflections Wall**: Share takeaways, revelations, and thoughts on today's reading portion (0–2,500 character limit).
- **Emoji Reactions**: 5 interactive reactions (`❤️ Heart`, `🙏 Pray`, `🔥 Fire`, `😂 Laugh`, `✝️ Cross`) with real-time member tracking tooltips.
- **Historical Date Search**: Calendar picker allowing members to revisit and explore past reflections from any day in the 92-day challenge.

### 🙏 7. Prayer & Gratitude Wall
- **Community Requests & Praises**: Post daily prayer requests and praise reports for squad intercession.
- **5 Prayer Reactions**: `🙏 Pray`, `❤️ Heart`, `🕊️ Amen`, `💪 Strength`, `🕯️ Candle`.
- **Inline Request Editing**: Edit existing prayer requests directly with date safeguards and audit protection.
- **Moderation & Deletion Safeguards**: Two-step confirmation modals with deleted items archived to secure audit sheets.

### 🧠 8. Discipleship Micro-Learning & Memory Verses
- **Interactive 3D Memory Verse Flashcards**: Dedicated daily Scripture memory cards featuring 3D flip animations, key verse memorization prompts, and practice modes.
- **Daily Scripture Micro-Quizzes**: Fast, interactive multiple-choice quizzes reinforcing key facts and context from the assigned chapters.

### 🎨 9. Shareable Day-Streak Card Generator
- **HTML5 Canvas Graphic Generator**: Dynamically renders high-resolution streak achievement graphics with 4 custom visual themes (`Midnight`, `Neon`, `Vaporwave`, `Cyberpunk`) and decorative stickers.
- **Native Sharing**: One-click sharing via Web Share API or PNG download for Instagram Stories and group chats.
- **Role-Guarded**: Restricted to registered members (automatically disabled with tooltips for guest accounts).

### 📱 10. PWA Standalone Immersion & SWR Engine
- **Progressive Web App Architecture**:
  - Full WebAPK installation on Android with splash screen and app shortcuts.
  - Apple Mobile Web App standalone immersion on iOS (safe area inset handling for notches and home bars, dynamic viewport units `100dvh`).
  - Desktop PWA installation across Chrome, Edge, and Safari.
  - Service Worker (`sw.js`) with CacheFirst strategy for static assets and NetworkFirst strategy for dynamic APIs.
  - Notification click routing to auto-focus active PWA windows and dispatch reader deep-links.
- **High-Performance Stale-While-Revalidate (SWR) Engine**:
  - Synchronous UI hydration in **< 50ms** via client `localStorage` caching.
  - Client-side DOM schedule synthesis providing instantaneous interactivity even before network responses arrive.
  - Background asynchronous fetch updates the DOM and refreshes local cache seamlessly without layout shifts.
  - Periodic 30-second background polling keeps leaderboard data and notifications continuously fresh.

### 🛡️ 11. Role-Based Access, Guest Privacy & Auditing
- **13 Registered Youth Members (`Normal`)**: Full access to log readings, share reflections, post prayers, earn streaks, send nudges, and export streak cards.
- **Dedicated Guest Mode**:
  - Read-only exploratory access to readings, leaderboards, reflections, and prayers.
  - **5-Device Concurrency Cap**: Per-guest account limit preventing link abuse.
  - **30-Minute Inactivity Auto-Expiration**: Automatically closes stale guest sessions.
  - **Real-Time Multi-Guest Banner**: Dynamically indicates guest presence without exposing internal account IDs or personal data.
- **Admin Account (`Admin`)**: Moderation, deletion safeguards, and administrative controls (excluded from leaderboard rankings).
- **Audit Logging**: Google Sheets tracking for user logins, guest sessions, deleted reflections, and deleted prayer requests.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend UI** | Semantic HTML5, Glassmorphic CSS3, CSS Custom Properties (HSL/RGB Tokens), Google Fonts (`Fraunces` & `Space Grotesk`) |
| **3D & Animation** | Three.js (WebGL Medallions), GSAP, ScrollTrigger, Lenis Smooth Scroll |
| **Client Engine** | Vanilla JavaScript (ES6+ async/await, Canvas 2D API, Web Speech Synthesis API, Screen Wake Lock API, MediaSession API, Web Share API, Web Notifications API) |
| **PWA & Caching** | Service Worker (`sw.js`), Web App Manifest (`manifest.webmanifest`), Stale-While-Revalidate (SWR) LocalStorage Engine |
| **Backend API** | Google Apps Script Web App (REST JSON API with batched 2D array lookups and password hashing) |
| **Database** | Multi-Tab Google Sheets (`Project Bible 92`, `Comments`, `Prayers`, `Nudges`, `Guest`, `User Login`, `Login Credentials`, `Deleted Comments`, `Deleted Prayers & Gratitude`) |
| **Scripture APIs** | Bolls Bible REST API + Bible SuperSearch API (Tibetan) + Bible Gateway Fallback |
| **Hosting & CI/CD** | GitHub Pages (Frontend) + `clasp` CLI (Apps Script backend) |

---

## 📁 Repository Structure

```text
Bible-in-92-Days/
├── index.html              # Main application page (semantic layout, modals, reader, drawers, JSON-LD)
├── style.css               # Design system, glassmorphic styles, responsive breakpoints, light/dark themes
├── app.js                  # Core client engine (Reader, Audio Narrator, Leaderboard, Notifications, SWR)
├── sw.js                   # Service Worker (PWA offline caching, notification click routing)
├── manifest.webmanifest    # Web App Manifest (standalone configuration, icons, display modes)
├── 404.html                # Custom GitHub Pages 404 handler
├── appsscript.json         # Google Apps Script manifest (execution configuration)
├── Code.gs                 # Backend Apps Script handlers (Local only, listed in .gitignore)
├── .clasp.json             # Clasp project configuration
├── .claspignore            # Clasp deployment exclusions
├── .gitignore              # Git ignore rules (protects Code.gs and local artifacts)
└── README.md               # Project documentation and architecture guide
```

---

## 🚀 Deployment & Setup

### 1. Frontend (GitHub Pages)
The frontend is built with pure Vanilla HTML/CSS/JS and contains **zero build steps**:
1. Clone the repository:
   ```bash
   git clone https://github.com/Paulzhub/Bible-in-92-Days.git
   ```
2. Any commit pushed to the `main` branch automatically deploys to GitHub Pages in seconds.

### 2. Backend (Google Apps Script)
1. Install and authenticate `clasp`:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
2. Push backend changes to Google Apps Script:
   ```bash
   npx @google/clasp push
   ```
3. Deploy a production version:
   ```bash
   npx @google/clasp deploy -i <DEPLOYMENT_ID> -d "Production deployment description"
   ```

---

## 👥 Community & Credits

- **Organized by**: The Youth Gathering 2026 (`@tg.youth_`)
- **Reading Schedule**: 92-Day Canonical Plan (August 10, 2026 – November 9, 2026)
- **Scripture Data**: [Bolls Bible API](https://bolls.life/), [Bible SuperSearch](https://www.biblesupersearch.com/), & [Bible Gateway](https://www.biblegateway.com/)

---

<div align="center">
  <sub>"Your word is a lamp to my feet and a light to my path." — Psalm 119:105</sub>
</div>