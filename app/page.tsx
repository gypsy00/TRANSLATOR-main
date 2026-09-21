import Link from "next/link";

/**
 * "Word" in the languages Verba speaks.
 *
 * 道 is how John 1:1 renders "the Word" in Chinese — 太初有道 — which is a
 * closer parallel to the Latin Verbum than a literal translation would be.
 */
const WORD_IN = [
  "Word",
  "Слово",
  "Słowo",
  "Palavra",
  "كلمة",
  "道",
];

function Intro() {
  return (
    <div
      aria-hidden
      className="verba-intro fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950"
    >
      <h1 className="text-7xl sm:text-8xl md:text-9xl font-semibold tracking-tight text-white">
        {"Verba".split("").map((letter, i) => (
          <span
            key={i}
            className="verba-letter"
            style={{ animationDelay: `${i * 0.07}s` }}
          >
            {letter}
          </span>
        ))}
      </h1>

      <div className="verba-rule mt-6 h-px w-40 sm:w-56 bg-gradient-to-r from-transparent via-blue-500 to-transparent" />

      {/* Stacked, so each fades through in the same place. */}
      <div className="relative mt-7 h-10 w-full max-w-md">
        {WORD_IN.map((word, i) => (
          <span
            key={word}
            className="verba-word absolute inset-0 flex items-center justify-center text-2xl sm:text-3xl text-gray-400"
            style={{ animationDelay: `${0.45 + i * 0.28}s` }}
          >
            {word}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <Intro />

      <div className="max-w-sm w-full text-center space-y-10">
        {/* No icon: the intro sequence is the brand moment, and a second
            emblem underneath it only competed with the wordmark. */}
        <div>
          <h1 className="text-6xl font-semibold tracking-tight">Verba</h1>
          <p className="text-gray-400 text-base mt-3">
            Live sermon translation — in your language
          </p>
        </div>

        {/* Role selection — equal visual weight. These are two different
            jobs, not a primary action and a fallback. */}
        <div className="grid gap-3">
          <Link
            href="/broadcast"
            className="group block rounded-2xl border border-blue-500/30 bg-zinc-900/60 hover:border-blue-500 hover:bg-zinc-900 transition-all p-5 text-left backdrop-blur-sm"
          >
            <div className="flex items-start gap-4">
              <div className="text-2xl mt-0.5" aria-hidden>
                🎙️
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-lg">Preacher</span>
                  <span className="rounded-full border border-blue-500/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-blue-300">
                    Speak
                  </span>
                </div>
                <div className="text-gray-400 text-sm mt-1 leading-relaxed">
                  Broadcast your sermon with live translation
                </div>
              </div>
            </div>
          </Link>

          <Link
            href="/listen"
            className="group block rounded-2xl border border-zinc-700/60 bg-zinc-900/60 hover:border-zinc-500 hover:bg-zinc-900 transition-all p-5 text-left backdrop-blur-sm"
          >
            <div className="flex items-start gap-4">
              {/* Not a flag: listeners choose their own language now, so
                  showing one country would misrepresent the app. */}
              <div className="text-2xl mt-0.5" aria-hidden>
                🎧
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-lg">Listener</span>
                  <span className="rounded-full border border-zinc-600 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
                    Read
                  </span>
                </div>
                <div className="text-gray-400 text-sm mt-1 leading-relaxed">
                  Follow the sermon in your own language
                </div>
              </div>
            </div>
          </Link>
        </div>

        <p className="text-gray-500 text-xs">
          The preacher shows a QR code — scan it to start listening
        </p>
      </div>
    </main>
  );
}
