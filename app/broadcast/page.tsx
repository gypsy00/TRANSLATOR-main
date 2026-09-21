"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import { QRCodeCanvas } from "qrcode.react";
import Link from "next/link";
import { LANGUAGES, DEFAULT_LANGUAGE, getLanguage } from "@/lib/languages";

type Status = "idle" | "live" | "error";

/** Mic errors that end the broadcast. Everything else is worth retrying. */
const FATAL_MIC_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
]);

const FATAL_MESSAGES: Record<string, string> = {
  "not-allowed":
    "Microphone access was blocked. Allow the microphone in your browser settings, then try again.",
  "service-not-allowed":
    "Speech recognition was blocked by the browser or the operating system.",
  "audio-capture":
    "No microphone was found. Check that one is connected and not in use by another app.",
};

/**
 * Whether this device can broadcast at all — checked on first render so the
 * preacher finds out now, not while standing in front of the congregation.
 *
 * Read through useSyncExternalStore rather than an effect: these are
 * browser-only facts that never change, and the server snapshot is simply
 * "unknown yet".
 */
function detectSupportIssue(): string {
  if (!window.isSecureContext) {
    return "This page is not on a secure connection, so the browser will not allow microphone access. Open it over HTTPS, or run it on this device at localhost.";
  }

  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    return "This browser has no speech recognition. Use Chrome or Edge (on iPhone, speech recognition is not available).";
  }

  return "";
}

const subscribeNever = () => () => {};

export default function BroadcastPage() {
  const supportIssue = useSyncExternalStore(
    subscribeNever,
    detectSupportIssue,
    () => "",
  );

  const [status, setStatus] = useState<Status>("idle");
  const [langCode, setLangCode] = useState(DEFAULT_LANGUAGE);
  const [interimText, setInterimText] = useState("");
  const [lastEnglish, setLastEnglish] = useState("");
  const [lastTranslation, setLastTranslation] = useState("");
  const [listenUrl, setListenUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [warning, setWarning] = useState("");
  const [sentenceCount, setSentenceCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [listeners, setListeners] = useState(0);
  const [activeLanguages, setActiveLanguages] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [sermonAlreadyLive, setSermonAlreadyLive] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const isActiveRef = useRef(false);
  const restartAttemptsRef = useRef(0);

  // Sentences are translated strictly in order. Without this queue, two
  // sentences spoken in quick succession race, and the congregation reads
  // them in whichever order the model happened to finish.
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);

  // A refreshed preacher page has no idea a sermon is in progress, and
  // pressing Start would mint a new session and wipe every listener's screen.
  // Ask the server instead of assuming.
  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setSermonAlreadyLive(Boolean(data.live)))
      .catch(() => {
        // If we cannot tell, say nothing rather than warn wrongly.
      });
  }, []);

  // ── QR target ───────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/network-info")
      .then((res) => res.json())
      .then((data) => setListenUrl(data.listenUrl))
      .catch(() => setListenUrl(`${window.location.origin}/listen`));
  }, []);

  // ── Wake lock, re-acquired when the tab comes back ──────────────────────────
  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // Not critical.
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && isActiveRef.current) {
        requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [requestWakeLock]);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // ── Is anyone actually receiving this? ──────────────────────────────────────
  useEffect(() => {
    if (status !== "live") return;

    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/session", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;

        setListeners(Number(data.listeners) || 0);
        setActiveLanguages(
          Array.isArray(data.languages) ? data.languages : [],
        );

        // An in-memory store behind a real domain means the preacher's POST and
        // a listener's poll can land on different instances — the exact failure
        // that used to show green lights and deliver nothing.
        if (
          data.backend === "memory" &&
          !["localhost", "127.0.0.1"].includes(window.location.hostname)
        ) {
          setWarning(
            "No shared store is configured. Captions may not reach listeners on a hosted deployment.",
          );
        }
      } catch {
        if (!cancelled) setListeners(0);
      }
    };

    check();
    const timer = setInterval(check, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  // ── Translation queue ───────────────────────────────────────────────────────
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;

    while (queueRef.current.length) {
      const text = queueRef.current.shift()!;
      setPending(queueRef.current.length);

      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });

        const data = await res.json();

        if (!res.ok) {
          setWarning(
            res.status === 503
              ? "Translated, but could not reach listeners. Check the connection."
              : "A sentence could not be translated. Still listening.",
          );
          continue;
        }

        setLastEnglish(text);
        setLastTranslation(data.translated);
        setSentenceCount((c) => c + 1);
        setWarning(
          data.suspect
            ? "That line may not have translated cleanly — worth repeating it."
            : "",
        );
      } catch {
        setWarning("Network problem sending a sentence. Still listening.");
      }
    }

    drainingRef.current = false;
    setPending(0);
  }, []);

  const enqueue = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      queueRef.current.push(text.trim());
      setPending(queueRef.current.length);
      drain();
    },
    [drain],
  );

  // ── Speech recognition ──────────────────────────────────────────────────────
  const buildRecognition = useCallback(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      restartAttemptsRef.current = 0;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) {
          setInterimText("");
          enqueue(transcript);
        } else {
          setInterimText(transcript);
        }
      }
    };

    recognition.onerror = (event) => {
      // Silence between sentences is normal, not a failure.
      if (event.error === "no-speech" || event.error === "aborted") return;

      if (FATAL_MIC_ERRORS.has(event.error)) {
        isActiveRef.current = false;
        setErrorMsg(
          FATAL_MESSAGES[event.error] ?? `Microphone error: ${event.error}`,
        );
        setStatus("error");
        releaseWakeLock();
        return;
      }

      // Transient (usually "network"): surface it, keep preaching. The old
      // version tore the whole broadcast down here.
      setWarning("Microphone hiccup — reconnecting automatically.");
    };

    // Chrome stops recognition on its own every so often. Restarting on `onend`
    // is the standard workaround; the backoff stops it becoming a hot loop if
    // the mic is genuinely gone.
    recognition.onend = () => {
      if (!isActiveRef.current) return;

      const attempt = restartAttemptsRef.current++;

      if (attempt > 12) {
        isActiveRef.current = false;
        setErrorMsg(
          "Speech recognition kept dropping out. Check the microphone and network, then try again.",
        );
        setStatus("error");
        releaseWakeLock();
        return;
      }

      setTimeout(
        () => {
          if (!isActiveRef.current) return;
          try {
            recognition.start();
          } catch {
            // Already starting — the next onend will retry.
          }
        },
        Math.min(200 * 2 ** attempt, 3000),
      );
    };

    return recognition;
  }, [enqueue, releaseWakeLock]);

  const startBroadcast = useCallback(async () => {
    if (supportIssue) {
      setErrorMsg(supportIssue);
      setStatus("error");
      return;
    }

    setErrorMsg("");
    setWarning("");
    setSentenceCount(0);
    // The server clears the caption log for listeners on a new session; these
    // clear the preacher's own screen, which otherwise still shows the last
    // line of the previous sermon.
    setLastEnglish("");
    setLastTranslation("");
    setInterimText("");
    setSermonAlreadyLive(false);
    setConfirmRestart(false);
    queueRef.current = [];
    restartAttemptsRef.current = 0;

    try {
      await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: true, language: langCode }),
      });
    } catch {
      setWarning("Could not reach the server. Listeners may not be connected.");
    }

    try {
      const recognition = buildRecognition();
      recognitionRef.current = recognition;
      isActiveRef.current = true;
      recognition.start();
    } catch {
      setErrorMsg("Could not start the microphone. Try again.");
      setStatus("error");
      return;
    }

    requestWakeLock();
    setStatus("live");
  }, [buildRecognition, requestWakeLock, supportIssue, langCode]);

  const stopBroadcast = useCallback(async () => {
    isActiveRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    releaseWakeLock();
    setStatus("idle");
    setInterimText("");

    try {
      await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: false }),
      });
    } catch {
      // The sermon is over either way.
    }
  }, [releaseWakeLock]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(listenUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the URL is on screen to type.
    }
  };

  // ── ERROR ───────────────────────────────────────────────────────────────────
  if (status === "error") {
    return (
      <main className="min-h-dvh bg-gray-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full space-y-6 text-center">
          <div className="w-20 h-20 rounded-full bg-red-900/30 flex items-center justify-center text-4xl mx-auto">
            ⚠️
          </div>
          <p className="text-red-400 text-sm leading-relaxed">{errorMsg}</p>
          <button
            onClick={() => {
              setStatus("idle");
              setErrorMsg("");
            }}
            className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 font-semibold text-lg transition-colors"
          >
            Back
          </button>
        </div>
      </main>
    );
  }

  // ── IDLE ────────────────────────────────────────────────────────────────────
  if (status === "idle") {
    return (
      <main className="min-h-dvh bg-gray-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full space-y-7 text-center">
          <Link
            href="/"
            className="inline-block text-gray-500 hover:text-white text-sm transition-colors"
          >
            ← Back
          </Link>

          <div className="space-y-3">
            <h1 className="text-3xl font-bold tracking-tight">🎙️ Preach</h1>
            <p className="text-gray-400 text-sm leading-relaxed">
              Show the QR code to the congregation,
              <br />
              then tap start and preach normally.
            </p>
          </div>

          {supportIssue && (
            <p className="text-amber-300 text-xs bg-amber-950/40 border border-amber-900/50 rounded-xl p-3 leading-relaxed">
              {supportIssue}
            </p>
          )}

          <div className="text-left">
            <label
              htmlFor="target-language"
              className="block text-xs text-gray-500 mb-2"
            >
              Default language
              <span className="text-gray-600">
                {" "}
                — listeners can pick their own
              </span>
            </label>
            <div className="relative">
              <select
                id="target-language"
                value={langCode}
                onChange={(e) => setLangCode(e.target.value)}
                className="w-full appearance-none bg-gray-900 border border-gray-800 rounded-xl px-4 py-3.5 pr-10 text-base text-white focus:outline-none focus:border-blue-500 transition-colors"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag}  {l.name} — {l.native}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
                ▼
              </span>
            </div>
          </div>

          {listenUrl && (
            <div className="bg-white rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl shadow-blue-500/10">
              <QRCodeCanvas value={listenUrl} size={200} level="M" />
              <div className="text-center">
                {/* Deliberately language-neutral: listeners choose their own,
                    so naming one here turns visitors away. */}
                <p className="text-gray-800 text-sm font-semibold">
                  Scan to read along
                </p>
                <p className="text-gray-500 text-xs mt-0.5">
                  Pick your language on your phone
                </p>
                <button
                  onClick={copyLink}
                  className="text-gray-600 text-xs font-mono mt-2 hover:text-gray-900 transition-colors break-all"
                >
                  {copied ? "Copied ✓" : listenUrl}
                </button>
              </div>
            </div>
          )}

          {sermonAlreadyLive && (
            <p className="text-amber-300 text-xs bg-amber-950/40 border border-amber-900/50 rounded-xl p-3 leading-relaxed text-left">
              A sermon is already running — this page was probably reloaded.
              Starting a new one clears every listener&apos;s screen.
            </p>
          )}

          <button
            onClick={() => {
              // Two taps when a sermon is live: the destructive part is
              // invisible from here — it happens on other people's phones.
              if (sermonAlreadyLive && !confirmRestart) {
                setConfirmRestart(true);
                return;
              }
              startBroadcast();
            }}
            className={`w-full py-5 rounded-2xl font-semibold text-xl transition-all shadow-lg ${
              confirmRestart
                ? "bg-amber-600 hover:bg-amber-500 active:bg-amber-700 shadow-amber-600/20"
                : "bg-blue-600 hover:bg-blue-500 active:bg-blue-700 shadow-blue-600/20"
            }`}
          >
            {confirmRestart
              ? "Tap again to clear all screens"
              : sermonAlreadyLive
                ? "Start New Sermon"
                : "Start Sermon"}
          </button>

          {confirmRestart && (
            <button
              onClick={() => setConfirmRestart(false)}
              className="w-full -mt-4 py-2 text-sm text-gray-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
          )}

          {sentenceCount > 0 && (
            // The only acknowledgement that ending the sermon did anything.
            // Phrased as a confirmation rather than a statistic, and it is
            // deliberately page-local: it describes the sermon just finished,
            // not stored history.
            <p className="text-gray-400 text-sm">
              ✓ Sermon ended — {sentenceCount} sentence
              {sentenceCount !== 1 ? "s" : ""} translated
            </p>
          )}
        </div>
      </main>
    );
  }

  // ── LIVE ────────────────────────────────────────────────────────────────────
  const translating = pending > 0;

  return (
    <main className="min-h-dvh bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full space-y-7 text-center">
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <div
              className={`w-28 h-28 rounded-full flex items-center justify-center text-5xl transition-colors duration-500 ${
                translating ? "bg-yellow-900/40" : "bg-green-900/40"
              }`}
            >
              {translating ? "🔄" : "🎙️"}
            </div>
            {!translating && (
              <div className="absolute inset-0 w-28 h-28 rounded-full bg-green-500/20 animate-ping" />
            )}
          </div>

          <div>
            <p className="text-xl font-semibold tracking-tight">
              {translating ? "Translating…" : "Listening…"}
            </p>
            <p className="text-gray-500 text-sm mt-1 tabular-nums">
              {sentenceCount} sentence{sentenceCount !== 1 ? "s" : ""} sent
              {pending > 1 ? ` · ${pending} queued` : ""}
            </p>
            <p className="text-gray-600 text-xs mt-1">
              into {getLanguage(langCode).flag} {getLanguage(langCode).name}
            </p>
          </div>
        </div>

        {/* The one number that says whether this is reaching the room. */}
        <div
          className={`rounded-xl px-4 py-3 border flex items-center justify-center gap-2 ${
            listeners > 0
              ? "bg-green-950/30 border-green-900/50 text-green-300"
              : "bg-gray-900/40 border-gray-800/60 text-gray-400"
          }`}
        >
          <span className="text-lg" aria-hidden>
            {listeners > 0 ? "👥" : "🔍"}
          </span>
          <span className="text-sm tabular-nums">
            {listeners > 0
              ? `${listeners} listening`
              : "No one connected yet"}
          </span>
        </div>

        {/* Which languages the room is actually reading in, right now. */}
        {activeLanguages.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {activeLanguages.map((code) => {
              const l = getLanguage(code);
              return (
                <span
                  key={code}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-800 bg-gray-900/50 px-3 py-1 text-xs text-gray-300"
                >
                  <span aria-hidden>{l.flag}</span>
                  {l.native}
                </span>
              );
            })}
          </div>
        )}

        {interimText && (
          <div className="bg-gray-900/30 rounded-xl px-4 py-3 border border-gray-800/50 text-left">
            <p className="text-xs text-gray-500 mb-1">Hearing…</p>
            <p className="text-sm text-gray-300 italic">{interimText}</p>
          </div>
        )}

        {lastTranslation && !interimText && (
          <div className="bg-gray-900/30 rounded-xl px-4 py-3 border border-gray-800/50 text-left">
            <p className="text-xs text-gray-500 mb-1">Last sent</p>
            <p className="text-xs text-gray-400 mb-2">{lastEnglish}</p>
            <p className="text-sm text-blue-300">{lastTranslation}</p>
          </div>
        )}

        {warning && (
          <p className="text-amber-300 text-xs bg-amber-950/40 border border-amber-900/50 rounded-xl p-3 leading-relaxed">
            {warning}
          </p>
        )}

        <button
          onClick={stopBroadcast}
          className="w-full py-4 rounded-2xl bg-gray-800/50 hover:bg-red-600 font-semibold transition-all text-gray-500 hover:text-white border border-gray-800/50 hover:border-red-600"
        >
          End Sermon
        </button>
      </div>
    </main>
  );
}
