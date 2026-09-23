# Walkthrough — Profile Bug Fixes: Auto-Save Upload Persistence & Freezes Display Clamping

Resolved the profile photo disappearing bug and clamped streak freezes display in the Disciple Profile Popup across **Project Bible in 92 Days** (`@tg.youth_`).

---

## 1. Disciple Profile Popup: Freezes Clamped (`-1` $\to$ `0 Left`)
- **Problem**: When a user's streak freezes left was recorded as `-1` (e.g. used up or placeholder state), the Disciple Profile popup displayed `-1 Left`, which was confusing and counterintuitive for disciples.
- **Fix**: Updated `openUserProfileModal(username)` in [app.js](file:///c:/Users/Lenovo/OneDrive/Desktop/Antigravity%20Workspace/app.js) with strict numeric clamping:
  ```javascript
  let freezesCount = 3;
  if (userData && userData.freezesAvailable !== undefined && userData.freezesAvailable !== null) {
    const rawVal = Number(userData.freezesAvailable);
    freezesCount = (isNaN(rawVal) || rawVal < 0) ? 0 : rawVal;
  }
  if (freezesEl) freezesEl.textContent = `${freezesCount} Left`;
  ```
  - Negative values (like `-1`) now cleanly render as `0 Left`.
  - Non-negative counts render accurately (`0 Left`, `1 Left`, `2 Left`, `3 Left`).

---

## 2. Photo Upload Disappearance Resolved
- **Root Causes Identified**:
  1. **Missing Auto-Save**: In `handleAvatarFileSelected(file)`, selecting or capturing a photo only updated `pendingEditAvatar` in memory and the modal preview. If the disciple closed the modal (via 'X', Cancel, tapping backdrop, or pressing Escape) without tapping "Save Profile", the photo was lost and reverted to initials on close.
  2. **Camera MIME Permissiveness**: Mobile devices (iOS Safari, Android Chrome) capturing via `<input type="file" capture="user">` frequently set `file.type` to `""` (empty string) or `application/octet-stream`. The previous strict `file.type.startsWith('image/')` check rejected legitimate camera photos.
  3. **Storage Resilience & Self-Healing**: Storing solely in `bible92_user_profiles` risked loss if the JSON object was ever overwritten.
  4. **Session Fallbacks & Image Error Guards**: In background sync cycles (`loadUpdates`, `applyInitialData`), `renderLeaderboard` and `renderPrayers` could run with undefined sessions or broken image links, causing avatars to revert to initial letters.
- **Fixes Applied**:
  1. **Instant Auto-Save & Sync**:
     - `handleAvatarFileSelected(file)` immediately saves the compressed photo to `saveUserProfile(cur.username, { avatar: compressedDataUrl })`.
     - Immediately triggers `updateHeaderProfile(cur)`, `renderLeaderboard(currentLeaderboard, cur)`, and `renderPrayers(cur)`.
     - Displays `showNudgeToast('Profile photo saved! 📸')`.
     - Now, even if the user immediately closes the modal or refreshes, their photo is permanently preserved.
  2. **Immediate Photo Removal**:
     - `removePhotoBtn` immediately calls `saveUserProfile(cur.username, { avatar: null })`, clears the header avatar, and refreshes leaderboard/prayers with `showNudgeToast('Profile photo removed.')`.
  3. **Mobile-Permissive Canvas Compression**:
     - In `compressImageFile`, accepts any image MIME type, file extensions (`.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`, etc.), or empty MIME type from camera captures.
     - Uses `img.naturalWidth || img.width` and high-quality smoothing.
  4. **Multi-Tier Storage Redundancy**:
     - Saves to `PROFILES_STORAGE_KEY` (`'bible92_user_profiles'`), individual key `'bible92_profile_' + key`, and current user key `'bible92_my_profile'`.
     - In `getUserProfile`, retrieves from primary and falls back to backup keys, auto-healing the primary dictionary.
  5. **Session Resilience & Background Sync**:
     - Added `const curSession = session || (typeof getSession === 'function' ? getSession() : null);` to `renderLeaderboard`, `renderPrayers`, `createLeaderboardAvatarEl`, and `buildPrayerElement`.
     - Added `updateHeaderProfile(session)` into `applyInitialData` and `loadUpdates` (every 30s) to keep the header avatar in continuous sync.
     - Added `img.onerror` handlers on all avatar elements to cleanly fall back to first-letter initials without layout breaks.

---

## 3. Cache Busters & Verification

- Bumped cache busters:
  - `index.html`: `app.js?v=42`
  - `sw.js`: `CACHE_NAME = 'bible92-pwa-v42'`
- Verification Protocol:
  - Executed `node scratch/test_profile_fixes.js`: Passed 100% of unit assertions for freezes clamping, permissive image detection, and multi-tier storage self-healing.
  - Executed `node scratch/verify_project.js`: Passed 100% of syntax, CSS net brace depth 0, 6 JSON-LD entities, and `Code.gs` exclusion.

---

## Verification Summary

| Test Check | Expected | Result |
| :--- | :--- | :--- |
| Freezes left clamping (`-1` $\to$ `0`) | Displays `0 Left` | **Passed** |
| Camera upload MIME validation | Supports empty MIME & camera files | **Passed** |
| Multi-tier storage fallback | Self-healing from backup keys | **Passed** |
| Project syntax & CSS brace balance | Valid ES6+ & `depth === 0` | **Passed** |
| JSON-LD structured data | 6 entities intact in `@graph` | **Passed** |
| Code.gs security invariant | Untracked & excluded | **Passed** |
