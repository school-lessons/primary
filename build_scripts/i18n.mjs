// Languages of the engine builds (math-drill, physics…): one lesson folder, built once per language.
//
// A lesson whose lesson.json has a "ua" block is built twice by the root build: as usual, and once more with the
// environment variable LESSON_LANG=ua. An engine build then
//   - writes into build-ua/ instead of build/ (buildDir), which the "ua" block publishes;
//   - takes its page text from its strings.json: { "ru": {…}, "ua": {…} } with the same keys (readStrings);
//     a string may hold «{name}» parts that the code fills in;
//   - takes the lesson's own texts (level names, captions) from a "ua" block next to the Russian ones in the lesson's
//     data file (translated): drill.json { "levels": [{ "name": "до 5" }], "ua": { "levels": [{ "name": "до 5" }] } }.
// Local build of the Ukrainian version: LESSON_LANG=ua node ../math-drill/game/build_scripts/build.mjs .

import { readFileSync } from "node:fs";

export const LANGS = ["ru", "ua"];

/** The language this build is for: LESSON_LANG, Russian by default. */
export function buildLang() {
  const lang = process.env.LESSON_LANG || "ru";
  if (!LANGS.includes(lang)) throw new Error(`LESSON_LANG должен быть ${LANGS.join(" или ")}, а не ${lang}`);
  return lang;
}

/** Output folder of a lesson build in this language: build/, build-ua/. */
export const buildDir = (lang) => (lang === "ru" ? "build" : `build-${lang}`);

/** The page text of one language from an engine's strings.json; every language must have the same keys. */
export function readStrings(file, lang) {
  const strings = JSON.parse(readFileSync(file, "utf8"));
  for (const other of LANGS) {
    const missing = Object.keys(strings.ru).filter((key) => !(key in (strings[other] ?? {})));
    if (missing.length) throw new Error(`${file}: в "${other}" нет ${missing.join(", ")}`);
  }
  return strings[lang];
}

/** Fills double-brace keys in a page with the texts (escaped); an unknown key fails the build. */
export function fillTexts(html, text, escape, where) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (typeof text[key] !== "string") throw new Error(`${where}: {{${key}}} нет в strings.json`);
    return escape(text[key]);
  });
}

/**
 * Lesson data in a language: the Russian data with its "ua" block laid over it. Objects are merged key by key,
 * lists item by item (the block may give only the texts: "levels": [{ "name": … }]), anything else is replaced.
 * The language blocks themselves are dropped.
 */
export function translated(data, lang) {
  const base = Object.fromEntries(Object.entries(data).filter(([key]) => !LANGS.includes(key)));
  return lang === "ru" || data[lang] === undefined ? base : merge(base, data[lang]);
}

function merge(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) {
    return base.map((item, i) => (i < over.length ? merge(item, over[i]) : item));
  }
  if (isObject(base) && isObject(over)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
    return out;
  }
  return over;
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
