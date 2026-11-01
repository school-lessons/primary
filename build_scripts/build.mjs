// Builds the whole site into _site/. The GitHub Action runs this same script before publishing to GitHub Pages.
//
//   _site/index.html             — language choice (site/index.html)
//   _site/<lang>/index.html      — the lesson list of a language (site/home.html): ru/, ua/
//   _site/<lang>/<lesson>/       — the lessons of that language
//   _site/<shared folder>/       — materials several lessons use, once for every language (see below)
//   _site/<lesson>/index.html    — a redirect from the address a Russian lesson had before it moved into ru/
//   _site/sw.js, manifest, icons — the app (PWA)
//
// A lesson is a folder lessons/<folder>/ with a lesson.json file:
//   title       — card title
//   description — one or two sentences on what the lesson does
//   subject     — section on the home page: «Чтение», «Математика»…
//   icon        — emoji for the card
//   order       — sort order (lower comes first), optional
//   build       — build command, run inside the lesson folder; optional
//   publish     — which lesson folder to publish (after the build); defaults to the lesson folder itself
//   hidden      — true to keep the lesson off the home page (draft)
//   uses        — shared folders the lesson loads files from, e.g. ["english"]; optional (see below)
//   lang        — "ru" (default) or "ua": the language folder the lesson is published into. A Ukrainian lesson
//                 folder ends with -ua, and the suffix is dropped in its address: read-syllables-ua → ua/read-syllables/
//   ua          — the same lesson in Ukrainian, from the same folder: { title, description, subject, publish }.
//                 Its build command runs once more with LESSON_LANG=ua (see build_scripts/i18n.mjs), and "publish"
//                 (e.g. "build-ua") is published as ua/<folder>/. The rest is taken from the Russian lesson.
//
// A shared folder is lessons/<folder>/ with a shared.json file instead of lesson.json: materials that
// several lessons use (sounds, pictures), published once as _site/<folder>/ and never shown on the home page:
//   title   — what it is (for the build log)
//   publish — subfolders to publish, e.g. ["audio", "images"]; defaults to the whole folder
// The service worker saves a shared folder together with every lesson that lists it in "uses".
//
// The site is also an installable app (PWA): every page gets the manifest, the icons and the
// service worker (site/sw.js) linked in, so a lesson needs nothing of its own for that.
//
// Usage:
//   node build_scripts/build.mjs              # build everything
//   node build_scripts/build.mjs --no-build   # skip lesson builds, use what is already built

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const skipBuild = process.argv.includes("--no-build");

// Languages: the folder on the site, and the text of the lesson list and of the 🏠 button
const LANGUAGES = {
  ru: {
    html: "ru",
    title: "Весёлая школа",
    lead: "Учебные игры и тренажёры для детей",
    description: "Учебные игры и тренажёры для детей: чтение, счёт и не только.",
    language: "Язык",
    home: "Все уроки",
  },
  ua: {
    html: "uk",
    title: "Весела школа",
    lead: "Навчальні ігри та тренажери для дітей",
    description: "Навчальні ігри та тренажери для дітей: читання, лічба й не тільки.",
    language: "Мова",
    home: "Усі уроки",
  },
};
const OLD_ROOT = "ru"; // lessons that used to live at the site root moved into this language

// ---------- App (PWA) ----------

// Links the manifest, icons and service worker into a page; `up` leads from the page to the site root,
// `name` is the app name an iPhone shows when the page is added to the home screen
const appHead = (up, name = LANGUAGES.ru.title) => `
<link rel="manifest" href="${up}manifest.webmanifest">
<meta name="theme-color" content="#d7f0ff">
<link rel="apple-touch-icon" href="${up}apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="${name}">
<script>
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("${up}sw.js").catch(() => {}));
</script>
`;

// Every lesson page gets a way back to the home page (the installed app has no browser back button at all).
// It sits in the bottom-left corner: leave ~70px free at the bottom of a lesson page (read-syllables keeps it for the grass).
// Wide screens show the label next to the house, phones only the house.
const homeButton = (label) => `
<a class="home-button" href="../" title="${label}" aria-label="${label}"><span aria-hidden="true">🏠</span><span class="home-button-text">${label}</span></a>
<style>
  .home-button {
    position: fixed;
    z-index: 5;
    bottom: calc(14px + env(safe-area-inset-bottom));
    left: calc(12px + env(safe-area-inset-left));
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 48px;
    height: 48px;
    padding: 0 16px 0 10px;
    border-radius: 999px;
    background: #fff;
    border: 3px solid #eadfcd;
    box-shadow: 0 3px 0 #eadfcd;
    color: #3d2b2f;
    font: 800 17px "Nunito", system-ui, sans-serif;
    line-height: 1;
    text-decoration: none;
    transition: transform 0.1s;
  }
  .home-button span:first-child { font-size: 22px; }
  .home-button:hover { transform: translateY(-2px); }
  .home-button:active { transform: translateY(2px); box-shadow: 0 1px 0 #eadfcd; }
  @media (max-width: 700px) {
    .home-button { width: 48px; padding: 0; }
    .home-button-text { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .home-button { transition: none; }
  }
</style>
`;

const injectApp = (file, up, extraBody = "", name = undefined) => {
  const html = readFileSync(file, "utf8");
  if (!html.includes("</head>") || !html.includes("</body>")) throw new Error(`В ${file} нет </head> или </body>`);
  writeFileSync(file, html.replace("</head>", `${appHead(up, name)}</head>`).replace("</body>", `${extraBody}</body>`));
};

// Every published file with a hash of its contents, for the service worker's cache
const listFiles = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`],
  );

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Lessons ----------

const lessonsDir = join(root, "lessons");
const lessons = readdirSync(lessonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(lessonsDir, d.name, "lesson.json")))
  .map((d) => ({ folder: d.name, ...JSON.parse(readFileSync(join(lessonsDir, d.name, "lesson.json"), "utf8")) }))
  // A lesson with a "ua" block is two lessons: the Russian one and its Ukrainian build from the same folder
  .flatMap((l) => (l.ua ? [l, { ...l, ...l.ua, lang: "ua", env: { LESSON_LANG: "ua" }, translation: true }] : [l]))
  .map((l) => ({ ...l, lang: l.lang ?? "ru", slug: l.lang === "ua" && !l.translation ? l.folder.replace(/-ua$/, "") : l.folder }))
  .map((l) => ({ ...l, path: `${l.lang}/${l.slug}` })) // site address from the root: ru/read-syllables
  .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.title.localeCompare(b.title, "ru"));

// Shared folders: materials used by several lessons (see the top of the file)
const shared = readdirSync(lessonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(lessonsDir, d.name, "shared.json")))
  .map((d) => ({ slug: d.name, ...JSON.parse(readFileSync(join(lessonsDir, d.name, "shared.json"), "utf8")) }));
for (const lesson of lessons) {
  if (!LANGUAGES[lesson.lang]) throw new Error(`${lesson.folder}: lang должен быть ${Object.keys(LANGUAGES).join(" или ")}`);
  if (lesson.translation && !lesson.ua.publish) throw new Error(`${lesson.folder}/lesson.json: в "ua" нужен publish — папка украинской сборки, например "build-ua"`);
  if (LANGUAGES[lesson.folder]) throw new Error(`Папка урока не может называться ${lesson.folder}: это папка языка на сайте`);
  if (lessons.some((l) => l !== lesson && l.path === lesson.path)) throw new Error(`Два урока с адресом ${lesson.path}: ${lesson.folder}`);
  for (const name of lesson.uses ?? []) {
    if (!shared.some((s) => s.slug === name)) throw new Error(`${lesson.folder}: в "uses" указана папка ${name}, но нет lessons/${name}/shared.json`);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

for (const folder of shared) {
  console.log(`\n== ${folder.slug}: ${folder.title} (общие материалы)`);
  for (const part of folder.publish ?? ["."]) {
    const src = join(lessonsDir, folder.slug, part);
    if (!existsSync(src)) throw new Error(`Нет ${src} — его публикует lessons/${folder.slug}/shared.json`);
    cpSync(src, join(out, folder.slug, part), {
      recursive: true,
      filter: (path) => !/(^|\/)(\.DS_Store|\.env|node_modules)$/.test(path),
    });
  }
}

for (const lesson of lessons) {
  const dir = join(lessonsDir, lesson.folder);
  console.log(`\n== ${lesson.folder}${lesson.translation ? " (ua)" : ""}: ${lesson.title}`);
  if (lesson.build && !skipBuild) {
    execSync(lesson.build, { cwd: dir, stdio: "inherit", shell: "/bin/bash", env: { ...process.env, ...lesson.env } });
  }
  const publish = join(dir, lesson.publish ?? ".");
  if (!existsSync(join(publish, "index.html"))) throw new Error(`Нет ${join(publish, "index.html")} — урок не собрался?`);
  cpSync(publish, join(out, lesson.path), {
    recursive: true,
    filter: (src) => !/(^|\/)(\.DS_Store|\.env|node_modules)$/.test(src),
  });
  injectApp(join(out, lesson.path, "index.html"), "../../", homeButton(LANGUAGES[lesson.lang].home), LANGUAGES[lesson.lang].title);
}

// Russian lessons used to live at the site root (/<lesson>/): old links and bookmarks lead to the new address
for (const lesson of lessons.filter((l) => l.lang === OLD_ROOT)) {
  const to = `../${escape(lesson.path)}/`;
  mkdirSync(join(out, lesson.slug));
  writeFileSync(join(out, lesson.slug, "index.html"), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escape(lesson.title)}</title>
<meta http-equiv="refresh" content="0; url=${to}">
<link rel="canonical" href="${to}">
<script>location.replace("${to}" + location.search + location.hash);</script>
</head>
<body><a href="${to}">${escape(lesson.title)}</a></body>
</html>
`);
}

// ---------- Home pages ----------

const card = (l) => `
      <a class="card" href="${escape(l.slug)}/">
        <span class="card-icon" aria-hidden="true">${escape(l.icon ?? "📘")}</span>
        <span class="card-title">${escape(l.title)}</span>
        <span class="card-text">${escape(l.description ?? "")}</span>
      </a>`;

const template = readFileSync(join(root, "site", "home.html"), "utf8");
if (!template.includes("<!-- LESSONS -->")) throw new Error("В site/home.html нет метки <!-- LESSONS -->");
const shown = lessons.filter((l) => !l.hidden);

// The lesson list of every language (ru/index.html, ua/index.html); sections are ordered by their first lesson
for (const [lang, texts] of Object.entries(LANGUAGES)) {
  const subjects = new Map();
  for (const lesson of shown.filter((l) => l.lang === lang)) {
    if (!subjects.has(lesson.subject)) subjects.set(lesson.subject, []);
    subjects.get(lesson.subject).push(lesson);
  }
  const sections = [...subjects]
    .map(([subject, list]) => `
    <section class="subject">
      <h2>${escape(subject)}</h2>
      <div class="cards">${list.map(card).join("")}
      </div>
    </section>`)
    .join("\n");
  const page = template
    .replace("<!-- LESSONS -->", () => sections)
    .replaceAll("__LANG__", texts.html)
    .replaceAll("__TITLE__", escape(texts.title))
    .replaceAll("__LEAD__", escape(texts.lead))
    .replaceAll("__DESCRIPTION__", escape(texts.description))
    .replaceAll("__LANGUAGE__", escape(texts.language));
  mkdirSync(join(out, lang), { recursive: true });
  writeFileSync(join(out, lang, "index.html"), page);
  injectApp(join(out, lang, "index.html"), "../", "", texts.title);
}

// The site root: language choice
cpSync(join(root, "site", "index.html"), join(out, "index.html"));
injectApp(join(out, "index.html"), "");
for (const file of readdirSync(join(root, "site"))) {
  if (!["index.html", "home.html", "sw.js", ".DS_Store"].includes(file)) cpSync(join(root, "site", file), join(out, file), { recursive: true });
}

// ---------- Service worker ----------

const files = Object.fromEntries(
  listFiles(out).map((path) => [path, createHash("sha256").update(readFileSync(join(out, path))).digest("hex").slice(0, 12)]),
);
const worker = readFileSync(join(root, "site", "sw.js"), "utf8");
if (!worker.includes("/* FILES */ {}")) throw new Error("В site/sw.js нет метки /* FILES */ {}");
if (!worker.includes("/* USES */ {}")) throw new Error("В site/sw.js нет метки /* USES */ {}");
if (!worker.includes("/* LANGS */ []")) throw new Error("В site/sw.js нет метки /* LANGS */ []");
const uses = Object.fromEntries(lessons.filter((l) => l.uses?.length).map((l) => [l.path, l.uses]));
writeFileSync(join(out, "sw.js"), worker
  .replace("/* FILES */ {}", () => JSON.stringify(files))
  .replace("/* USES */ {}", () => JSON.stringify(uses))
  .replace("/* LANGS */ []", () => JSON.stringify(Object.keys(LANGUAGES))));

console.log(`\nГотово: ${out}`);
console.log(`Уроков: ${Object.keys(LANGUAGES).map((lang) => `${lang} ${lessons.filter((l) => l.lang === lang).length}`).join(", ")}, ` +
  `на главных: ${shown.length}, разделов: ${new Set(shown.map((l) => `${l.lang}/${l.subject}`)).size}, ` +
  `общих папок: ${shared.length}, ` +
  `файлов для офлайна: ${Object.keys(files).length}`);
