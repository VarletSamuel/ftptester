# FTP Tester

A web application for running **group cycling FTP (Functional Threshold Power) tests**. It
reads live power, heart-rate and cadence from real sensors over **Web Bluetooth**, streams
every athlete's telemetry to a shared dashboard, computes training zones and live coaching
feedback, and stores results — with optional sharing to Strava / TrainingPeaks.

The build follows the four phases requested in `Requirements.txt`:

1. **User interface** — `public/` (athlete manager, per-rider live cards, gauges, reports)
2. **Data model** — `server/models.js` (User, Session, Participant, Sample) + persistence in `server/dataStore.js`
3. **Middleware** — `server/websocket.js` (frontend ↔ backend) and `public/js/devices.js` (sensor layer)
4. **Backend** — `server/index.js` + `server/routes/*` (storage, user management, integrations)

## What you need (one-time setup on a Windows PC)

| You need | Why | How to get it |
| -------- | --- | ------------- |
| **Node.js 18 or newer (LTS)** | Runs the app's server. It also installs `npm`. | Download the *LTS* installer from https://nodejs.org and click through it with the default options. Restart the terminal afterwards. |
| **Chrome or Edge** | Only these browsers can talk to Bluetooth devices. Firefox and Safari cannot. | Edge is already on Windows 11. |
| **Bluetooth on the PC** | To reach the trainer, power meter and heart-rate strap. | Built into most laptops; otherwise use a USB Bluetooth 4.0+ dongle. Switch it on in Windows Settings. |
| **A smart trainer that supports FTMS** (most Wahoo, Tacx, Elite, Saris, Zwift Hub ...) | Only needed if the app should control resistance. | Check that the trainer lists "FTMS" or "Bluetooth control". |
| *(optional)* Git | Only to download the project with `git clone`. | https://git-scm.com. Alternatively download the project as a ZIP from GitHub and unzip it. |

To check Node.js is installed, open **PowerShell** (Start menu, type "PowerShell") and run
`node -v`. It should print a version such as `v20.x` or higher.

Tips:
- Close other apps that use the sensors (Zwift, Garmin Express, phone apps): a Bluetooth device
  usually accepts one connection at a time.
- Keep the PC awake and plugged in during a test.

## Quick start

Open PowerShell **in the project folder** (in File Explorer, open the `ftptester` folder, click the
address bar, type `powershell` and press Enter), then:

```powershell
cd ftptester        # skip this if PowerShell is already inside the folder
npm install         # first time only: downloads the libraries (needs internet)
npm start           # starts the app; leave this window open
```

Then open http://localhost:3000 in Chrome or Edge. Stop the app with `Ctrl+C` in the PowerShell
window. To start it again later, only `npm start` is needed.

`npm install` may print a note such as "2 moderate severity vulnerabilities". These come from
a library used for the Excel export and do not affect this app (see *Security notes* below).

> **No hardware?** Add an athlete, create a session, add the athlete to it, then click
> **▶ Demo** on their card to stream a realistic simulated trainer. Everything (live cards,
> history chart, gauges, zones, results, history) works without any sensor.

## Using it with real sensors

1. Open the app in **Chrome or Edge** over `http://localhost` or HTTPS. Firefox and Safari do
   not implement Web Bluetooth, so pairing is impossible there (the app shows a banner; the
   Demo trainer still works). Other riders' screens on the LAN need HTTPS.
2. **Athletes** tab: create each rider with FTP, max HR (and LTHR if known).
3. **Test session** tab: set warm-up, FTP effort duration, effort % of FTP and cool-down, then
   create the session and add up to 6 athletes.
4. On each rider's card pair a **smart trainer** (FTMS: power, cadence *and* resistance
   control), and/or a **power meter** and **HR strap**. Every paired device is listed with its
   connection state and its live power / heart rate. Dropped links reconnect automatically;
   a device that cannot be recovered shows a **Retry** button.
5. Set the effort resistance per rider (**% of FTP** or **Watts** toggle, with +/- nudges).
6. **Start all together**, **Staggered** (every N seconds, in card order) or per-rider **Start**.

### Test flow and trainer control

Warm-up (free ride), then effort (trainer held in ERG at the chosen target), then cool-down
(free ride). The server runs each rider's timeline on their own clock and tells the browser
that owns the trainer what to do; the browser sends it over the FTMS Control Point (request
control, then *Set Target Power*). The trainer chip shows what was actually commanded (for
example `ERG 216 W`). A power meter alone cannot add resistance; only a controllable trainer can.

### Display values and configuration

Screens show a rolling average (default 3 s) instead of raw values. Smoothing window, history
length, default test plan, FTP adjustment factors and heart-rate zone bounds live in
`config/settings.json` (restart the server after editing).

### Reports and exports

Each finished test stores per-rider 1 Hz power/HR. The report (also under **History**) shows per
rider the new FTP, the adjustment factor used, and a colour-coded table of the 7 power zones with
matching heart-rate zones and time in zone. Downloads: **TCX** and **GPX** per rider, and one
**Excel** workbook (summary, zones, raw data per rider). GPX points carry no position (indoor).

### ANT+

Browsers cannot access ANT+ USB sticks directly. The device layer emits a uniform
`{ power, hr, cadence }` reading shape, so an ANT+ bridge forwarding readings to the `/ws`
endpoint as `telemetry` messages drops in without changing the UI.

## FTP calculation

FTP = average power over the effort x **adjustment factor** for the effort duration
(20 min = 0.95, 8 min = 0.90; other durations are interpolated from `ftpFactors`).
Zones: Coggan 7 power zones (% of FTP). Heart-rate zones are anchored on LTHR (average HR of the
effort, else estimated as 90% of max HR) using `heartRate.zoneBoundsPctLthr`, capped at max HR.

## Sharing (Strava / TrainingPeaks)

Copy `.env.example` to `.env` and fill in OAuth credentials to enable the **Connect**
buttons on the **Sharing** tab. Without credentials the buttons show *not configured* and the
app stays fully usable. A **Download TCX** export works with no credentials at all.

## API surface

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET/POST/PUT/DELETE | `/api/users` | Athlete management |
| GET | `/api/users/:id/zones` | Power/HR zones for an athlete |
| GET | `/api/settings` | Tunables from config/settings.json |
| GET/POST/DELETE | `/api/sessions` | Session management |
| POST | `/api/sessions/:id/{join,leave,start,finish}` | Session lifecycle (`start` takes `staggerSeconds`) |
| POST/PUT | `/api/sessions/:id/riders/:userId/{start,stop,control}` | Per-rider start/stop and resistance |
| GET | `/api/tests`, `/api/tests/:id` | Completed tests and report data |
| GET | `/api/tests/:id/export/:userId.{tcx,gpx}`, `/api/tests/:id/export.xlsx` | Exports |
| GET | `/api/integrations/status` | Platform readiness |
| WS  | `/ws` | Live telemetry + session state |

## Project layout

```
ftptester/
  server/            Backend (Express API + WebSocket)
    models.js        Data model
    metrics.js       FTP / zone / NP maths
    dataStore.js     JSON persistence
    sessionManager.js Live session engine
    websocket.js     Telemetry middleware
    routes/          REST endpoints
  public/            Frontend (no build step)
    index.html
    css/styles.css
    js/
      app.js         UI controller
      devices.js     Web Bluetooth sensor layer
      ws.js / api.js Transport
      metrics.js     Client-side zones & feedback
  data/              Persisted users + history (git-ignored)
```

## Security notes

`npm audit` checks the libraries bundled with this app, not your PC. The app is meant to run on
a trusted local network (no login), so do not expose port 3000 to the internet. Two moderate
warnings remain, both in `uuid` inside `exceljs` (a known issue when a caller passes its own
buffer to uuid v3/v5/v6, which exceljs never does). The suggested "fix" would downgrade exceljs to
an old major version, so it is deliberately not applied.
