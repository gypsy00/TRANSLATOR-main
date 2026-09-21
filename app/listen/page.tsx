"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { DEFAULT_LANGUAGE, LANGUAGES, getLanguage } from "@/lib/languages";

type Caption = { seq: number; text: string; ts: number };
type Connection = "connecting" | "live" | "offline";

const TEXT_SIZES = [
  { label: "A", latest: "text-xl", previous: "text-base" },
  { label: "A", latest: "text-2xl", previous: "text-lg" },
  { label: "A", latest: "text-3xl", previous: "text-xl" },
  { label: "A", latest: "text-4xl", previous: "text-2xl" },
] as const;

const DEFAULT_SIZE = 1;
const SIZE_KEY = "ct:textSize";
const LANG_KEY = "ct:lang";
const MAX_CAPTIONS = 200;

export default function ListenPage() {
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [live, setLive] = useState(false);
  const [lang, setLang] = useState(DEFAULT_LANGUAGE);
  const [sizeIndex, setSizeIndex] = useState(DEFAULT_SIZE);
  const [autoScroll, setAutoScroll] = useState(true);

  const bottomRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // ── Screen wake lock ────────────────────────────────────────────────────────
  // The OS releases the lock whenever the tab is hidden and never gives it back
  // on its own. Without the visibilitychange handler, one glance at a text
  // message meant the phone slept for the rest of the service.
  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // Not critical — some browsers refuse without a user gesture.
    }
  }, []);

  useEffect(() => {
    requestWakeLock();

    const onVisible = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [requestWakeLock]);

  // ── Text size preference ────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const storedSize = Number(localStorage.getItem(SIZE_KEY));
      if (Number.isInteger(storedSize) && TEXT_SIZES[storedSize]) {
        setSizeIndex(storedSize);
      }

      const storedLang = localStorage.getItem(LANG_KEY);
      if (storedLang && LANGUAGES.some((l) => l.code === storedLang)) {
        setLang(storedLang);
      }
    } catch {
      // Private mode — stick with the defaults.
    }
  }, []);

  /**
   * Switching language starts a fresh feed.
   *
   * Captions are stored once per language, so the existing ones are in the old
   * language and the cursor refers to them. Clearing both, and letting the poll
   * effect restart on `lang`, re-fetches this language's history from scratch.
   */
  const changeLanguage = (code: string) => {
    setCaptions([]);
    setLang(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      // Not critical.
    }
  };

  const cycleSize = () => {
    setSizeIndex((current) => {
      const next = (current + 1) % TEXT_SIZES.length;
      try {
        localStorage.setItem(SIZE_KEY, String(next));
      } catch {
        // Ignore — the size still applies for this session.
      }
      return next;
    });
  };

  // ── Caption feed (long-poll) ────────────────────────────────────────────────
  useEffect(() => {
    // Two levels of abort: one for unmount, one per in-flight request so a
    // waking phone can drop a dead socket without tearing down the loop.
    const controller = new AbortController();
    let requestController: AbortController | null = null;
    let wokeUp = false;

    // Stable per-tab id so the preacher's listener count reflects devices,
    // not reconnect attempts.
    let listenerId: string;
    try {
      listenerId = sessionStorage.getItem("ct:listenerId") ?? "";
      if (!listenerId) {
        listenerId = Math.random().toString(36).slice(2);
        sessionStorage.setItem("ct:listenerId", listenerId);
      }
    } catch {
      listenerId = Math.random().toString(36).slice(2);
    }

    let since = 0;
    let sessionId: string | null = null;
    // Tracked here rather than from React state: the poll loop's closure would
    // not see a state update, and this must reflect the last server response.
    let knownLive: boolean | null = null;
    let failures = 0;
    let stopped = false;

    async function poll() {
      while (!stopped) {
        try {
          const query = new URLSearchParams({
            since: String(since),
            id: listenerId,
            lang,
          });
          if (sessionId) query.set("session", sessionId);
          if (knownLive !== null) query.set("live", knownLive ? "1" : "0");

          requestController = new AbortController();
          const onUnmount = () => requestController?.abort();
          controller.signal.addEventListener("abort", onUnmount);

          let res: Response;
          try {
            res = await fetch(`/api/captions?${query}`, {
              signal: requestController.signal,
              cache: "no-store",
            });
          } finally {
            controller.signal.removeEventListener("abort", onUnmount);
          }

          if (!res.ok) throw new Error(`Feed ${res.status}`);

          const data = await res.json();
          if (stopped) return;

          failures = 0;
          setConnection("live");
          knownLive = Boolean(data.live);
          setLive(knownLive);

          // The preacher restarted: drop the old sermon rather than
          // interleaving two services in one feed.
          if (data.sessionChanged) {
            setCaptions(data.captions ?? []);
          } else if (data.captions?.length) {
            // Belt and braces: never show the same sequence twice, whatever
            // the server sends. A cursor bug once re-delivered one caption on
            // every poll, filling the screen with the same line.
            setCaptions((prev) => {
              const seen = new Set(prev.map((c) => c.seq));
              const fresh = (data.captions as Caption[]).filter(
                (c) => !seen.has(c.seq),
              );
              if (!fresh.length) return prev;
              return [...prev, ...fresh].slice(-MAX_CAPTIONS);
            });
          }

          sessionId = data.sessionId;
          // Take the server's sequence verbatim. Clamping this upward looks
          // defensive but breaks session restarts: seq resets to 0 while the
          // old cursor sits at 8, so every new caption fails `seq > since` and
          // the listener's screen freezes on "Live" for the rest of the service.
          since = Number(data.seq) || 0;
        } catch {
          if (stopped || controller.signal.aborted) return;

          // We aborted this request ourselves because the device woke up. The
          // socket was probably dead anyway — retry at once instead of serving
          // a backoff the user would experience as a frozen screen.
          if (wokeUp) {
            wokeUp = false;
            failures = 0;
            continue;
          }

          failures += 1;
          // One blip is normal on mobile. Only tell the congregation something
          // is wrong once it is actually wrong.
          if (failures >= 2) setConnection("offline");

          const backoff = Math.min(1000 * 2 ** (failures - 1), 8000);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    // A phone that has been pocketed comes back holding a socket the network
    // quietly dropped. Without this it sits on that dead request until the OS
    // errors it out, then waits out a backoff — up to ~10s of blank screen
    // every time someone looks at their phone.
    const reconnectNow = () => {
      if (stopped || document.visibilityState !== "visible") return;
      wokeUp = true;
      requestController?.abort();
    };

    // Only a bfcache restore matters here; a plain pageshow fires on first
    // load and would pointlessly abort the very first poll.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reconnectNow();
    };

    document.addEventListener("visibilitychange", reconnectNow);
    window.addEventListener("online", reconnectNow);
    window.addEventListener("pageshow", onPageShow);

    poll();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", reconnectNow);
      window.removeEventListener("online", reconnectNow);
      window.removeEventListener("pageshow", onPageShow);
      controller.abort();
    };
  }, [lang]);

  // ── Auto-scroll ─────────────────────────────────────────────────────────────
  // Stop fighting the reader: if they scroll up to re-read a line, stay there.
  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 120);
  };

  useEffect(() => {
    if (!autoScroll) return;

    const el = feedRef.current;
    if (!el) return;

    // Set scrollTop directly rather than a smooth scrollIntoView. A smooth
    // scroll fires scroll events the whole way down, and each one ran the
    // handler above — which saw a large distance-from-bottom mid-flight and
    // switched auto-scroll off, leaving the history parked at the top with a
    // "Jump to latest" button on a feed that had just opened.
    el.scrollTop = el.scrollHeight;
  }, [captions, autoScroll]);

  const language = getLanguage(lang);
  const size = TEXT_SIZES[sizeIndex];
  const latest = captions[captions.length - 1];

  const statusLabel =
    connection === "offline"
      ? "Reconnecting…"
      : connection === "connecting"
        ? "Connecting…"
        : live
          ? "Live"
          : captions.length > 0
            ? "Ended"
            : "Connected";

  const isLive = connection === "live" && live;

  // The service ending and the connection dropping look identical from a phone
  // unless we say so. Captions are deliberately kept readable: the closing
  // blessing and scripture references are the lines people most want after
  // the service, and clearing them would be irreversible.
  const hasEnded = connection === "live" && !live && captions.length > 0;

  const statusColor =
    connection === "offline"
      ? "bg-amber-400"
      : isLive
        ? "bg-emerald-500"
        : "bg-gray-500";

  return (
    <main className="h-dvh bg-gray-950 text-white flex flex-col">
      <header className="shrink-0 z-20 bg-gray-950/80 backdrop-blur-md border-b border-gray-800/50 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-gray-500 hover:text-white transition-colors text-sm"
            aria-label="Back"
          >
            ←
          </Link>
          <span className="text-lg" aria-hidden>
            {language.flag}
          </span>
          {/* Looks like a control, not a label: this is the one thing a
              listener may need to change, and it must be obviously tappable. */}
          <div>
            <label htmlFor="listen-language" className="sr-only">
              Choose your language
            </label>
            <div className="relative inline-flex items-center rounded-lg border border-gray-700 bg-gray-900 hover:border-gray-500 transition-colors">
              <select
                id="listen-language"
                value={lang}
                onChange={(e) => changeLanguage(e.target.value)}
                className="appearance-none bg-transparent font-semibold text-sm tracking-tight text-white pl-3 pr-7 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-lg cursor-pointer"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-gray-900">
                    {l.native}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2.5 text-[10px] text-gray-400">
                ▼
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={cycleSize}
            className="px-2.5 py-1 rounded-lg border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 transition-colors leading-none"
            aria-label="Change text size"
          >
            <span className="text-[10px]">A</span>
            <span className="text-base font-semibold">A</span>
          </button>

          <div className="flex items-center gap-2">
            {/* The ping is reserved for actually-live: it should mean
                "captions are flowing", not merely "a socket is open". */}
            <span className="relative flex h-2.5 w-2.5">
              {isLive && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusColor} ${
                  connection === "offline" ? "animate-pulse" : ""
                }`}
              />
            </span>
            <span className="text-xs text-gray-400">{statusLabel}</span>
          </div>
        </div>
      </header>

      <div className="relative flex-1 min-h-0">
        <div
          ref={feedRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-6 py-6 overscroll-contain"
        >
        {captions.length === 0 ? (
          <div className="mx-auto h-full max-w-2xl flex flex-col items-center justify-center text-center gap-4">
            <div className="text-6xl opacity-40" aria-hidden>
              🕊️
            </div>
            <div>
              <p className="text-gray-400 text-lg font-light">
                {live
                  ? "The service has started…"
                  : "Waiting for the service to begin…"}
              </p>
              <p className="text-gray-400 text-sm mt-2">
                {live
                  ? // Explains the blank screen right after a language switch:
                    // captions exist per language, so a newly chosen one starts
                    // from the next sentence spoken.
                    `The next sentence will appear in ${language.native}`
                  : `Captions will appear here in ${language.native}`}
              </p>
            </div>
            {connection === "live" && (
              <div className="flex items-center gap-2 mt-4 text-green-400/70">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs">Connected — ready to receive</span>
              </div>
            )}
          </div>
        ) : (
          // Constrained column: on a projector or laptop, full-width lines are
          // genuinely hard to track back to the start of the next one.
          <div className="mx-auto w-full max-w-2xl space-y-6 pb-4">
            {captions.slice(0, -1).map((c) => (
              <p
                key={c.seq}
                className={`${size.previous} leading-relaxed text-zinc-500 font-light transition-opacity duration-300`}
              >
                {c.text}
              </p>
            ))}

            <div ref={bottomRef} />
          </div>
        )}
        </div>

        {/* Anchored to the bottom of the scrolling history, so it can never
            sit on top of the pinned latest line. */}
        {!autoScroll && captions.length > 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              onClick={() => {
                setAutoScroll(true);
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="pointer-events-auto px-5 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium shadow-xl shadow-black/50 transition-all active:scale-95 animate-in fade-in slide-in-from-bottom-2"
            >
              ↓ Jump to latest
            </button>
          </div>
        )}
      </div>

      {/* The newest line lives OUTSIDE the scrolling area, so it is always on
          screen — scrolling back through earlier lines, or a short viewport,
          can never hide the sentence being spoken right now. */}
      {latest && (
        <div className="shrink-0 border-t border-gray-800/50 bg-gray-950 px-6 py-4">
          <div className="mx-auto w-full max-w-2xl max-h-[42vh] overflow-y-auto">
            <p
              key={latest.seq}
              className={`${size.latest} leading-relaxed text-white font-medium animate-in fade-in duration-300`}
            >
              {latest.text}
            </p>

            {/* Only while the sermon is actually running, so a still circle
                never sits under a finished service. */}
            {live && (
              <div className="flex items-center gap-2 pt-3 text-gray-600">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  className="verba-spin"
                  aria-hidden
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity="0.25"
                    strokeWidth="2.5"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray="30 60"
                  />
                </svg>
                <span className="sr-only">Waiting for the next line</span>
              </div>
            )}
          </div>
        </div>
      )}

      {hasEnded && (
        <div className="shrink-0 mx-auto mb-4 flex items-center gap-2 rounded-full border border-gray-700 bg-gray-900/80 px-4 py-2">
          <span aria-hidden>🕊️</span>
          <span className="text-sm text-gray-300">
            The service has ended — you can still read above
          </span>
        </div>
      )}

      <footer className="shrink-0 px-5 py-3 border-t border-gray-800/50">
        <div className="flex items-center justify-between">
          {/* The running line count read like a dev build. Only the
              instruction the listener actually needs stays. */}
          <p className="text-gray-500 text-xs">
            {hasEnded ? "Thank you for joining us" : "Keep this screen open"}
          </p>
          <p className="text-gray-600 text-xs">Verba</p>
        </div>
      </footer>
    </main>
  );
}
