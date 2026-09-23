# Walkthrough — Cloud Profile Synchronization (Method 1: Google Sheet Storage)

Implemented real-time cross-device and cohort-wide cloud synchronization for user profile pictures and bios across **Project Bible in 92 Days** (`@tg.youth_`).

---

## 1. Google Apps Script Backend (`Code.gs`)
> *Note: `Code.gs` is untracked and never committed to Git.*

1. **New `PROFILES_SHEET_NAME` Constant**:
   - Points to the `'Profiles'` sheet tab in the Google Spreadsheet.
2. **`doPost(e)` HTTP Entry Point**:
   - Receives POST requests containing JSON string payloads (`Content-Type: text/plain` to prevent browser CORS preflights).
   - Handles `action: 'saveProfile'`.
3. **`handleSaveProfile(params)`**:
   - Verifies disciple username and password.
   - Rejects guest users (`isGuestUser(username)`).
   - Automatically initializes the `'Profiles'` sheet tab if it doesn't already exist with columns: `Username`, `Avatar`, `Bio`, `UpdatedAt`.
   - Acquires `LockService.getScriptLock()` to prevent concurrency collisions.
   - Updates existing row or appends new row.
4. **`handleGetProfiles()` & Cloud Ingestion**:
   - Reads all rows from `'Profiles'` and returns a dictionary keyed by lowercase username.
   - Injected into `doGet` (`case 'getProfiles'`), `handleGetInitialData`, and `handleGetUpdates`.

---

## 2. Frontend Cloud Synchronization (`app.js`)

1. **`apiPost(payload)`**:
   - Asynchronous HTTP POST transport with retry and abort controller.
2. **Canvas Optimization**:
   - In `compressImageFile`, default image dimensions set to 200×200 px at quality 0.8 (~10–12 KB Base64 string, ~13,000 characters).
   - Sharp Retina display for 30–80px avatar circles, comfortably fitting well within the 50,000-character cell limit.
3. **Optimistic UI with Background Cloud Sync**:
   - `saveUserProfile` writes instantly to `localStorage` (immediate UI feedback) and triggers `syncProfileToCloud` in the background.
4. **Real-Time Cross-Device Merging**:
   - `mergeCloudProfiles(res.profiles)` ingests incoming cloud profiles in `applyInitialData` and during the 30-second `loadUpdates` polling cycle.
   - Compares timestamps (`updatedAt`) to ensure users always receive the freshest avatars.
   - Automatically refreshes the Header, Leaderboard, and Prayer Wall.

---

## 3. Deployment Steps for the Google Apps Script Web App

To activate cloud synchronization in your live Google Sheet:
1. Open your Google Sheet.
2. Go to **Extensions → Apps Script**.
3. Replace the entire code with the contents of your local [Code.gs](file:///c:/Users/Lenovo/OneDrive/Desktop/Antigravity%20Workspace/Code.gs).
4. Click **Deploy → Manage deployments**.
5. Click the **Edit (pencil icon)** on your Active Deployment.
6. Under **Version**, select **New version**.
7. Click **Deploy**.

---

## 4. Verification & Testing

| Test Check | Target | Status |
| :--- | :--- | :--- |
| **Image Cell Limit** | Base64 length < 49,000 characters | **Passed** (~12,500 chars) |
| **Cloud Profile Merging** | Compares timestamps and syncs newer data | **Passed** |
| **Backend Simulation** | Appends & updates `Profiles` rows accurately | **Passed** |
| **JS Syntax** | `app.js` & `sw.js` | **Passed** |
| **CSS Brace Balance** | `style.css` (`depth === 0`) | **Passed** |
| **JSON-LD Schema** | 6 intact entities in `index.html` | **Passed** |
| **Code.gs Invariant** | Untracked & excluded from Git | **Passed** |
| **Cache Busters** | `app.js?v=43`, `bible92-pwa-v43` | **Updated** |
| **Git Deployment** | `origin main` | **Pushed** |
