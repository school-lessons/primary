"""Voices the riddles from data/riddles.json with ElevenLabs (default) or Yandex SpeechKit (API v1).

Reads the "tts" field (riddle text with SpeechKit markup, made by prepare.py). Answers are not voiced:
kids type them in. For ElevenLabs the markup is converted: «<[small]>» becomes a line break, and «+» before
a stressed vowel becomes an acute accent after it («сто+ит» → «стои́т»), unless --plain.
Service: RIDDLES_TTS_PROVIDER (elevenlabs / yandex) or --provider.
ElevenLabs: ELEVENLABS_API_KEY; the Russian voice of the reading lessons (ELEVENLABS_VOICE, Olga Orlova)
with RIDDLES_ELEVENLABS_MODEL.
Yandex: YANDEX_API_KEY (a service account API key); YANDEX_VOICE, YANDEX_EMOTION, YANDEX_SPEED.
Keys and settings come from the environment or the .env file at the repo root (see DEFAULTS).

Output: audio/<id>.mp3 — one file per riddle.

Ukrainian riddles (--lesson riddles-ua, a lesson with "lang": "ua"): ElevenLabs only, language «uk», and every riddle
is voiced by the voice named in its "voice" field — one of UA_ELEVENLABS_VOICES (olga, yaroslava, alex), mixed about
evenly over the list. A riddle without "voice" takes the voices in turn by its place in the list.

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed (needs lame: brew install lame).

Usage:
    python3 voice.py --dry-run                  # show what would be voiced, without requests
    python3 voice.py --limit 1                  # the first riddle — to check the voice
    python3 voice.py                            # everything that's missing
    python3 voice.py --redo molniya,klyuch      # re-voice these riddles (by id)
    python3 voice.py --force                    # re-voice everything
    python3 voice.py --lesson riddles-ua --dry-run   # Ukrainian riddles: what would be voiced and by whom
    python3 voice.py --redo beryoza --compare eleven_flash_v2_5,eleven_multilingual_v2
        # the same riddle with several ElevenLabs models (or Yandex voices with --provider yandex)
        # → compare/<model or voice>/ (git-ignored), audio/ is not touched; --plain — without stress accents
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).parent
LESSONS = HERE.parent.parent
FOLDER = HERE.parent  # lessons/riddles; another riddle lesson with --lesson
sys.path.insert(0, str(LESSONS / "russian" / "tools"))
import speak as russian  # noqa: E402 — shared helpers and the ElevenLabs voice live next to the letter sounds

API_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"
WORKERS = {"yandex": 4, "elevenlabs": 2}
API_KEYS = {"yandex": "YANDEX_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}
VOWELS = "аеёиоуыэюяєіїАЕЁИОУЫЭЮЯЄІЇ"

DEFAULTS = {
    "RIDDLES_TTS_PROVIDER": "elevenlabs",
    "RIDDLES_ELEVENLABS_MODEL": "eleven_multilingual_v2",  # whole poems sound more natural than with flash
    "YANDEX_VOICE": "filipp",   # API v1 voices: filipp, ermil, zahar, alena, jane, marina, omazh
    "YANDEX_EMOTION": "good",   # neutral / good (not every voice has it; see the SpeechKit voice list)
    "YANDEX_SPEED": "0.9",      # 0.1–3.0; a bit slower than normal for kids
}


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def eleven_text(tts: str, plain: bool = False) -> str:
    """SpeechKit markup → ElevenLabs text: pauses become line breaks, «+а» becomes «а́» (or goes with plain)."""
    text = re.sub(r"\s*<\[[^\]]*\]>\s*", "\n", tts)
    return re.sub(f"\\+([{VOWELS}])", lambda m: m.group(1) if plain else m.group(1) + "\u0301", text)


def synthesize(text: str, voice: str, api_key: str) -> bytes:
    data = {"text": text, "lang": "ru-RU", "voice": voice, "emotion": setting("YANDEX_EMOTION"),
            "speed": setting("YANDEX_SPEED"), "format": "mp3"}
    request = urllib.request.Request(API_URL, data=urllib.parse.urlencode(data).encode("utf-8"),
                                     headers={"Authorization": f"Api-Key {api_key}"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            # 429 — rate limit, 5xx — SpeechKit failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"SpeechKit вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e
    raise RuntimeError("SpeechKit не ответил")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="озвучить только первые N загадок")
    parser.add_argument("--force", action="store_true", help="переозвучить всё")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить эти загадки, id через запятую")
    parser.add_argument("--provider", choices=list(API_KEYS), help="сервис озвучки (по умолчанию RIDDLES_TTS_PROVIDER)")
    parser.add_argument("--compare", type=lambda v: v.split(","),
                        help="модели ElevenLabs (или голоса Yandex) через запятую: озвучить каждой в "
                             "compare/<модель>/, audio/ не трогать")
    parser.add_argument("--plain", action="store_true", help="ElevenLabs: без знаков ударения")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет озвучено, без запросов")
    parser.add_argument("--lesson", default=FOLDER.name, help="папка урока с загадками в lessons/ (по умолчанию riddles)")
    args = parser.parse_args()

    folder = LESSONS / args.lesson
    if not (folder / "data" / "riddles.json").exists():
        sys.exit(f"Нет {folder / 'data' / 'riddles.json'}")
    riddles_file, audio, compare = folder / "data" / "riddles.json", folder / "audio", folder / "compare"
    ukrainian = json.loads((folder / "lesson.json").read_text(encoding="utf-8")).get("lang") == "ua"

    russian.load_envs()
    provider = args.provider or setting("RIDDLES_TTS_PROVIDER")
    if provider not in API_KEYS:
        sys.exit(f"Неизвестный RIDDLES_TTS_PROVIDER: {provider}. Можно: {', '.join(API_KEYS)}")
    eleven = provider == "elevenlabs"
    if ukrainian and not eleven:
        sys.exit("Украинские загадки озвучиваются только ElevenLabs")
    riddles = json.loads(riddles_file.read_text(encoding="utf-8"))
    # Ukrainian: each riddle's own voice from its "voice" field, or the voices in turn
    voices = russian.ukrainian_voices() if ukrainian else {}
    names = list(voices)
    for i, r in enumerate(riddles):
        if ukrainian:
            r.setdefault("voice", names[i % len(names)])
            if r["voice"] not in voices:
                sys.exit(f"{r['id']}: нет голоса {r['voice']} — можно {', '.join(names)} (UA_ELEVENLABS_VOICES)")
    unknown = args.redo - {r["id"] for r in riddles}
    if unknown:
        sys.exit(f"Нет таких загадок: {', '.join(sorted(unknown))}")
    if args.redo:
        riddles = [r for r in riddles if r["id"] in args.redo]
    if args.limit:
        riddles = riddles[:args.limit]

    # A job is (text, voice or model, file, ElevenLabs voice or None); comparing writes every voice or model
    # into its own folder
    variants = args.compare or [setting("RIDDLES_ELEVENLABS_MODEL") if eleven else setting("YANDEX_VOICE")]
    jobs = []
    for variant in variants:
        out = compare / (variant + ("-plain" if args.plain else "")) if args.compare else audio
        for r in riddles:
            file = out / f"{r['id']}.mp3"
            if args.compare or args.force or args.redo or not file.exists():
                jobs.append((eleven_text(r["tts"], args.plain) if eleven else r["tts"], variant, file, voices.get(r.get("voice"))))

    if ukrainian:
        counts = {name: sum(1 for r in riddles if r["voice"] == name) for name in names}
        print(f"ElevenLabs, украинский, голоса: {', '.join(f'{n} ({c})' for n, c in counts.items())}, "
              f"модель: {', '.join(variants)}" + (", без ударений" if args.plain else "") + ".", end=" ")
    elif eleven:
        print(f"ElevenLabs, голос: {russian.setting('ELEVENLABS_VOICE')}, модель: {', '.join(variants)}"
              + (", без ударений" if args.plain else "") + ".", end=" ")
    else:
        print(f"Yandex, голос: {', '.join(variants)}, эмоция: {setting('YANDEX_EMOTION')}, "
              f"скорость: {setting('YANDEX_SPEED')}.", end=" ")
    print(f"Загадок: {len(riddles)}, файлов озвучить: {len(jobs)}, символов: {sum(len(job[0]) for job in jobs)}")
    if args.dry_run:
        by_file = {f"{r['id']}.mp3": r.get("voice") for r in riddles}
        for text, _, file, _ in jobs:
            who = f"[{by_file[file.name]}] " if ukrainian else ""
            print(f"  {file.relative_to(folder)}  {who}{text}")
        return

    api_key = os.environ.get(API_KEYS[provider]) or sys.exit(f"Нет ключа: впишите {API_KEYS[provider]} в .env")
    can_normalize = shutil.which("lame") is not None
    if not can_normalize:
        print("  lame не найден — громкость не выравниваем (brew install lame)")

    def work(job):
        text, variant, file, voice = job
        file.parent.mkdir(parents=True, exist_ok=True)
        if eleven:
            # verbatim: a riddle may end with «…» or without a period on purpose
            file.write_bytes(russian.synthesize(text, "", "elevenlabs", api_key, model=variant, verbatim=True,
                                                voice=voice, language="uk" if ukrainian else "ru"))
        else:
            file.write_bytes(synthesize(text, variant, api_key))
        if can_normalize:
            russian.normalize(file)

    failed = []
    with ThreadPoolExecutor(WORKERS[provider]) as pool:
        futures = {pool.submit(work, job): job[2] for job in jobs}
        for n, future in enumerate(as_completed(futures), 1):
            name = futures[future].relative_to(folder)
            try:
                future.result()
                print(f"  [{n}/{len(jobs)}] {name}")
            except Exception as e:
                failed.append(str(name))
                print(f"  [{n}/{len(jobs)}] {name} — ОШИБКА: {e}")
    print(f"Готово: {len(jobs) - len(failed)} файлов, ошибок: {len(failed)} {failed or ''}")


if __name__ == "__main__":
    main()
