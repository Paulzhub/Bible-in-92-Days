================================================================================
PROJECT BIBLE IN 92 DAYS — README
================================================================================
The Youth Gathering 2026 (@tg.youth_)
Duration: August 10, 2026 – November 9, 2026 (92 Days)
Live URL: https://paulzhub.github.io/Bible-in-92-Days/
Repository: https://github.com/Paulzhub/Bible-in-92-Days

--------------------------------------------------------------------------------
1. OVERVIEW
--------------------------------------------------------------------------------
Project Bible in 92 Days is a responsive, gamified, mobile-first Scripture 
accountability web application designed for a 13-member youth group reading 
through the entire Bible over 92 days.

The platform provides seamless in-app reading, continuous multi-voice audio 
narration, community prayer requests, squad reflections, encouragement pings, 
and real-time gamified progress tracking.

--------------------------------------------------------------------------------
2. KEY FEATURES
--------------------------------------------------------------------------------
* IN-APP SCRIPTURE READER:
  - 7 English Translations (NIV, ESV, NLT, KJV, NKJV, WEB, NASB)
  - Fluid Chapter Quick-Jump Navigation Tabs
  - Real-time ScrollSpy & Reading Progress Tracker
  - Customizable Font Size, Line Spacing, and Themes

* 4-VOICE AUDIO BIBLE NARRATOR (SCREEN-OFF & BACKGROUND PLAYBACK):
  - 4 Curated Speech Engines (US Male, US Female, UK Male, UK Female)
  - Chunked Speech Queue Engine (prevents browser synthesis timeouts)
  - Screen Wake Lock API (keeps screen active during listening)
  - Looped Silent Background Audio (maintains OS background playback priority)
  - MediaSession API (lockscreen playback controls and chapter metadata)
  - Speed Controls (0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x)
  - Chapter-Tab Tap-to-Narrate

* GAMIFIED SQUAD LEADERBOARD & HEATMAP:
  - Real-time Leaderboard with tie-breakers (Days completed, timestamp, streak)
  - Streak Freeze Protection (1 freeze earned every 5 days, max 3)
  - Level Progression (Disciple I to X, Finisher Level 11)
  - 92-Day Visual Heatmap Grid
  - Squad Flame Gauge (13-Member Daily Goal Bar) & Squad Heatwave Alerts
  - Squad Encouragement Pings (⚡ Nudges) with hover tooltip sender tracking

* DAILY REFLECTIONS & DISCUSSION:
  - Daily Youth Reflections with 0-2500 character counter
  - 5 Emoji Reactions (Heart, Pray, Fire, Laugh, Cross) with user tracking
  - Historical Date Search & Calendar Picker

* PRAYER & GRATITUDE WALL:
  - Community Prayer Requests & Praise Reports
  - 5 Prayer Reactions (Pray, Heart, Amen, Strength, Candle)
  - Inline Request Editing with date safeguards
  - Moderation Controls with confirmation safeguards and audit logging

* SHAREABLE DAY-STREAK CARD GENERATOR:
  - Dynamic HTML5 Canvas Card Generator (Midnight, Neon, Vaporwave, Cyberpunk)
  - Web Share API & PNG Download for Instagram Stories and group chats
  - Restricted to registered youth members (disabled for guests)

* ROLE-BASED ACCESS & GUEST MODE:
  - 13 Youth Members (Normal): Full logging, commenting, praying, and sharing
  - 5 Guest Accounts (Guest1, Guest2, Lizzy's Guest, Lamplighters Guest, Rinrin):
    - Read-only exploration of readings, leaderboards, comments, and prayers
    - 5-Device Concurrency Limit per guest account
    - 30-Minute Inactivity Auto-Expiration
    - Dynamic Multi-Guest Active Username Banner
  - 1 Admin Account: Site moderation, excluded from leaderboard rankings

--------------------------------------------------------------------------------
3. TECH STACK
--------------------------------------------------------------------------------
* Frontend: Semantic HTML5, Glassmorphic CSS3 (HSL Variables), Vanilla JavaScript (ES6+)
* Backend: Google Apps Script Web App (JSON API with batched 2D array lookups)
* Database: Google Sheets (Reading Logs, Comments, Prayers, Nudges, Audit Sheets)
* Scripture API: Bolls.life REST API + BibleGateway fallback
* Hosting: GitHub Pages (Frontend) + Google Apps Script (Backend)

--------------------------------------------------------------------------------
4. REPOSITORY STRUCTURE
--------------------------------------------------------------------------------
Bible-in-92-Days/
|-- index.html          # Main HTML structure, reader modal, drawers
|-- style.css           # Design tokens, themes, glassmorphism, responsive layout
|-- app.js              # Client application engine (Audio, Reader, Sync)
|-- 404.html            # Custom 404 handler for GitHub Pages
|-- appsscript.json     # Apps Script manifest
|-- Code.gs             # Backend Apps Script handlers (gitignored)
|-- README.md           # GitHub Markdown documentation
|-- README.txt          # Plain text documentation
`-- .gitignore          # Git exclusion rules

--------------------------------------------------------------------------------
5. DEPLOYMENT
--------------------------------------------------------------------------------
1. Frontend: Any commit pushed to the 'main' branch automatically deploys to 
   GitHub Pages.
2. Backend: Deployed via @google/clasp CLI using:
   - npx @google/clasp push
   - npx @google/clasp deploy -i <DEPLOYMENT_ID> -d "<description>"

================================================================================
"Your word is a lamp to my feet and a light to my path." — Psalm 119:105
================================================================================
