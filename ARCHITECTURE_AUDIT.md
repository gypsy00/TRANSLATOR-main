# Architecture Audit — `TRANSLATOR-main`

**Date:** 2026-08-29
**Scope:** Analysis only. No code changed.

---

## 0. Scope correction (read this first)

You asked for an audit of the **sports betting analytics tool**. This repository is
the **sermon translator**. There is no betting code here — not a module, not a
stub, not a comment.

I grepped the entire tree (excluding `node_modules`, `package-lock.json`) for
`bet|odds|vig|edge|stake|roi|wager|bookmaker|kelly`. Three files matched. All
three were false positives: `wakeLock`, `justify-between`, and the word
`navigate` in the README.

So this audit covers what exists. Consequences:

- **Step 1** is answered in full, for the translator.
- **Step 2** (four-layer map) is answered in full for the translator, and I've
  flagged what the same framework reveals. The betting version cannot be done —
  I'd be transcribing your description back to you, which is the opposite of what
  you asked for.
- **Step 3** is answered in full for the translator.
- **Step 4** is answered, but with an explicit confidence discount, because a
  two-project hypothesis tested against one project is a weak test. The answer
  still turned out to be informative — see §4.

**Open question for you:** where does the betting tool live? Same machine,
different directory? Different machine? Or is it a spreadsheet plus your head,
with no repo at all? *That last answer would itself be the single most important
finding in this whole exercise*, and I'd want to write it down rather than
quietly work around it.

---

## 1. Audit — what actually exists

### 1.1 Stack

| Item | Value |
|---|---|
| Name | `church-translator` v0.1.0 |
| Framework | Next.js 16.2.1, App Router |
| Runtime deps | 7 total |
| Language | TypeScript 5, strict via `tsconfig` |
| Styling | Tailwind CSS v4 |
| AI | Vercel AI SDK v6 + `@ai-sdk/anthropic`, `claude-haiku-4-5-20251001` |
| Transport | Server-Sent Events |
| Speech | Web Speech API (browser-native, not a dependency) |

`@ai-sdk/openai` is declared in `package.json` and **imported nowhere**. Dead
dependency.

### 1.2 Size — the honest number

**795 lines of TypeScript across 11 files.** That is the whole system.

But the distribution matters more than the total:

| File | Lines | What it really is |
|---|---:|---|
| `app/broadcast/page.tsx` | 259 | ~110 logic, ~150 JSX/Tailwind |
| `app/listen/page.tsx` | 139 | ~35 logic, ~105 JSX/Tailwind |
| `app/page.tsx` | 61 | 100% presentational |
| `app/layout.tsx` | 45 | boilerplate |
| `app/api/stream/route.ts` | 58 | SSE plumbing — the most careful code here |
| `app/api/translate/route.ts` | 34 | one LLM call |
| `app/manifest.ts` | 25 | PWA boilerplate |
| `app/api/network-info/route.ts` | 21 | IP lookup for the QR code |
| `lib/broadcast-store.ts` | 22 | a `Set` with three methods |

**The actual pipeline — capture, translate, fan out, render — is roughly 150
lines.** Everything else is interface. Hold onto that ratio; it becomes the
central evidence in §4.

### 1.3 What runs

- **Runs:** the full loop. Speech capture → `POST /api/translate` → Haiku →
  in-memory fan-out → SSE → listener render. The design is coherent and the code
  does what the README says.
- **Cannot run right now:** `node_modules` is empty. Nothing has been installed
  in this checkout. I could not execute a build, so every claim below is from
  reading source, not from running it.
- **Probably broken in production:** see §1.7.

### 1.4 Dead code and broken references

- `app/manifest.ts` declares `/icon-192.png` and `/icon-512.png`. **Neither
  exists.** `public/` holds only the five stock Next.js SVGs (`file`, `globe`,
  `next`, `vercel`, `window`), none of which are referenced by any source file.
  The PWA install is therefore iconless.
- `@ai-sdk/openai` — unused.
- `next.config.ts` hardcodes `allowedDevOrigins: ["192.168.5.40"]`. A specific
  Wi-Fi network, frozen into config. This is a fossil of a real room.
- `/api/network-info` returns `port: 3000` hardcoded. Correct for `next dev`,
  wrong for `next start` or any deploy. The QR code is a **dev-mode-only
  feature**.

### 1.5 Where data comes from

One source: **the preacher's microphone**, via the browser's Web Speech API.

No external APIs, no scraping, no fixtures, no seed data, no manual entry, no
config-driven inputs. Chrome/Edge only — `startBroadcast` bails with an error
message on any other browser. Note that Web Speech in Chrome ships audio to
Google's servers for recognition, so there is a silent third-party dependency in
the hot path that appears nowhere in `package.json`.

### 1.6 How data is stored

**It isn't.** This is the most consequential finding in the audit.

- No database. No ORM. No file writes. No `localStorage`. No analytics.
- The only "schema" in the entire codebase is `type Caption = { text: string; ts: number }`.
- `lib/broadcast-store.ts` is a module-level `Set<Handler>` — subscribers, not
  messages. It has no history and no buffer.
- Listeners keep the last 100 captions in React state (`prev.slice(-99)`) and
  lose all of them on refresh.
- A listener who connects at 11:05 sees nothing from 11:00. There is no replay.
- **No sermon has ever been recorded.** The system has no memory of any session
  it has run.

Consequences you should sit with: there is no corpus of past translations, so no
way to evaluate quality, spot regressions, compare prompts, or improve. `ts` is
generated server-side at broadcast time — it is a display key, not a real
provenance timestamp, and it is the closest thing to an audit trail that exists.

### 1.7 The production correctness problem

`lib/broadcast-store.ts` is **per-process memory**. The README acknowledges this
and defers it to a future Upstash swap.

But the README also advertises a live Vercel deployment. On Vercel's Fluid
Compute, the preacher's `POST /api/translate` and a listener's `GET /api/stream`
have **no guarantee of landing on the same instance**. When they don't, the
broadcast goes to a `Set` that contains nobody.

The failure is completely silent:

- `/api/translate` returns `200 OK` with the Ukrainian text.
- The preacher's screen shows "Last sent" and increments the counter.
- The listener's dot is **green** — the SSE connection is genuinely open and
  heartbeating every 15s.
- No captions arrive, and no error is raised anywhere.

**Every indicator in the UI reports success while the system delivers nothing.**
This is the sharpest engineering finding in the repo, and it is worth
understanding as a category, not just a bug — see §3.2.

`maxDuration = 300` adds a second ceiling: the SSE connection is severed after
five minutes. `EventSource` auto-reconnects, so it partly self-heals — but on
reconnect the listener re-subscribes to a store with no history and loses any
line spoken during the gap, and on Vercel may reconnect onto a *different*
instance than before.

### 1.8 Tests

**None.** No test files, no runner, no `test` script, no CI config, no
`playwright`/`vitest`/`jest` anywhere. Coverage is zero.

Not necessarily wrong for a 795-line personal project — but it means the SSE
lifecycle (the one genuinely fiddly piece: subscribe, heartbeat, cancel, double
cleanup) has never been verified except by using it.

### 1.9 Git history

**There is no git repository.** `git status` → `fatal: not a git repository`.
There is a `.gitignore`, so this was *once* under version control, or was
scaffolded expecting to be.

I therefore **cannot answer your question about commit activity or how the
project evolved.** No commits, no branches, no messages, no dates. The only
temporal signal available is filesystem mtimes: source files at `Mar 27 18:48`
(uniform — consistent with a copy/extract, not authorship), directories touched
`Aug 29 09:53`.

Note also `repomix-output.xml` (36KB, `Aug 29 09:55`) in the root — the repo was
packaged for LLM consumption today. Directory named `TRANSLATOR-main` is the
naming convention of **a GitHub zip download**, not a clone. That is very likely
what this is.

---

## 2. The four-layer map

Applied to the translator. The betting layers are marked unassessable.

### Layer 1 — Ingest

**Automated:** continuous speech capture. `recognition.continuous = true`,
`interimResults = true`. Sentence segmentation is delegated entirely to the
browser's `isFinal` flag — there is no custom chunking, punctuation logic, or
buffering. `onend` immediately restarts recognition, which is the standard
workaround for Chrome's silent auto-stop.

**Manual:** the preacher decides when to start and stop, and must be on the right
browser, on the right network, with the mic permitted.

**Freshness:** freshness is not a concept here. Audio is inherently live; there
is no cache to go stale.

**On missing/stale:** this is where it's thin. `no-speech` errors are explicitly
swallowed (`if (event.error === "no-speech") return;`) — correct, since silence
between sentences is normal. But every other mic error tears down the whole
broadcast into a full-screen error state requiring a manual "Try Again." There is
no retry, no degradation, no partial recovery. **A transient mic glitch
mid-sermon ends the broadcast**, and the listeners see only a caption feed that
quietly stops.

### Layer 2 — Transform

**Automated:** one `generateText` call. That's it.

**There is no deterministic maths in this system at all.** No parsing, no
normalisation, no scoring, no thresholds, no branching on content. The transform
layer is a single opaque model call with a fixed four-line system prompt, no
temperature setting, no retries, no timeout, no validation of the output, and no
conversational context — **each sentence is translated in total isolation from
the ones before it.**

That last point is a substantive quality issue, not a nitpick. Ukrainian is
heavily inflected and grammatical gender/case carry across sentences; a pronoun
or a referent from the previous line is simply unavailable to the model. A
scripture quotation split across two `isFinal` boundaries is translated as two
unrelated fragments.

This is the layer where your betting tool would hold de-vigging, implied
probability, and edge calculation. **Here it is empty.** The comparison is
instructive: the translator has no transform layer because the model *is* the
transform. Your betting framework has a real one — and it's the part most
obviously ready to be code.

### Layer 3 — Judgement

**This layer does not exist in the code, and its absence is the finding.**

The system makes exactly one judgement: *what is the good Ukrainian rendering of
this English sentence?* — a genuinely hard, context-sensitive, quality-graded
call involving register, theological vocabulary, and idiom.

It is **100% delegated to Claude Haiku** and never inspected. There is no
confidence score, no fallback, no human review, no flagging of uncertain output,
no comparison against anything. The one place a human could intervene — the
preacher's screen showing "Last sent" in both languages — is display-only. There
is no correct button, no retry, no suppress. **The preacher can see a bad
translation go out and can do nothing about it.**

Assessed against your three categories, for the judgements this system faces:

| Judgement | Category | Note |
|---|---|---|
| Sentence boundary detection | **Encodable rule** | Currently outsourced to `isFinal`; punctuation/pause heuristics would do better |
| Translation quality | **Genuine pattern recognition** | Correctly delegated to a model. This is the one thing here that shouldn't be a rule |
| "Is this output good enough to send?" | **Approximable heuristic** | Length ratio, script check, empty-output check. All absent. Nothing is validated |
| "Is the room following?" | **Human** | Not modelled. No feedback channel from listeners exists |

### Layer 4 — Decision & record

**Decision:** there is no decision. Every recognised sentence is translated.
Every translation is broadcast. There is no gate, no threshold, no equivalent of
your no-bet discipline. The only branch in the entire pipeline is
`if (!text?.trim())` → 400.

**Record:** nothing is recorded. See §1.6. `sentenceCount` is a counter that
resets to 0 on every `startBroadcast` and lives only in component state. The
idle screen's "Last session: N sentences translated" is misleading — it survives
only until the page is refreshed, and it is the sole retrospective statistic the
system produces.

**There is no feedback loop of any kind.** Nothing measures whether a translation
was good. Nothing measures whether listeners understood. This is the layer where
your betting tool's ROI and CLV tracking would live, and it is precisely the
layer that is most absent here.

### Layer summary

| Layer | In code | In your head / absent |
|---|---|---|
| Ingest | Capture, restart, error surfacing | When to run; recovery |
| Transform | One model call | Everything deterministic (there is none) |
| Judgement | Nothing | All of it — delegated to the model, unexamined |
| Decision | Nothing (unconditional) | No gate exists |
| Record | Nothing | All of it — no memory at all |

**Read the right-hand column.** You asked me to find where the line sits between
your judgement and the software. In this repo the line is almost all the way
over: **the code is a transport layer with a model call in the middle.** It moves
words from a mouth to a screen very nicely and decides nothing.

---

## 3. Domain conditions

Described as engineering properties, independent of subject matter.

### 3.1 Time budget

The system is **soft real-time with a human-perceptual deadline**. Nothing throws
when it's late; the output just degrades from useful to distracting.

The chain, structurally (I could not run the app — these are reasoned estimates,
not measurements):

| Stage | Est. | Controlled by |
|---|---|---|
| Speech → `isFinal` | ~0.5–1.5s | Chrome's endpointing. Not yours |
| Network → `/api/translate` | ~20–100ms | Wi-Fi / Vercel |
| Haiku generation | ~300–800ms | Model. Not yours |
| Broadcast + SSE → paint | ~10–50ms | Yours |
| **Total** | **~1–2.5s** | |

**The two largest terms are both outside your code**, and neither is optimised or
even measured. Meanwhile the smallest term — SSE fan-out — is the part that
received the most careful engineering. There is no instrumentation anywhere;
`ts` is stamped at broadcast, so even a rough end-to-end latency cannot be
reconstructed.

**Worthlessness threshold:** roughly 3–4 seconds. Past that, a listener reading
caption *n* is hearing the preacher speak sentence *n+2*, and the caption
actively competes with the room rather than supporting it. Critically, **the
system has no concept of this deadline** — a caption 30 seconds late renders
identically to one that is on time, with equal prominence, at the bottom of the
feed.

### 3.2 Failure modes

Ranked by nastiness, which correlates almost perfectly with silence:

| # | Failure | Silent? | Detection |
|---|---|---|---|
| 1 | Cross-instance broadcast loss (§1.7) | **Totally** | None. Every indicator reads healthy |
| 2 | Mistranslation | **Totally** | None. Requires a bilingual human in the room |
| 3 | Mis-recognition (homophone, accent, proper noun) | **Totally** | Interim text — but the preacher is preaching, not proofreading |
| 4 | Lost sentence during 5-min reconnect | **Totally** | None. The feed just has a hole |
| 5 | Dropped context across sentences | **Totally** | None. Structural, always on |
| 6 | Listener joins late | Semi | Empty screen, indistinguishable from "not started" |
| 7 | Translation API failure | No | Red banner to preacher; listeners see silence |
| 8 | Mic error | No | Full-screen error, broadcast ends |
| 9 | Unsupported browser | No | Caught upfront |

**Five of the top six are fully silent, and the top five are all silent.** The
loud failures are the trivial ones. This is a system that fails invisibly by
default — and it is worse than that: **failure mode 1 actively displays green
success indicators while delivering nothing.**

### 3.3 Feedback loops

You asked for this gap to be made explicit. Here it is, and the answer is
starker than in the betting case.

| Loop | Latency | Exists in code? |
|---|---|---|
| Preacher sees interim text ("is it hearing me?") | ~200ms | **Yes** — the only real loop in the system |
| Listener sees caption appear | ~1–2.5s | Yes, but one-way |
| Listener understands / doesn't | — | **No channel. Ever.** |
| Translation quality assessment | — | **Never happens** |
| Was this sermon well served? | — | **Never happens** |

Your betting tool has CLV (fast, hours) and ROI (slow, months). **The translator
has one fast loop and then nothing at all.** There is no slow loop, because the
slow loop requires persistence and the system stores nothing.

This is the structural difference between the two projects, and it cuts against
your hypothesis rather than for it. Betting is a *learning* system with loops at
two timescales. The translator is an *open-loop delivery pipe*. They are not the
same shape.

### 3.4 State changing underneath

- **Subscriber set** — mutates continuously as phones connect, sleep, and drop.
- **Speech recognition session** — silently dies and restarts via `onend`;
  in-flight audio at the boundary is lost.
- **Wake lock** — released by the OS on tab-hide, and **never re-acquired**.
  There is no `visibilitychange` handler. A listener who checks a message loses
  the lock permanently for that session.
- **Serverless instance identity** — the substrate itself can change mid-session.
  This is the state change that causes failure #1, and it is invisible to the app.
- **The room** — people arrive late. Modelled nowhere.

### 3.5 Intrinsic vs. artefact

This separation is the useful part of the analysis, so I want to be precise.

**Intrinsic to live translation:**
- Sub-3-second budget, set by human conversation pacing.
- Speech recognition and translation quality are irreducibly probabilistic.
- Listeners join mid-stream.
- The ultimate quality signal (did a person understand?) is not observable from
  inside the system. This is real and permanent.

**Artefacts of how you built it:**
- Silent cross-instance loss — an in-memory store on serverless. A choice.
- No persistence — a choice, and the one that eliminates every slow loop.
- No context between sentences — a choice; the AI SDK supports message history.
- No output validation — a choice.
- No instrumentation — a choice.
- Dev-only QR (`port: 3000`, hardcoded `192.168.5.40`) — a choice.
- Chrome/Edge only — largely forced by Web Speech.
- No tests — a choice.

**The intrinsic list is short and mostly about uncertainty. The artefact list is
long and mostly about memory and observability.** That asymmetry is itself the
finding: the hard parts of this domain are not the parts you engineered around.

---

## 4. The domain question

Your hypothesis: both standout projects are **real-time decision support** —
messy live feed → something a human can act on immediately.

Competing explanation: what drew you in was **the conditions** — a real user,
sole ownership, a visible outcome — and the domain is incidental.

I can only test this against one project. That's a real limitation. But the one
project is unusually clear.

### The case FOR the hypothesis

- The ingest half genuinely fits. A live, noisy, unbounded feed with no replay
  and a hard perceptual deadline is exactly the hard part of real-time systems,
  and you chose it twice.
- The SSE implementation is the most competent code in the repo: heartbeat
  against proxy timeouts, `X-Accel-Buffering: no`, cleanup on both the error path
  and `cancel()`, `force-dynamic`. Nobody writes that by accident. **You have
  real instincts for live data transport.**
- Both projects reduce a fast, messy stream into a single legible thing for a
  human under time pressure.
- `no-speech` suppression and `onend` auto-restart show you've debugged live
  streaming under real conditions.

### The case AGAINST

This is stronger, and it rests on three things.

**1. There is no decision.** "Decision support" requires a decision. This system
translates and displays every single sentence unconditionally. It has no gate, no
threshold, no confidence, no abstention — no analogue whatsoever to the no-bet
discipline you describe as central to your betting framework. **The listener
doesn't act on the output; they comprehend it.** Comprehension is not a decision,
and support for it is not decision support. This is a real-time *translation and
delivery* system. Those are different domains with different hard parts.

**2. The effort distribution points somewhere else entirely.** This is the
evidence I find hardest to argue with:

- ~150 lines of pipeline.
- ~340 lines of interface.
- Screen wake lock on **both** roles — because phones sleep during sermons.
- QR onboarding, because you cannot ask a congregation to type a URL.
- Live interim text, so the preacher can *see it's hearing them* and trust it.
- "Waiting for the service to begin… 🕊️" — an empty state written with care.
- Previous captions faded, latest caption prominent — someone thought about
  reading while listening.
- `allowedDevOrigins: ["192.168.5.40"]` — **a specific church's Wi-Fi, fossilised
  in config.**

Now the counterfactual. Someone gripped by the *technical domain* of real-time
systems, given this exact problem, would have built: reconnection with message
replay, sequence numbers and ordering guarantees, latency instrumentation,
persistence, a backpressure story. **This repo has none of those.** Every one of
them is absent while the wake lock is handled on both roles.

Instead, every hour went into **a person in a room having a good experience.**
That's not the profile of someone drawn to the domain. That is precisely the
profile of someone drawn to a real user with a visible outcome.

**3. Your own account of the betting tool says the same thing.** You describe the
framework as living in your head, with the software as a record-keeper. If the
technical domain were the draw, the inference engine is the interesting part and
would have been built. It wasn't. In both projects, **the technically hard core
is delegated** — to a model here, to your own cognition there — and the effort
goes into the surface a human touches.

### My read

**The evidence supports the competing explanation, not your hypothesis.**

More precisely — and I think this is the accurate statement rather than a
softened one:

> You are drawn to **being the whole system for a real person.** Sole ownership,
> a live outcome you can watch land, and a user you can see. Real-time is not the
> domain you love; it is the setting that makes ownership *visible*, because a
> live system tells you immediately whether you got it right.

Three specifics that make me confident:

- **You keep the judgement.** In the betting tool by your own description; here
  by delegating it to a model and never inspecting the result. In neither project
  did you try to build an inference engine. If real-time decision support were
  the pull, that is the exact thing you'd have reached for.
- **You build no memory.** No persistence here, no automated record there.
  Someone in love with decision systems builds the feedback loop first, because
  that's how decisions improve. You built the moment instead — twice.
- **You engineer the room, not the pipeline.** The wake lock, the QR, the
  interim text, the fossilised Wi-Fi address. That's care about *a specific
  occasion*, not about a class of technical problem.

There's a genuine strength in this: the empty state, the QR onboarding, and the
"is it hearing me?" affordance are better product instincts than most CS
graduates have. That's a real and marketable thing. It is just **not the thing
your hypothesis claims it is**, and choosing a career direction from the wrong
read would be an expensive mistake.

### What would actually falsify my read

I'd want to be wrong carefully, so here is what would change my mind — and note
that the betting repo can settle most of it:

- **De-vigging and edge calculation exist in code.** That would prove you build
  inference when the domain rewards it, and my "you keep the judgement" claim
  collapses.
- **A predictions/results table with real historical rows.** That would prove you
  build slow feedback loops, and "you build no memory" collapses.
- **Genuine no-bet logic in code**, not just in your head. That would make
  "decision support" literally accurate.

If all three are there, your hypothesis is right and this repo is simply the
weaker of the two projects. **If none are there — if the betting repo is also a
beautiful interface over a manual process — then the pattern holds across both,
and it's a pattern about conditions, not domain.**

That single check is the highest-value hour you could spend. I'd point me at that
repo next.

---

## 5. Diagram

```
  PREACHER (Chrome/Edge only)                    LISTENER (any phone)
  ┌──────────────────────────┐                  ┌──────────────────────┐
  │ Web Speech API           │                  │ EventSource          │
  │  continuous, interim     │                  │  auto-reconnect      │
  │  ↓ isFinal               │                  │  ↑ no replay ✗       │
  │ interim text ──┐         │                  │ last 100 in state    │
  └────────────────┼─────────┘                  │  ✗ lost on refresh   │
      ~0.5–1.5s    │ ONLY FEEDBACK LOOP         └──────────▲───────────┘
                   │ (~200ms)                              │ SSE
        POST /api/translate                        GET /api/stream
                   │                              (maxDuration 300s ✗)
                   ▼                                       │
        ┌──────────────────────┐                           │
        │ Claude Haiku         │  no context between       │
        │ fixed system prompt  │  sentences ✗              │
        │ no retry/validation ✗│  ~300–800ms               │
        └──────────┬───────────┘                           │
                   ▼                                       │
        ┌────────────────────────────────────┐             │
        │ broadcastStore — Set<Handler>      │─────────────┘
        │ IN-MEMORY, PER-PROCESS             │
        │ ⚠ silent total loss across         │
        │   serverless instances             │
        │ ✗ no history, no persistence       │
        └────────────────────────────────────┘

  NO DATABASE   ·   NO TESTS   ·   NO GIT   ·   NO METRICS
  NO SLOW FEEDBACK LOOP OF ANY KIND
```

---

## 6. Questions I need answered

1. **Where is the betting repository?** Everything in §4 is provisional until I
   see it.
2. **Has the translator run in a real service?** `192.168.5.40` suggests yes. If
   so: what actually broke, and did anyone tell you a translation was wrong?
3. **Why is there no git history?** Deliberate, or is this a downloaded zip and
   the real repo is elsewhere with its history intact?
4. **Does the deployed Vercel URL actually work?** Given §1.7 I'd expect
   intermittent silent failure. If it has always worked, I want to know why —
   it would mean I've misread the deployment topology.
