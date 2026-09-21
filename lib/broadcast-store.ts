// Shared state for one live sermon.
//
// Two backends behind one interface:
//   - memory: a module-level object. Correct whenever there is exactly one
//     server process (local laptop, `next dev`, `next start`).
//   - redis:  Upstash over REST. Correct across serverless instances, which is
//     what Vercel actually gives you.
//
// The backend is chosen by whether Redis credentials exist, so the same code
// path runs locally and in production.
//
// Listeners read via long-poll (`waitForUpdate`) rather than SSE: a request
// that reads shared state works no matter which instance serves it, gives
// late joiners history for free, and has no maxDuration cliff to fall off.

import { getRedis, isRedisConfigured } from "./redis";
import { DEFAULT_LANGUAGE } from "./languages";

export type Caption = {
  seq: number;
  /** What the preacher said, in English. */
  source: string;
  /** The translation that went out to listeners. */
  text: string;
  /** Language code of `text` — captions outlive the session that made them. */
  lang: string;
  ts: number;
};

export type SessionState = {
  sessionId: string;
  live: boolean;
  /** Target language for this sermon, chosen by the preacher when starting. */
  lang: string;
  captions: Caption[];
  seq: number;
};

/** Captions retained for late joiners. ~15 minutes of speech. */
const HISTORY_LIMIT = 80;

/** A listener is counted as present if seen within this window. */
const LISTENER_TTL_MS = 25_000;

/**
 * How often an instance publishes its listener count to the shared store.
 *
 * Presence is the one piece of state that does not need to be exact: a count
 * up to 10s stale still answers "is this reaching the room?". Trading that
 * accuracy is what keeps presence O(instances) instead of O(devices).
 */
const PRESENCE_PUBLISH_MS = 10_000;

/** An instance's published count is ignored once it goes this stale. */
const PRESENCE_STALE_MS = 40_000;

const KEYS = {
  session: "ct:session",
  captions: "ct:captions",
  seq: "ct:seq",
  presence: "ct:presence",
};

/** Redis keys expire so an abandoned session cannot haunt the next one. */
const KEY_TTL_SECONDS = 6 * 60 * 60;

type Backend = {
  readonly name: "redis" | "memory";
  /** Milliseconds between reads while long-polling. */
  readonly pollIntervalMs: number;
  getState(): Promise<SessionState>;
  append(source: string, text: string, lang: string): Promise<Caption>;
  setLive(live: boolean, lang: string): Promise<SessionState>;
  listenerCount(localCount: number): Promise<number>;
  /** Distinct languages being listened to across every instance. */
  activeLanguages(local: string[]): Promise<string[]>;
  /** Announce this instance's count. Fire-and-forget; no-op with one process. */
  publishPresence?(localCount: number): void;
};

/** Identifies this server process among however many the platform runs. */
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Devices currently polling THIS instance, tracked in process memory.
 *
 * A heartbeat is now a Map write rather than a network round trip, so it costs
 * nothing no matter how many phones are in the room.
 */
const localListeners = new Map<string, { seen: number; lang: string }>();

function pruneLocalListeners() {
  const cutoff = Date.now() - LISTENER_TTL_MS;
  for (const [id, entry] of localListeners) {
    if (entry.seen < cutoff) localListeners.delete(id);
  }
}

function countLocalListeners() {
  pruneLocalListeners();
  return localListeners.size;
}

/** Distinct languages being listened to on this instance. */
function localLanguages() {
  pruneLocalListeners();
  return [...new Set([...localListeners.values()].map((e) => e.lang))];
}

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Memory backend ────────────────────────────────────────────────────────────

const memory = {
  sessionId: newSessionId(),
  live: false,
  lang: DEFAULT_LANGUAGE,
  captions: [] as Caption[],
  seq: 0,
};

const memoryBackend: Backend = {
  name: "memory",
  // Local reads are free, so poll tightly — this is the end-to-end latency
  // a listener pays on top of the model call.
  pollIntervalMs: 120,

  async getState() {
    return {
      sessionId: memory.sessionId,
      live: memory.live,
      lang: memory.lang,
      captions: memory.captions.slice(-HISTORY_LIMIT),
      seq: memory.seq,
    };
  },

  async append(source, text, lang) {
    const caption: Caption = {
      seq: ++memory.seq,
      source,
      text,
      lang,
      ts: Date.now(),
    };
    memory.captions.push(caption);
    if (memory.captions.length > HISTORY_LIMIT) {
      memory.captions = memory.captions.slice(-HISTORY_LIMIT);
    }
    return caption;
  },

  async setLive(live, lang) {
    if (live) {
      memory.sessionId = newSessionId();
      memory.captions = [];
      memory.seq = 0;
      memory.lang = lang;
    }
    memory.live = live;
    return memoryBackend.getState();
  },

  // One process means the local tally is already the whole picture.
  async listenerCount(localCount) {
    return localCount;
  },

  async activeLanguages(local) {
    return local;
  },
};

// ── Redis backend ─────────────────────────────────────────────────────────────

type StoredSession = { id: string; live: boolean; lang?: string };

function parseCaption(raw: unknown): Caption | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Caption;
    return typeof parsed?.seq === "number" ? parsed : null;
  } catch {
    return null;
  }
}

const redisBackend: Backend = {
  name: "redis",
  // Every instance coalesces its listeners onto one read at this interval
  // (see snapshot caching below), so this is reads/second/instance — not
  // reads/second/listener. Halved from 500ms: it costs one extra read per
  // second per instance and takes ~125ms off every caption's average delay.
  pollIntervalMs: 250,

  async getState() {
    const redis = getRedis()!;
    const [sessionRaw, captionsRaw, seqRaw] = await redis.pipeline([
      ["GET", KEYS.session],
      ["LRANGE", KEYS.captions, `-${HISTORY_LIMIT}`, "-1"],
      ["GET", KEYS.seq],
    ]);

    let session: StoredSession | null = null;
    if (typeof sessionRaw === "string") {
      try {
        session = JSON.parse(sessionRaw) as StoredSession;
      } catch {
        session = null;
      }
    }

    const captions = ((captionsRaw as unknown[]) ?? [])
      .map(parseCaption)
      .filter((c): c is Caption => c !== null);

    // The highest sequence issued — NOT the last item in the list.
    //
    // Those differ: captions for several languages are appended concurrently,
    // so list order does not follow sequence order. Reading the last element
    // could report a seq lower than a caption already in the list, leaving
    // every listener's cursor behind it and re-delivering that caption on
    // every poll — the same line repeating down the screen forever.
    const counter = Number(seqRaw);
    const highestInList = captions.reduce((max, c) => Math.max(max, c.seq), 0);

    return {
      sessionId: session?.id ?? "none",
      live: session?.live ?? false,
      lang: session?.lang ?? DEFAULT_LANGUAGE,
      captions,
      seq: Number.isFinite(counter)
        ? Math.max(counter, highestInList)
        : highestInList,
    };
  },

  async append(source, text, lang) {
    const redis = getRedis()!;
    const seq = Number(await redis.cmd(["INCR", KEYS.seq]));
    const caption: Caption = { seq, source, text, lang, ts: Date.now() };

    await redis.pipeline([
      ["RPUSH", KEYS.captions, JSON.stringify(caption)],
      ["LTRIM", KEYS.captions, `-${HISTORY_LIMIT}`, "-1"],
      ["EXPIRE", KEYS.captions, KEY_TTL_SECONDS],
      ["EXPIRE", KEYS.seq, KEY_TTL_SECONDS],
    ]);

    return caption;
  },

  async setLive(live, lang) {
    const redis = getRedis()!;
    const current = await redisBackend.getState();
    const session: StoredSession = {
      id: live ? newSessionId() : current.sessionId,
      live,
      lang: live ? lang : current.lang,
    };

    const commands: (string | number)[][] = [
      ["SET", KEYS.session, JSON.stringify(session), "EX", KEY_TTL_SECONDS],
    ];

    // A new sermon starts from a clean feed so listeners don't replay last week.
    if (live) {
      commands.push(["DEL", KEYS.captions], ["SET", KEYS.seq, 0, "EX", KEY_TTL_SECONDS]);
    }

    await redis.pipeline(commands);
    return redisBackend.getState();
  },

  /**
   * Sum what every instance last published.
   *
   * The previous version wrote one ZSET entry per device per poll, which cost
   * 4 commands x devices x sentences — roughly 400k commands for a 90-minute
   * service with 60 listeners, most of a month's free tier in one sitting.
   * Instances publish an aggregate instead, so this is now flat in device
   * count.
   */
  async listenerCount() {
    const redis = getRedis()!;

    await schedulePresence();

    const raw = (await redis.cmd(["HGETALL", KEYS.presence])) as
      | Record<string, string>
      | string[]
      | null;

    const entries = normaliseHash(raw);
    const now = Date.now();

    // Union, not sum. The same device can sit in two instances' memory while
    // its long-poll moves between them, and summing counted it twice.
    const devices = new Set<string>(localListenerIds());

    for (const [instanceId, value] of Object.entries(entries)) {
      if (instanceId === INSTANCE_ID) continue;

      try {
        const parsed = JSON.parse(value) as { ids?: string[]; ts: number };
        if (now - parsed.ts >= PRESENCE_STALE_MS) continue;
        for (const id of parsed.ids ?? []) devices.add(id);
      } catch {
        // Unreadable field — ignore rather than fail the status check.
      }
    }

    return devices.size;
  },

  /**
   * Union of languages across instances.
   *
   * This drives translation fan-out: the preacher speaks once and the sentence
   * is translated into exactly the languages someone is actually reading.
   */
  async activeLanguages(local) {
    const redis = getRedis()!;

    const raw = (await redis.cmd(["HGETALL", KEYS.presence])) as
      | Record<string, string>
      | string[]
      | null;

    const entries = normaliseHash(raw);
    const now = Date.now();
    const langs = new Set<string>(local);

    for (const [instanceId, value] of Object.entries(entries)) {
      if (instanceId === INSTANCE_ID) continue;

      try {
        const parsed = JSON.parse(value) as { langs?: string[]; ts: number };
        if (now - parsed.ts >= PRESENCE_STALE_MS) continue;
        for (const l of parsed.langs ?? []) langs.add(l);
      } catch {
        // Unreadable field — ignore.
      }
    }

    return [...langs];
  },
};

redisBackend.publishPresence = () => {
  void schedulePresence();
};

/** Upstash returns a hash as either an object or a flat [k, v, k, v] array. */
function normaliseHash(
  raw: Record<string, string> | string[] | null,
): Record<string, string> {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;

  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  return out;
}

let lastPublishedAt = 0;
let lastPublishedSignature: string | null = null;
let publishInFlight: Promise<void> | null = null;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;

/** Floor between publishes, so a burst of joins cannot become a burst of writes. */
const MIN_PUBLISH_GAP_MS = 1_000;

/** Changes when either membership or the set of languages changes. */
function presenceSignature() {
  return `${localListenerIds().join(",")}|${localLanguages().sort().join(",")}`;
}

/** Upper bound on published ids, so one instance cannot write a huge value. */
const MAX_PUBLISHED_IDS = 500;

function localListenerIds() {
  pruneLocalListeners();
  return [...localListeners.keys()].slice(0, MAX_PUBLISHED_IDS);
}

/**
 * Write this instance's listener IDS, not a count.
 *
 * Counts cannot be deduplicated. A phone whose long-poll is re-routed to
 * another instance is briefly held in both instances' memory, and summing
 * counts reported one device as two. Publishing ids lets readers take a union.
 */
async function writePresence(): Promise<void> {
  const redis = getRedis()!;
  const ids = localListenerIds();
  const langs = localLanguages();

  try {
    await redis.pipeline([
      [
        "HSET",
        KEYS.presence,
        INSTANCE_ID,
        JSON.stringify({ ids, langs, ts: Date.now() }),
      ],
      ["EXPIRE", KEYS.presence, KEY_TTL_SECONDS],
    ]);
    lastPublishedAt = Date.now();
    lastPublishedSignature = presenceSignature();
  } catch (error) {
    console.error("[presence] publish failed", error);
  }
}

/**
 * Publish this instance's listener count, on change with a trailing edge.
 *
 * A plain leading-edge throttle got this badly wrong: the first heartbeat of a
 * join burst published n=1, the window then swallowed the rest, and because
 * each device only heartbeats once per long-poll the correction was up to 20s
 * away. Seven listeners showed up on the preacher's screen as one.
 *
 * Publishing on change is affordable because membership changes are bounded by
 * real events (people arriving), not by poll frequency.
 */
function schedulePresence(): Promise<void> | void {
  const since = Date.now() - lastPublishedAt;

  const changed = presenceSignature() !== lastPublishedSignature;
  const stale = since >= PRESENCE_PUBLISH_MS;

  if (!changed && !stale) return;
  if (publishInFlight) return publishInFlight;

  // Enough time has passed — write immediately.
  if (since >= MIN_PUBLISH_GAP_MS) {
    publishInFlight = writePresence().finally(() => {
      publishInFlight = null;
      // Membership may have moved again while that write was in flight.
      if (presenceSignature() !== lastPublishedSignature) schedulePresence();
    });
    return publishInFlight;
  }

  // Too soon: land the final value on the trailing edge instead of dropping it.
  if (!trailingTimer) {
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      void schedulePresence();
    }, MIN_PUBLISH_GAP_MS - since);
  }
}

const backend: Backend = isRedisConfigured ? redisBackend : memoryBackend;

// ── Snapshot coalescing ───────────────────────────────────────────────────────
//
// Many listeners on one instance share a single in-flight read. Without this,
// N long-polling listeners would each hit Redis on every tick.

/** How long the active-language set may be stale. */
const ACTIVE_LANGUAGES_TTL_MS = 2_000;

let cachedLanguages: string[] | null = null;
let cachedLanguagesAt = 0;

let snapshotAt = 0;
let snapshotPromise: Promise<SessionState> | null = null;
let snapshotValue: SessionState | null = null;

function invalidateSnapshot() {
  snapshotAt = 0;
  snapshotValue = null;
}

async function snapshot(): Promise<SessionState> {
  const maxAge = backend.pollIntervalMs;

  if (snapshotValue && Date.now() - snapshotAt < maxAge) return snapshotValue;
  if (snapshotPromise) return snapshotPromise;

  snapshotPromise = backend
    .getState()
    .then((state) => {
      snapshotValue = state;
      snapshotAt = Date.now();
      return state;
    })
    .finally(() => {
      snapshotPromise = null;
    });

  return snapshotPromise;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const broadcastStore = {
  backend: backend.name,

  getState: snapshot,

  async append(source: string, text: string, lang: string) {
    const caption = await backend.append(source, text, lang);
    invalidateSnapshot();
    return caption;
  },

  async setLive(live: boolean, lang: string = DEFAULT_LANGUAGE) {
    const state = await backend.setLive(live, lang);
    // Must happen for BOTH backends: without it, a cached snapshot can serve
    // the previous sermon's session id and captions after a restart.
    invalidateSnapshot();
    return state;
  },

  /**
   * Record that a device is still listening. Free: memory only.
   * Returns this instance's local tally, which is all the feed response needs.
   */
  heartbeat(listenerId: string, lang: string = DEFAULT_LANGUAGE) {
    localListeners.set(listenerId, { seen: Date.now(), lang });
    const count = countLocalListeners();

    // Publish from the LISTENER path too, not just the preacher's status poll.
    // Previously only listenerCount() triggered a publish, and that runs on
    // whichever instance the PREACHER hits — so a listener served by a
    // different serverless instance was tracked in memory and never announced,
    // and the preacher's screen showed "No one connected yet" for a full room.
    // Throttled internally to once per PRESENCE_PUBLISH_MS, so this is cheap.
    backend.publishPresence?.(count);

    return count;
  },

  /** Total across every instance — what the preacher's screen shows. */
  listenerCount() {
    return backend.listenerCount(countLocalListeners());
  },

  /**
   * Languages to translate into right now. Empty when nobody has joined.
   *
   * Cached briefly: this sits directly in the speaking path, and the set of
   * languages in a room changes on the timescale of people arriving, not of
   * sentences being spoken.
   */
  async activeLanguages() {
    if (
      cachedLanguages &&
      Date.now() - cachedLanguagesAt < ACTIVE_LANGUAGES_TTL_MS
    ) {
      return cachedLanguages;
    }

    cachedLanguages = await backend.activeLanguages(localLanguages());
    cachedLanguagesAt = Date.now();
    return cachedLanguages;
  },

  /**
   * Long-poll. Resolves as soon as there is something the caller has not seen:
   * a newer caption, or a different session (preacher restarted).
   *
   * Always resolves — on timeout it returns the current state, which the client
   * treats as a successful empty poll and immediately re-requests. That keeps
   * the connection short-lived and self-healing rather than long-lived and
   * fragile.
   */
  async waitForUpdate(
    since: number,
    sessionId: string | null,
    knownLive: boolean | null,
    timeoutMs: number,
  ): Promise<SessionState> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const state = await snapshot();

      const newSession = sessionId !== null && sessionId !== state.sessionId;
      const hasNew = state.seq > since;

      // Starting and ending a sermon change neither the sequence nor the
      // session id, so without this a device only noticed when its own poll
      // window expired — up to 20s later, and at a different moment on every
      // phone, which reads as random lag rather than one shared event.
      const liveChanged = knownLive !== null && knownLive !== state.live;

      if (newSession || hasNew || liveChanged || Date.now() >= deadline) {
        return state;
      }

      const remaining = deadline - Date.now();
      await new Promise((r) =>
        setTimeout(r, Math.min(backend.pollIntervalMs, Math.max(remaining, 0))),
      );
    }
  },
};
