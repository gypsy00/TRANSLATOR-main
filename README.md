# ⛪ Church Translator

A live sermon translation web app — the preacher speaks in English and Ukrainian
listeners read real-time captions on their phones.

Built with Next.js 16, the Vercel AI SDK, and Claude Haiku.

---

## How It Works

1. The **preacher** opens `/broadcast`, shows the QR code, and taps **Start Sermon**
2. The browser's Web Speech API captures speech continuously
3. Each completed sentence is queued and sent to `/api/translate` (Claude Haiku)
4. The Ukrainian translation is written to a shared caption log
5. **Listeners** on `/listen` long-poll that log and see each line as it lands

No app install required — it runs entirely in the browser.

---

## Before the service — checklist

Run through this the night before, not five minutes beforehand.

- [ ] `ANTHROPIC_API_KEY` is set (`.env.local` locally, project env vars on Vercel)
- [ ] **Say one sentence into `/broadcast` and confirm Ukrainian appears on `/listen`.**
      This is the only check that exercises the model call.
- [ ] On the deployed URL, `/api/session` reports `"backend":"redis"` — if it says
      `"memory"`, captions can silently fail to reach listeners (see below)
- [ ] The preacher's device can actually broadcast: it must be on **HTTPS or
      localhost**, in **Chrome or Edge**. iPhone has no Web Speech support.
- [ ] Scan your own QR code with a phone and confirm the listen page loads
- [ ] Preacher's device is charged and the mic is not claimed by another app

---

## Running it

### Locally (laptop on church Wi-Fi)

```bash
npm install
npm run dev
```

The preacher must use **`http://localhost:3000/broadcast`** on the laptop itself.
Browsers refuse microphone access on `http://192.168.x.x`, because that is not a
secure context — a LAN IP will show a warning on the page rather than failing
silently.

Listeners scan the QR code, which points at the laptop's LAN address. Both
devices must be on the same Wi-Fi, and the router must not have client isolation
enabled.

No Redis is needed locally: one server process means the in-memory store is
correct by definition.

### On Vercel

Works from anywhere, allows the preacher to use a phone (HTTPS), and gives the
pastors a link they can open later.

**Redis is required.** Add it from the Vercel dashboard:
Project → Storage → Upstash Redis (free tier). The credentials are injected
automatically and the app picks them up.

Without it, `lib/broadcast-store.ts` falls back to per-process memory. On
serverless the preacher's `POST` and a listener's poll can land on different
instances — the translation succeeds, every indicator stays green, and nobody
receives anything. The preacher's screen now warns when this configuration is
detected, but the fix is to add the store.

---

## Environment

See `.env.example`.

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Translation |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | On Vercel | Shared caption store across instances |
| `ALLOWED_DEV_ORIGINS` | No | Extra dev-server origins; the LAN IP is detected automatically |

`KV_REST_API_URL` / `KV_REST_API_TOKEN` are also accepted.

---

## Architecture Notes

- **Transport is long-polling, not SSE.** `GET /api/captions?since=<seq>` holds
  the request open for up to 20s and returns as soon as there is a newer
  caption. A request that reads shared state works regardless of which instance
  serves it, gives late joiners history for free, and has no `maxDuration`
  cliff. Measured wake latency on the in-memory backend is ~130ms.
- **One store, two backends.** `lib/broadcast-store.ts` selects Redis or memory
  from the environment, so local and production run the same code path.
- **Redis cost is flat in device count.** Two mechanisms: caption reads are
  coalesced per instance (many listeners share one cached snapshot refreshed at
  most every 500ms), and presence is tracked in process memory, with each
  instance publishing only an aggregate count every 10s. Measured at 76-78
  commands per 14s whether 5, 60 or 100 devices are connected — roughly 30k per
  90-minute service, regardless of congregation size.
- **Listeners reconnect instantly on wake.** A phone returning from sleep aborts
  its stale long-poll and re-requests immediately rather than waiting out a
  backoff. Aborting is safe because the cursor only advances on a successful
  response, so nothing is dropped or duplicated.
- **Sessions.** Starting a sermon mints a new session id and clears the feed, so
  listeners never replay last week. Clients reset their cursor on a session
  change.
- **Listeners choose their own language.** Each device sends its language with
  every poll; presence carries the set of languages in the room; a spoken
  sentence is translated in parallel into exactly those languages (capped at 5)
  and stored as one caption per language. Nobody listening yet falls back to the
  preacher's default. The preacher's screen shows which languages are live.
- **Output is script-checked.** Each language declares its script; output must
  contain it and must not contain another language's. This catches a real,
  intermittent failure where Haiku bled Cyrillic into Polish
  ("Niech Pан cię błogosławi"). A failed check retries without context.
- **Translation carries context, but is never conversational.** The line is sent
  as a single tagged prompt with recent pairs as reference material. An earlier
  version passed them as user/assistant turns, which made the model treat speech
  as a message addressed to it — "What is your name" was answered rather than
  translated. Output is length-checked against the source to catch a recurrence.
- **Sentences are queued client-side.** Strictly one translation in flight, so
  two quick sentences cannot arrive in the wrong order.
- **Speech recognition recovers.** Only `not-allowed`, `service-not-allowed` and
  `audio-capture` end the broadcast. Everything else restarts with exponential
  backoff, up to 12 attempts.
- **Wake locks are re-acquired** on `visibilitychange`, on both pages. The OS
  drops the lock whenever the tab is hidden and never returns it.

---

## Project Structure

```
app/
  page.tsx                # Home — role selection
  broadcast/page.tsx      # Preacher — speech capture, QR, listener count
  listen/page.tsx         # Listener — live captions, text size
  api/
    translate/route.ts    # Translation + append to the caption log
    captions/route.ts     # Listener long-poll feed
    session/route.ts      # Start/end a sermon; preacher status
    network-info/route.ts # Resolves the URL the QR code should encode
lib/
  broadcast-store.ts      # Caption log — Redis or in-memory
  redis.ts                # Minimal Upstash REST client
```

---

## Latency

Measured end to end on the production build:

| Stage | Typical | Controlled by |
|---|---|---|
| Speech -> Chrome marks the sentence final | 0.5-1.5s | Chrome's endpointing. Not ours |
| Translation (Haiku) | ~700ms | Near the model's floor |
| Delivery to listeners | ~125ms avg | Redis poll interval (250ms) |
| **Total** | **~1.7-2.2s** | |

The dominant term is Chrome's end-of-sentence detection, which has no API to
tune. Cutting it means publishing interim text before it is final, which risks
captions that change after they are shown — deliberately not done.

`maxOutputTokens` is capped at 300; the provider default of 64000 is a
meaningless ceiling for one spoken line (measured: no latency difference, but
it bounds a runaway response).

## Measured capacity

Simulated listener devices against the production build, each running the real
long-poll protocol:

| Devices | Delivered | Median latency | p95 |
|---|---|---|---|
| 10 | 100% | 83ms | 115ms |
| 30 | 100% | 66ms | 104ms |
| 60 | 100% | 84ms | 134ms |
| 100 (Redis) | 100% | 57ms | 108ms |

Latency is flat across that range — the server is not the constraint. The real
limits are the Wi-Fi access point (a consumer router realistically handles
25-50 active devices) and, on Vercel, function concurrency.

Presence was verified exact: 0 -> 25 -> 70 -> 0 as devices joined and left.

## Known limits

- **Nothing is persisted after the service.** The caption log expires; there is
  no transcript, so translation quality cannot be reviewed afterwards.
- **No test suite.** Delivery paths were verified by running the production
  build against scripted scenarios, not by automated tests.
- **Chrome/Edge only**, and Web Speech ships audio to Google's servers for
  recognition.
- `ARCHITECTURE_AUDIT.md` is a point-in-time audit from 2026-08-29. Several
  findings in it (silent cross-instance loss, dev-only QR code, no context
  between sentences, no recovery, missing icons) have since been addressed;
  the storage and feedback-loop findings still stand.
