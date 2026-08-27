"""Večerní souhrn zpráv pro appku Život.

Vyhledá aktuální zprávy přes web search a uloží český souhrn do news.json
(+ archiv podle data). Spouští GitHub Action každý večer.

Od 27. 8. 2026 jede přes headless Claude Code (CLAUDE_CODE_OAUTH_TOKEN),
takže ho platí Max předplatné, ne API kredity.
"""

import subprocess

import json
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

PRAGUE = ZoneInfo("Europe/Prague")


def main() -> None:
    now = datetime.now(PRAGUE)
    date_cz = now.strftime("%d.%m.%Y")
    date_iso = now.strftime("%Y-%m-%d")

    prompt = f"""Dnes je {date_cz}. Vyhledej na webu nejdůležitější zprávy za dnešek
(posledních 24 hodin) a sestav večerní souhrn v ČEŠTINĚ pro osobní aplikaci.

Pokryj tři oblasti (v každé 4–6 nejdůležitějších zpráv):
1. "cr" – Česká republika (politika, společnost, důležité domácí události)
2. "svet" – Svět (geopolitika, konflikty, důležité světové události)
3. "ekonomika" – Ekonomika, trhy a investice (akciové trhy – jak dnes zavřely hlavní
   indexy, krypto, komodity, sazby, důležité firemní zprávy, cokoli podstatného pro investora)

Pravidla:
- Piš věcně a stručně: každá zpráva = krátký titulek + 1–3 věty shrnutí.
- Uváděj jen ověřené informace z výsledků vyhledávání, nic si nedomýšlej.
- U trhů uveď konkrétní čísla (% pohyby indexů apod.), pokud jsou k dispozici.

Výstup vrať POUZE jako validní JSON v tomto tvaru (žádný jiný text okolo):
{{"sections": [
  {{"key": "cr", "title": "🇨🇿 Česká republika", "items": [{{"title": "...", "text": "..."}}]}},
  {{"key": "svet", "title": "🌍 Svět", "items": [{{"title": "...", "text": "..."}}]}},
  {{"key": "ekonomika", "title": "📈 Ekonomika a trhy", "items": [{{"title": "...", "text": "..."}}]}}
]}}"""

    run = subprocess.run(
        ["claude", "-p", "--model", "opus", "--allowedTools", "WebSearch"],
        input=prompt, capture_output=True, text=True, timeout=15 * 60,
    )
    if run.returncode != 0:
        print(f"claude selhal ({run.returncode}): {run.stderr[:500]}", file=sys.stderr)
        sys.exit(1)

    text = run.stdout
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        print(f"V odpovědi není JSON:\n{text[:500]}", file=sys.stderr)
        sys.exit(1)
    data = json.loads(match.group(0))

    if not data.get("sections"):
        print("Prázdné sekce, končím bez změny.", file=sys.stderr)
        sys.exit(1)

    out = {
        "date": date_iso,
        "date_cz": date_cz,
        "updated_at": now.isoformat(timespec="minutes"),
        "sections": data["sections"],
    }
    for path in ("news.json", f"archive/{date_iso}.json"):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)

    total = sum(len(s.get("items", [])) for s in out["sections"])
    print(f"OK – {total} zpráv, {out['updated_at']}")


if __name__ == "__main__":
    main()
