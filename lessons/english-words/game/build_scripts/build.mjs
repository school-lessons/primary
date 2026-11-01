// Builds the game into build/ (build-ua/ for Ukrainian): page, styles, code and data.js.
// The words, sounds and pictures live in the shared folder lessons/english (see english/words.mjs):
// data.js lists the words, and the game loads the files from that folder — nothing is copied.
//
// Languages (build_scripts/i18n.mjs at the repo root): with LESSON_LANG=ua the game is built into build-ua/ in
// Ukrainian — page text from game/strings.json, title from the "ua" block of lesson.json, word translations and
// topic names from the «українською» columns of english/data/words.tsv and topics.tsv. The English stays the same.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDir, buildLang, fillTexts, readStrings, translated } from "../../../../build_scripts/i18n.mjs";
import { FOLDER, readEnglish } from "../../../english/words.mjs";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const lang = buildLang();
const dir = buildDir(lang);
const out = join(game, dir);
const text = readStrings(join(game, "strings.json"), lang);
const meta = translated(JSON.parse(readFileSync(join(game, "..", "lesson.json"), "utf8")), lang);

// Topic names and word translations in the build's language; a Ukrainian build needs every one of them
const { topics } = readEnglish();
const topicName = (t) => (lang === "ua" ? t.nameUa : t.name);
const translation = (w) => (lang === "ua" ? w.ua : w.ru);
const untranslated = lang === "ru" ? [] : [
  ...topics.filter((t) => !topicName(t)).map((t) => `тема ${t.key} (topics.tsv)`),
  ...topics.flatMap((t) => t.words).filter((w) => !translation(w)).map((w) => w.word),
];
if (untranslated.length) {
  throw new Error(`Нет перевода в колонке «українською» lessons/${FOLDER}/data/words.tsv, topics.tsv: ` +
    `${untranslated.slice(0, 20).join(", ")}${untranslated.length > 20 ? ` и ещё ${untranslated.length - 20}` : ""}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/main.js (build-ua/main.js)
execSync(`npx tsc --outDir ${dir}`, { cwd: game, stdio: "inherit" });

// The page takes its title and favicon from lesson.json, the rest of its text from strings.json
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("__TITLE__", escape(meta.title))
  .replaceAll("__ICON__", escape(meta.icon));
writeFileSync(join(out, "index.html"), fillTexts(html, text, escape, "game/index.html"));
cpSync(join(game, "style.css"), join(out, "style.css"));

// Only words with a sound make it into the game; a missing picture is replaced by the topic icon
const total = topics.reduce((sum, t) => sum + t.words.length, 0);
const data = {
  lang,
  text, // page text in the build's language (strings.json)
  source: FOLDER,
  topics: topics.map((t) => ({
    key: t.key,
    icon: t.icon,
    name: topicName(t),
    words: t.words.filter((w) => w.audio).map((w) => ({
      word: w.word,
      translation: translation(w),
      accept: w.accept,
      slug: w.slug,
      image: w.image,
    })),
  })),
};

// Words go into data.js so no fetch is needed (fetch fails when the file is opened directly)
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

const voiced = data.topics.reduce((sum, t) => sum + t.words.length, 0);
const pictured = data.topics.reduce((sum, t) => sum + t.words.filter((w) => w.image).length, 0);
console.log(`Готово: ${out}`);
console.log(`Тем: ${topics.length}, слов: ${total}, со звуком: ${voiced}, с картинкой: ${pictured}`);
if (voiced < total) console.log(`Не все слова озвучены — python3 lessons/${FOLDER}/tools/speak.py (без звука слово в игре не появится)`);
