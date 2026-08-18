# 📖 Project Bible in 92 Days

> **The Youth Gathering 2026** • August 10, 2026 – November 9, 2026  
> A high-engagement, gamified, mobile-first Scripture accountability web app designed for a 13-member youth group reading through the entire Bible in 92 days.

[![GitHub Pages](https://img.shields.io/badge/Hosted%20On-GitHub%20Pages-blue?style=flat-square&logo=github)](https://paulzhub.github.io/Bible-in-92-Days/)
[![Architecture](https://img.shields.io/badge/Architecture-Vanilla%20JS%20%2B%20Apps%20Script-gold?style=flat-square)](https://github.com/Paulzhub/Bible-in-92-Days)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20Runtime%20Build-emerald?style=flat-square)](#tech-stack)

---

## 🌟 Overview

**Project Bible in 92 Days** is an all-in-one digital companion created to keep 13 youth members motivated, synchronized, and connected while reading through the complete Old and New Testaments in 92 days.

Built with a fast, zero-dependency frontend architecture and a Google Apps Script + Google Sheets backend, the platform provides seamless in-app reading, continuous multi-voice audio narration, community prayer requests, squad reflections, encouragement pings, and gamified progress tracking.

---

## ✨ Key Features

### 📖 1. In-App Scripture Reader
- **Multi-Translation Switching**: Instant toggling between 7 English translations:
  - `NIV` (New International Version)
  - `ESV` (English Standard Version)
  - `NLT` (New Living Translation)
  - `KJV` (King James Version)
  - `NKJV` (New King James Version)
  - `WEB` (World English Bible)
  - `NASB` (New American Standard Bible)
- **Fluid Chapter Quick-Jump Tabs**: Instant navigation across all assigned chapters for the day.
- **ScrollSpy & Progress Tracking**: Real-time reading progress indicator and active chapter highlighting.
- **Custom Reader Experience**: Adjustable typography size, line spacing, and theme modes.

### 🎙️ 2. Audio Bible Narrator (Screen-Off & Background Playback)
- **4 Curated Voice Profiles**: Natural speech engines for `US (Male)`, `US (Female)`, `UK (Male)`, and `UK (Female)`.
- **Chunked Speech Queue Engine**: Eliminates Chromium/browser speech synthesis timeouts by chunking verses into manageable text queues with synchronized verse highlights.
- **Screen-Off & Background Keep-Alive**:
  - **Screen Wake Lock API**: Prevents devices from locking during active narration.
  - **Silent Looped Audio Stream**: Retains OS media playback priority when tab is backgrounded.
  - **MediaSession API**: Enables lockscreen playback controls, chapter metadata, and OS notifications.
- **Speed Modulation**: `0.75x`, `1.0x`, `1.25x`, `1.5x`, `1.75x`, and `2.0x` speeds.
- **Chapter-Tab Tap-to-Narrate**: Clicking any chapter quick-jump tab immediately begins narration from that exact chapter.

### 🏆 3. Gamified Squad Leaderboard & Heatmap
- **Real-Time Ranking Algorithm**:
  1. Most total days completed.
  2. Earliest daily submission timestamp (tie-breaker for same day completion).
  3. Active streak length.
  4. Alphabetical tie-breaker.
- **Streak Freeze System**: 1 Streak Freeze token earned every 5 days (up to a max of 3), automatically protecting streaks against missed days with status badges (`🛡️ 1/3`, `🛡️ Used`).
- **XP Tier Levels**: Automatic progression from `Disciple I` to `Disciple X` and `Finisher 🏆`.
- **92-Day Visual Heatmap**: Interactive calendar grid mapping completed vs. pending reading days.
- **Squad Flame Gauge**: Real-time 13-member co-op completion bar with Squad Heatwave alerts when all members finish on the same day.
- **Squad Nudges (⚡)**: Send encouragement pings to members who haven't read yet today, with hover tooltip sender tracking.

### 💬 4. Daily Reflections & Discussion
- **Reflections Wall**: Share takeaways, revelations, and thoughts on today's reading portion (0–2500 character limit).
- **Emoji Reactions**: 5 interactive reactions (`❤️ Heart`, `🙏 Pray`, `🔥 Fire`, `😂 Laugh`, `✝️ Cross`) with user tracking tooltips.
- **Historical Date Search**: Calendar picker to revisit and search past reflections from any day in the 92-day challenge.

### 🙏 5. Prayer & Gratitude Wall
- **Community Requests & Praises**: Post daily prayer requests and praise reports for squad intercession.
- **5 Prayer Reactions**: `🙏 Pray`, `❤️ Heart`, `🕊️ Amen`, `💪 Strength`, `🕯️ Candle`.
- **Inline Request Editing**: Edit your existing daily prayer requests directly with date safeguards.
- **Moderation & Deletion Safeguards**: Explicit confirmation modals with deleted items archived to audit sheets.

### 🎨 6. Shareable Day-Streak Card Generator
- **HTML5 Canvas Graphic Generator**: Dynamically renders high-resolution streak achievement graphics with custom themes (`Midnight`, `Neon`, `Vaporwave`, `Cyberpunk`) and stickers.
- **Native Sharing**: One-click sharing via Web Share API or PNG download for Instagram Stories and group chats.
- **Role-Guarded**: Restricted to registered members (automatically disabled with tooltips for guest accounts).

### 🛡️ 7. Role-Based Access, Guest Mode & Auditing
- **13 Registered Youth Members (`Normal`)**: Full reading logging, reflections, prayers, streaks, nudges, and card sharing.
- **4 Dedicated Guest Accounts (`Guest1`, `Guest2`, `Lizzy's Guest`, `Lamplighters Guest`)**:
  - Read-only exploration of all readings, leaderboards, comments, and prayers.
  - **5-Device Concurrency Limit**: Maximum 5 simultaneous devices per guest account.
  - **30-Minute Inactivity Auto-Expiration**: Inactive sessions automatically expire.
  - **Real-Time Multi-Guest Banner**: Dynamically lists all active guest usernames (e.g., *"Multiple guests are currently logged in (Guest1 and Lizzy's Guest are watching)! ✨"*).
- **1 Admin Account (`Admin`)**: Site moderation, delete/edit safeguards, excluded from leaderboard rankings.
- **Audit Logging**: Google Sheets tracking for `Guest`, `User Login`, `Login Credentials`, `Deleted Comments`, and `Deleted Prayers & Gratitude`.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend UI** | Semantic HTML5, Glassmorphic CSS3, CSS Custom Properties (HSL Tokens), Google Fonts (`Fraunces` & `Space Grotesk`) |
| **Client Logic** | Vanilla JavaScript (ES6+ async/await, Canvas 2D API, Web Speech Synthesis API, Screen Wake Lock API, MediaSession API, Web Share API) |
| **Backend** | Google Apps Script Web App (REST JSON API with batched 2D array lookups) |
| **Database** | Google Sheets (`Project Bible 92`, `Comments`, `Prayers`, `Nudges`, `Guest`, `User Login`, `Login Credentials`, `Deleted Comments`, `Deleted Prayers & Gratitude`) |
| **Scripture API** | Bolls.life REST API + BibleGateway fallback |
| **Hosting & CI/CD** | GitHub Pages (Frontend) + `clasp` CLI (Apps Script backend) |

---

## 📁 Repository Structure

```text
Bible-in-92-Days/
├── index.html          # Main application page (semantic structure, modals, reader, drawers)
├── style.css           # Design system, glassmorphism, responsive breakpoints, light/dark themes
├── app.js              # Client application engine (Audio Bible, Reader, Leaderboard, Sync)
├── 404.html            # Custom GitHub Pages 404 handler
├── appsscript.json     # Google Apps Script manifest (Anonymous execution configuration)
├── Code.gs             # Backend Apps Script handlers (Kept local & in .gitignore for password security)
├── .clasp.json         # Clasp project configuration
├── .claspignore        # Clasp deployment exclusions
├── .gitignore          # Repository git ignore rules
└── README.md           # Project documentation and architecture guide
```

---

## 🚀 Deployment & Setup

### 1. Frontend (GitHub Pages)
The frontend is built with pure Vanilla HTML/CSS/JS and contains **zero external build steps**:
1. Clone the repository:
   ```bash
   git clone https://github.com/Paulzhub/Bible-in-92-Days.git
   ```
2. Any commit pushed to the `main` branch automatically deploys to GitHub Pages.

### 2. Backend (Google Apps Script)
1. Install and authenticate `clasp`:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
2. Push changes to the Google Apps Script project:
   ```bash
   npx @google/clasp push
   ```
3. Deploy a new production version:
   ```bash
   npx @google/clasp deploy -i <DEPLOYMENT_ID> -d "Deployment description"
   ```

---

## 👥 Community & Credits

- **Organized by**: The Youth Gathering 2026 (`@tg.youth_`)
- **Reading Schedule**: 92-Day Canonical Chronological Plan (August 10, 2026 – November 9, 2026)
- **Scripture Data**: [Bolls Bible API](https://bolls.life/) & [BibleGateway](https://www.biblegateway.com/)

---

<div align="center">
  <sub>"Your word is a lamp to my feet and a light to my path." — Psalm 119:105</sub>
</div>