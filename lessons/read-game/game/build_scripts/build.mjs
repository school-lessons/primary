// Builds one «Собери слово» reading lesson into <lesson>/build/: page, styles, code, words and pictures.
// This engine is shared by read-syllables, read-potter, read-potter-aloud, riddles, read-roblox…;
// each of them calls it from its lesson.json:
//   (cd ../read-game/game && npm ci) && node ../read-game/game/build_scripts/build.mjs .
//
// The lesson folder holds:
//   lesson.json     — title and icon are reused for the page; it lists "uses": ["russian"];
//                     "lang": "ua" makes a Ukrainian lesson (default "ru"), see «Ukrainian lessons» below
//   game.json       — the lesson's story: levels, dialogs, confetti (see below)
//   data/words.txt  — words: "count<TAB>word" (tools/words.py) or one word per line.
//                     Without it the words are the ones in data/pictures.tsv. Same rule as read_words()
//                     in russian/tools/syllables.py. Names keep their capital letter: «Гарри».
//   data/pictures.tsv, images/, images.json — word pictures made by tools/draw.py; optional
//   data/riddles.json, audio/ — riddle lessons only (mode "riddle", see below)
//   data/pairs.json, audio/ — sentence lessons only (mode "sentence", see below)
//   theme.css       — optional: colours and decorations on top of the engine's style.css
// Words and pictures used by several lessons live in a shared folder instead (lessons/potter): the same data/,
// images/ and images.json, plus shared.json. The lesson then names it in game.json "words" and in lesson.json
// "uses"; its pictures are not copied, the game loads them from that folder like the sounds.
//
// game.json:
//   mode         — "assemble" (default): build the word from tiles; "aloud": read the shown word aloud,
//                  browser speech recognition checks it. "aloud" shows no picture and plays no sound — the child
//                  must read, not guess or repeat — so it loads nothing from shared folders and needs no "uses".
//                  "riddle": the big speaker plays a riddle, the child assembles its answer from tiles (the
//                  "assemble" code). Riddles come from the lesson's data/riddles.json ({ id, answer } each, made by
//                  the lesson's tools), their sounds from its audio/<id>.mp3; a riddle without a sound is left out.
//                  Every answer is played once, a level is complete when all its riddles are solved.
//                  "sentence": read a short sentence aloud, speech recognition checks it word by word; the prize
//                  is a longer text — its sound plays and its text is shown. Pairs come from the lesson's
//                  data/pairs.json ({ id, read, reward } each), the prize sounds from its audio/<id>.mp3 (made by
//                  the lesson's tools); a pair without a sound is left out. Like "aloud", it loads nothing from
//                  shared folders. Every sentence is read once, a level is complete when all its sentences are read.
//   words        — optional: shared folder with the words and pictures, e.g. "potter"
//   levels       — exactly three, by tile count: 2–3, 4, 5 and more (sentences: 5–7, 8–9, 10 and more words).
//                  Each is { name, icon, done }:
//     name, icon — label and emoji of the level button
//     done       — dialog when the level is complete: { icon?, title, text, button } («{n}» in text is the
//                  number of words collected or sentences read); the last level's dialog ends the game, its button
//                  starts over
//   doneIcon     — emoji on the button of a complete level
//   confetti     — emoji that rain down on a right answer
//   pictureStyle — shared style prompt for tools/draw.py, so all the pictures look like one book
//                  (a shared word folder keeps it in its shared.json)
//   pictures     — Ukrainian lessons only: a Russian lesson folder whose pictures this lesson shows, e.g.
//                  "read-syllables"; they are copied into build/images/
//
// Ukrainian lessons ("lang": "ua" in lesson.json): the page text comes from game/strings.json "ua", speech
// recognition listens for uk-UA, and the words are Ukrainian (apostrophe «’»; «'» and «ʼ» are turned into it).
// Pictures are not drawn again: a folder that has them (a shared word folder named in "words", or the lesson named
// in "pictures") keeps data/ua.tsv — «Russian word<TAB>Ukrainian word» after a header line — and the picture of the
// Russian word goes with its Ukrainian translation. With "words" the lesson's words are the translations from that
// file; with "pictures" they are the lesson's own (data/words.txt). Syllables play the Russian sounds that sound the
// same (common.ts soundOf). In the "sentence" mode the check reads Latin letters and number words the Ukrainian way.
//
// Sounds of letters and syllables are not copied: they live in the shared folder lessons/russian, which the
// root build publishes once as _site/russian/. data.js lists them, and the game loads them from ../../russian/
// both on the site (_site/ru/<lesson>/) and from a local <lesson>/build/.
//
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "russian"; // shared folder with the sounds, under lessons/ and on the site
const sounds = join(game, "..", "..", SOURCE, "audio");
if (!process.argv[2]) throw new Error("Укажите папку урока: node build_scripts/build.mjs ../../read-syllables");
const lesson = resolve(process.argv[2]);
const out = join(lesson, "build");
const where = basename(lesson);

const readJson = (file, fallback) => {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Нет ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
};
const fail = (text) => {
  throw new Error(`${where}/game.json: ${text}`);
};
// «Russian word<TAB>Ukrainian word» after a header line: data/ua.tsv of a folder with pictures
const readTranslations = (folder) => {
  const file = join(folder, "data", "ua.tsv");
  if (!existsSync(file)) throw new Error(`Нет ${file} — переводов слов с картинками на украинский`);
  return readFileSync(file, "utf8").split("\n").slice(1).map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter(([ru, ua]) => ru && ua).map(([ru, ua]) => [ru, apostrophe(ua)]);
};
const apostrophe = (word) => word.replace(/['ʼ`]/g, "’");

// ---------- Lesson settings ----------

const meta = readJson(join(lesson, "lesson.json"));
const story = readJson(join(lesson, "game.json"));
const LANGS = ["ru", "ua"];
const lang = meta.lang ?? "ru";
if (!LANGS.includes(lang)) throw new Error(`${where}/lesson.json: lang должен быть ${LANGS.join(" или ")}, а не ${lang}`);
const ukrainian = lang === "ua";

// UI text: game/strings.json has the same keys for every language
const strings = readJson(join(game, "strings.json"));
for (const other of LANGS) {
  const missing = Object.keys(strings.ru).filter((key) => !(key in (strings[other] ?? {})));
  if (missing.length) throw new Error(`game/strings.json: в "${other}" нет ${missing.join(", ")}`);
}
const text = strings[lang];
const MODES = ["assemble", "aloud", "riddle", "sentence"];
const mode = story.mode ?? "assemble";
if (!MODES.includes(mode)) fail(`mode должен быть ${MODES.join(", ")}, а не ${mode}`);
const riddle = mode === "riddle";
const sentence = mode === "sentence";
// The page's code: a riddle lesson is "assemble" with the riddle's sound instead of the word's
const code = riddle ? "assemble" : mode;
const CODES = ["assemble", "aloud", "sentence"];
// Pictures and syllable sounds are only for "assemble" and "riddle"; "aloud" and "sentence" take just their texts
const media = mode === "assemble" || riddle;
if (riddle && story.words !== undefined) fail("у загадок слова свои — data/riddles.json, words не нужен");
if (sentence && story.words !== undefined) fail("у фраз тексты свои — data/pairs.json, words не нужен");
if (story.pictures !== undefined) {
  if (!ukrainian) fail("pictures — только для украинского урока (lang: ua), русский берёт свои картинки или words");
  if (story.words !== undefined || riddle) fail("pictures не сочетается с words и загадками");
  if (!existsSync(join(lesson, "..", story.pictures, "images.json"))) fail(`pictures: нет lessons/${story.pictures}/images.json`);
}
const needUses = (folder, what) => {
  if (!(meta.uses ?? []).includes(folder)) throw new Error(`${where}/lesson.json: добавьте "${folder}" в "uses" — оттуда ${what}`);
};
if (story.words !== undefined) {
  if (!existsSync(join(lesson, "..", story.words, "shared.json"))) fail(`words: нет общей папки lessons/${story.words} с shared.json`);
  if (media) needUses(story.words, "картинки");
}
if (media) needUses(SOURCE, "звуки");
if (!Array.isArray(story.levels) || story.levels.length !== 3) {
  fail(sentence ? "нужно ровно три уровня levels: фразы из 5–7, 8–9 и 10+ слов" : "нужно ровно три уровня levels: 2–3, 4 и 5+ карточек");
}
for (const level of story.levels) {
  const done = level.done ?? {};
  if (!level.name || !level.icon || !done.title || !done.text || !done.button) {
    fail(`у уровня ${JSON.stringify(level)} должны быть name, icon и done: { title, text, button }`);
  }
}
if (!story.doneIcon) fail("нужен doneIcon — значок пройденного уровня");
if (!Array.isArray(story.confetti) || !story.confetti.length) fail("нужен список значков confetti");

// ---------- Words and pictures ----------

const wordsDir = story.words ? join(lesson, "..", story.words) : lesson;
const wordsFile = join(wordsDir, "data", "words.txt");
const picturesFile = join(wordsDir, "data", "pictures.tsv");
const riddlesFile = join(wordsDir, "data", "riddles.json");
const pairsFile = join(wordsDir, "data", "pairs.json");
let words;
let riddles; // answer -> audio/<id>.mp3
let rewards; // sentence -> { text, audio: audio/<id>.mp3 }
if (sentence) {
  const list = readJson(pairsFile);
  for (const p of list) if (!p.id || !p.read || !p.reward) throw new Error(`${where}/data/pairs.json: у пары нужны id, read и reward: ${JSON.stringify(p)}`);
  const reads = list.map((p) => p.read);
  const twice = reads.filter((r, i) => reads.indexOf(r) !== i);
  if (twice.length) throw new Error(`${where}/data/pairs.json: фраза встречается дважды: ${twice.join(" | ")}`);
  const voiced = list.filter((p) => existsSync(join(lesson, "audio", `${p.id}.mp3`)));
  if (!voiced.length) throw new Error(`${where}: нет звуков наград в audio/ — сначала озвучьте их`);
  if (voiced.length < list.length) {
    console.warn(`Без звука, пропущены: ${list.filter((p) => !voiced.includes(p)).map((p) => p.id).join(", ")}`);
  }
  rewards = Object.fromEntries(voiced.map((p) => [p.read, { text: p.reward, audio: `audio/${p.id}.mp3` }]));
  words = Object.keys(rewards);
} else if (riddle) {
  const list = readJson(riddlesFile);
  const voiced = list.filter((r) => existsSync(join(lesson, "audio", `${r.id}.mp3`)));
  if (!voiced.length) throw new Error(`${where}: нет звуков загадок в audio/ — сначала озвучьте их`);
  if (voiced.length < list.length) {
    console.warn(`Без звука, пропущены: ${list.filter((r) => !voiced.includes(r)).map((r) => r.id).join(", ")}`);
  }
  riddles = Object.fromEntries(voiced.map((r) => [r.answer, `audio/${r.id}.mp3`]));
  words = Object.keys(riddles);
} else if (existsSync(wordsFile)) {
  words = readFileSync(wordsFile, "utf8").split("\n").map((line) => (line.split("\t").pop() ?? "").trim());
} else if (existsSync(picturesFile)) {
  words = readFileSync(picturesFile, "utf8").split("\n").slice(1).map((line) => (line.split("\t")[1] ?? "").trim());
} else {
  throw new Error(`Нет ни ${wordsFile}, ни ${picturesFile} — откуда брать слова?`);
}
let images = media ? readJson(join(wordsDir, "images.json"), {}) : {};
// A Ukrainian lesson with Russian pictures: they go with the translations of their words
const picturesDir = story.pictures ? join(lesson, "..", story.pictures) : story.words ? wordsDir : null;
if (ukrainian && picturesDir) {
  const translations = readTranslations(picturesDir);
  const russian = readJson(join(picturesDir, "images.json"), {});
  if (story.words) words = translations.map(([, ua]) => ua);
  images = media ? Object.fromEntries(translations.filter(([ru]) => russian[ru]).map(([ru, ua]) => [ua, russian[ru]])) : {};
}
if (ukrainian) words = words.map(apostrophe);
words = [...new Set(words.filter(Boolean))];

// ---------- Sounds (lessons/russian) ----------

for (const name of media ? ["syllables.json", "letters.json"] : []) {
  if (!existsSync(join(sounds, name))) throw new Error(`Нет lessons/${SOURCE}/audio/${name} — сначала озвучьте: python3 lessons/${SOURCE}/tools/speak.py`);
}
const soundList = (name) => (media ? readJson(join(sounds, name), {}) : {});

// ---------- Output ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/common.js and one file per mode; the page needs only its own mode
execSync(`npx tsc --outDir "${out}"`, { cwd: game, stdio: "inherit" });
for (const other of CODES.filter((m) => m !== code)) rmSync(join(out, `${other}.js`));

// The page takes its title and favicon from lesson.json
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("__TITLE__", escape(meta.title))
  .replaceAll("__ICON__", escape(meta.icon ?? "📖"))
  .replaceAll("__MODE__", code)
  .replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (typeof text[key] !== "string") throw new Error(`game/index.html: {{${key}}} нет в strings.json`);
    return escape(text[key]);
  });
writeFileSync(join(out, "index.html"), html);
cpSync(join(game, "style.css"), join(out, "style.css"));
const theme = join(lesson, "theme.css");
writeFileSync(join(out, "theme.css"), existsSync(theme) ? readFileSync(theme, "utf8") : "/* no theme.css in the lesson */\n");
// The lesson's own pictures are copied; those of a shared word folder are loaded from it
if (media && !story.words && existsSync(join(lesson, "images"))) cpSync(join(lesson, "images"), join(out, "images"), { recursive: true });
// Pictures of another lesson ("pictures"): only the ones in the game
if (media && story.pictures) {
  for (const file of new Set(Object.values(images))) cpSync(join(lesson, "..", story.pictures, file), join(out, file));
}
// Riddle and prize sounds belong to the lesson: only the ones in the game are copied
const ownSounds = [...Object.values(riddles ?? {}), ...Object.values(rewards ?? {}).map((r) => r.audio)];
for (const file of ownSounds) cpSync(join(lesson, file), join(out, file));

// Words and sound lists go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = {
  lesson: where,
  lang,
  text,
  source: SOURCE,
  imageSource: media ? story.words ?? "" : "",
  words,
  ...(riddles && { riddles }),
  ...(rewards && { rewards }),
  syllables: soundList("syllables.json"),
  letters: soundList("letters.json"),
  soft: soundList("soft.json"), // soft consonants «ть», «ль»…, if already voiced
  images,
  story: { levels: story.levels, doneIcon: story.doneIcon, confetti: story.confetti },
};
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Режим: ${mode}${ukrainian ? ", украинский" : ""}${story.words ? `, слова${media ? " и картинки" : ""} из lessons/${story.words}` : ""}` +
  (media ? "" : sentence ? " (без картинок и звуков слогов, звуки наград — из audio/)" : " (без картинок и звуков)"));
console.log(`${riddle ? "Загадок" : sentence ? "Фраз" : "Слов"}: ${words.length}` + (media ? `, картинок: ${Object.keys(images).length}, ` +
  `звуков из lessons/${SOURCE}: слогов ${Object.keys(data.syllables).length}, букв ${Object.keys(data.letters).length}, ` +
  `мягких ${Object.keys(data.soft).length}` : ""));
