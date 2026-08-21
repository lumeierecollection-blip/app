# RUNBOOK — getting the app on your phone (Amendment F)

The end state: a free Render-hosted Node backend follows the Telegram
tipster channels you name, parses each post into selections, settles them
against ESPN results, scores each **source** by ROI/CLV, and pushes a phone
notification only when a **rated** source (50+ settled, positive ROI) posts.
Your phone gets a signed APK built by GitHub Actions, no local Flutter
install needed.

**Amendment F change:** Telegram is read through the public `t.me/s/<channel>`
preview page — the same trick tradeapp uses. No `api_id`, no `api_hash`, no
session string, no `make_session.js`. A channel works if its preview page is
public (open `https://t.me/s/<username>` in a browser; if you see posts, the
backend can read it). Private/invite-only channels are not readable this way.
Even with zero channels configured the app shows live fixtures and odds via
the fixture-pulse feed entries, so a fresh deploy is never an empty screen.

Time: ~20 minutes, most of it in browsers. Every external account is free.

---

## 0. What you need

- A GitHub account (the repo `lumeierecollection-blip/app`).
- A Render account (render.com → Sign up, free plan).
- A Google account (for Firebase).
- An Android phone.

---

## 1. Deploy the backend to Render

1. Go to render.com → **New + → Web Service** → connect the repo
   `lumeierecollection-blip/app`.
2. Set:
   - **Root directory**: `backend`
   - **Runtime**: Node
   - **Build command**: `npm ci`
   - **Start command**: `node server.js`
   - **Instance type**: Free
3. **Environment variables** (add these; leave the ones marked "later" for
   the sections below):

   | Key | Value |
   |---|---|
   | `PORT` | `10000` |
   | `SCAN_INTERVAL_MS` | `300000` (scan every 5 minutes) |
   | `ESPN_LEAGUES` | `eng.1` (English Premier League — results + odds feed) |
   | `TELEGRAM_CHANNELS` | *e.g. `tippingchannel1,tippingchannel2` (no @; optional — see §2)* |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | *the Firebase service-account JSON from §4 (multi-line is fine)* |

4. **Deploy**. When the deploy finishes, open
   `https://<your-app>.onrender.com/api/health` — it should return
   `{"ok":true,...}`. Then open `/api/status` — it shows the last scan time,
   per-league ESPN status, and whether Telegram/push are configured. This
   endpoint is the honest health check: a misconfigured channel reports a
   **hard error there**, never "no posts".

Render's free tier sleeps the app after ~15 minutes idle, which would pause
the scan loop. §3 keeps it awake.

---

## 2. Telegram: pick public channels (no credentials needed)

1. For each channel you want to follow, open
   `https://t.me/s/<username>` in your browser. If you can see the posts,
   the backend can read them. If Telegram shows "preview not available",
   the channel is private — it cannot be followed on this path.
2. In Render, set `TELEGRAM_CHANNELS` to those usernames, comma-separated,
   without the leading `@`.
3. Trigger a scan now: `POST https://<your-app>.onrender.com/refresh`
   (or just wait up to `SCAN_INTERVAL_MS`). Then check `/api/status` →
   `telegram.state` should read `"ok"` and `lastScanSummary.newPosts`
   should be non-zero on the first scan of an active channel.

That's the whole section — no my.telegram.org visit, no session string, no
phone approval. A channel that later goes private simply stops yielding
posts; `/api/status` shows the fetch error next scan rather than failing
the whole scan.

---

## 3. Keep the free server awake

Free instances sleep after ~15 min idle. The fix is a free monitor that hits
the health endpoint every 5 minutes:

1. Create a free **UptimeRobot** account (uptimerobot.com).
2. **New monitor → HTTP(s)** → URL `https://<your-app>.onrender.com/api/health`,
   interval 5 minutes.
3. Optionally use the monitor's alert when the app is down.

The same 5-minute heartbeat keeps the in-process scan loop running.

---

## 4. Firebase: push notifications

1. **console.firebase.google.com** → **Add project** (you can skip
   analytics).
2. **Add Firebase to your Android app**. The application ID is
   `com.tipsteraggregator.tipster_aggregator` (set by `build-apk.yml`'s
   `flutter create --org com.tipsteraggregator --project-name
   tipster_aggregator`). Click **Register app** and download
   `google-services.json`.
3. Store it as a GitHub repo secret:
   - `cat google-services.json | base64 -w 0` on Linux/Mac, or PowerShell:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))`
   - GitHub → repo → **Settings → Secrets and variables → Actions** →
     **New repository secret** → name `GOOGLE_SERVICES_JSON`, paste the
     base64 string. (This is what `build-apk.yml` decodes into the build.)
4. Back in Firebase: **Project settings → Service accounts → Generate new
   private key** → downloads a JSON file. Paste its **entire contents** into
   Render's `FIREBASE_SERVICE_ACCOUNT_JSON` env var, then redeploy the
   backend.

---

## 5. Build the APK (no local Flutter needed)

1. GitHub repo → **Settings → Secrets → Actions**. The build fails loudly if
   any of these are missing, so set all of them:

   | Secret | What it is |
   |---|---|
   | `API_BASE_URL` | `https://<your-app>.onrender.com` (no trailing slash) |
   | `GOOGLE_SERVICES_JSON` | base64 of §4's file |
   | `ANDROID_KEYSTORE_BASE64` | base64 of your signing keystore (`.jks`). If you have no keystore, the standard tool that makes one on Windows is `keytool` (ships with Android Studio / JDK): `keytool -genkey -v -keystore release-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias release` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | the alias (e.g. `release`) |
   | `ANDROID_KEY_PASSWORD` | the key password |

2. **Actions → Build APK → Run workflow**. The workflow (ported from
   tradeapp, with four known bugs fixed and the Amendment E Firebase step
   added) checks out, generates the Android shell, injects
   `google-services.json`, wires release signing, runs `flutter analyze` +
   `flutter test`, and builds a release APK.
3. When it finishes, open the run's **Artifacts** and download the
   `tipster-<sha>.apk` file.

---

## 6. Install and first run

1. Copy the APK to the phone (USB cable, email, or cloud drive) and open it.
   Allow "install from unknown sources" when asked.
2. Open the app. The **Slips** tab shows recent posts the backend parsed;
   the **Tipsters** tab lists each followed channel with its ROI, CLV, and a
   TRACKING / UNRATED / RATED / DISQUALIFIED badge.
3. First launch registers the device with the backend (that's the
   `firebase_messaging` permission prompt → Allow).

---

## 7. What to expect (read this before you judge it)

- **It will be quiet for weeks.** A source is only notifiable once it has
  **50 settled selections** with a positive ROI. Until then the phone stays
  silent by design — "trusted" is defined as "proven on 50+ bets", and the
  Tipsters tab shows each source climbing toward that gate.
- **Only text posts parse.** Image-only tips can't be read without an OCR
  service (deliberately excluded: no paid APIs on this path).
- If nothing ever ingests: `/api/status` is the diagnostic —
  `telegram.state`, `lastScanAt`, `lastScanError`, and the per-league
  `espnStatus` entries tell you exactly which leg failed. (Amendment F
  keeps no database, so there are no `ingestion_health` rows anymore —
  the status snapshot is the record.)
