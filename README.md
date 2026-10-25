# FTP Tester

A web application for running **group cycling FTP (Functional Threshold Power) tests**. It
reads live power, heart-rate and cadence from real sensors over **Web Bluetooth**, streams
every athlete's telemetry to a shared dashboard, computes training zones and live coaching
feedback, and stores results — with optional sharing to Strava / TrainingPeaks.

The build follows the four phases requested in `Requirements.txt`:

1. **User interface** — `public/` (dashboard, athlete manager, live cards, leaderboard, chart)
2. **Data model** — `server/models.js` (User, Session, Participant, Sample) + persistence in `server/dataStore.js`
3. **Middleware** — `server/websocket.js` (frontend ↔ backend) and `public/js/devices.js` (sensor layer)
4. **Backend** — `server/index.js` + `server/routes/*` (storage, user management, integrations)

## Quick start

```powershell
cd FTP-tester
npm install
npm start
```

Open http://localhost:3000

> **No hardware?** Add an athlete, create a session, add the athlete to it, then click
> **▶ Demo** on their card to stream a realistic simulated trainer. Everything (live cards,
> leaderboard, chart, zones, feedback, results, history) works without any sensor.

## Using it with real sensors

1. Open the app in a browser that supports **Web Bluetooth** (Chrome / Edge over
   `http://localhost` or HTTPS).
2. **Athletes** tab → create each rider with their FTP and Max HR (used for zones).
3. **Test session** tab → create a session and pick a protocol.
4. Add athletes to the session, then per card click **🔗 Power** / **❤ HR** to pair their
   Bluetooth power meter (Cycling Power Service `0x1818`) and heart-rate strap
   (Heart Rate Service `0x180D`).
5. Click **Start test**. Hold the effort — each rider gets live zone + feedback. Click
   **Finish** to compute everyone's new FTP.

Multiple riders can also each open the app on their own phone, join the same session, and
pair their own sensors — the server fans out all telemetry to every connected screen.

### ANT+

Browsers cannot access ANT+ USB sticks directly. The device layer emits a uniform
`{ power, hr, cadence }` reading shape, so an ANT+ bridge (a small native helper forwarding
readings to the `/ws` endpoint as `telemetry` messages) drops in without changing the UI.

## FTP protocols

| Protocol | Core effort | FTP estimate |
| -------- | ----------- | ------------ |
| 20-minute test | 20 min all-out | 95% of average power |
| 8-minute test  | 8 min all-out  | 90% of average power |
| Ramp test      | steps to failure | 75% of best 1-min power |

Zones use the standard Coggan power zones (% of FTP) and %-of-max-HR heart-rate zones.

## Sharing (Strava / TrainingPeaks)

Copy `.env.example` to `.env` and fill in OAuth credentials to enable the **Connect**
buttons on the **Sharing** tab. Without credentials the buttons show *not configured* and the
app stays fully usable. A **Download TCX** export works with no credentials at all.

## API surface

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET/POST/PUT/DELETE | `/api/users` | Athlete management |
| GET | `/api/users/:id/zones` | Power/HR zones for an athlete |
| GET | `/api/sessions/protocols` | Available FTP protocols |
| GET/POST/DELETE | `/api/sessions` | Session management |
| POST | `/api/sessions/:id/{join,leave,start,finish}` | Session lifecycle |
| GET | `/api/sessions/history` | Completed test results |
| GET | `/api/integrations/status` | Platform readiness |
| WS  | `/ws` | Live telemetry + session state |

## Project layout

```
FTP-tester/
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
