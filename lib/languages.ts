// Target languages the preacher can broadcast in.
//
// Kept to languages Claude translates well and that a UK congregation might
// actually need. Adding one is a single entry here — nothing else changes.

/** Non-Latin script ranges we can recognise. */
const SCRIPTS = {
  cyrillic: /[\u0400-\u04FF]/,
  arabic: /[\u0600-\u06FF]/,
  devanagari: /[\u0900-\u097F]/,
  cjk: /[\u4E00-\u9FFF]/,
} as const;

export type ScriptName = keyof typeof SCRIPTS;

export type Language = {
  code: string;
  /** English name, used in the prompt. */
  name: string;
  /** Endonym, shown to listeners reading in that language. */
  native: string;
  flag: string;
  /** Script this language is written in. Absent means Latin. */
  script?: ScriptName;
};

export const LANGUAGES: Language[] = [
  { code: "uk", name: "Ukrainian", native: "Українська", flag: "🇺🇦", script: "cyrillic" },
  { code: "ru", name: "Russian", native: "Русский", flag: "🇷🇺", script: "cyrillic" },
  { code: "pl", name: "Polish", native: "Polski", flag: "🇵🇱" },
  { code: "ro", name: "Romanian", native: "Română", flag: "🇷🇴" },
  { code: "pt-BR", name: "Brazilian Portuguese", native: "Português (Brasil)", flag: "🇧🇷" },
  { code: "pt", name: "European Portuguese", native: "Português (Portugal)", flag: "🇵🇹" },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸" },
  { code: "fr", name: "French", native: "Français", flag: "🇫🇷" },
  { code: "ar", name: "Arabic", native: "العربية", flag: "🇸🇦", script: "arabic" },
  { code: "hi", name: "Hindi", native: "हिन्दी", flag: "🇮🇳", script: "devanagari" },
  { code: "zh", name: "Mandarin Chinese", native: "中文", flag: "🇨🇳", script: "cjk" },
];

export const DEFAULT_LANGUAGE = "uk";

export function getLanguage(code: string | null | undefined): Language {
  return (
    LANGUAGES.find((l) => l.code === code) ??
    LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)!
  );
}

/** Does the text contain the script this language is written in? */
export function hasExpectedScript(text: string, language: Language) {
  if (!language.script) return true; // Latin — nothing distinctive to look for.
  return SCRIPTS[language.script].test(text);
}

/**
 * Does the text contain a script that does not belong to this language?
 *
 * Catches a real and intermittent failure: Haiku occasionally bleeds Cyrillic
 * into Latin-script output — "Niech Pан cię błogosławi" — presumably because
 * Ukrainian dominates this workload. Latin characters are always allowed,
 * since proper nouns and numerals legitimately appear in any language.
 */
export function hasForeignScript(text: string, language: Language) {
  return (Object.keys(SCRIPTS) as ScriptName[]).some(
    (name) => name !== language.script && SCRIPTS[name].test(text),
  );
}
