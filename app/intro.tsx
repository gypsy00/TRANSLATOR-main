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

export function Intro() {
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
