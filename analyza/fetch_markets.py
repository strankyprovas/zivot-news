# Stažení tržních dat z Yahoo pro gen_analyza.mjs.
#
# Proč python a ne node: Yahoo blokuje požadavky z datacenter podle TLS
# otisku. curl_cffi se umí vydávat za Chrome, takže projde i z GitHub
# Actions. Výpočty jsou 1:1 s appkou (src/markets.js) i s gen_analyza.mjs.
#
# Výstup: analyza/_snapshot.json — gen_analyza.mjs ho použije, když je čerstvý.

import json
import time
import sys
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests

DIR = Path(__file__).parent
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"

# Musí odpovídat ASSETS v gen_analyza.mjs
ASSETS = [
    ("^GSPC", "S&P 500", "indexy", "b"),
    ("^IXIC", "Nasdaq Composite", "indexy", "b"),
    ("^DJI", "Dow Jones", "indexy", "b"),
    ("^GDAXI", "DAX (Německo)", "indexy", "b"),
    ("^STOXX50E", "Euro Stoxx 50", "indexy", "b"),
    ("^VIX", "VIX – index strachu", "indexy", "b"),
    ("^TNX", "US dluhopis 10 let (výnos)", "dluhopisy", "%"),
    ("^IRX", "US pokladniční poukázka 3M (výnos)", "dluhopisy", "%"),
    ("TLT", "TLT – dlouhé US dluhopisy", "dluhopisy", "$"),
    ("GC=F", "Zlato", "komodity", "$"),
    ("SI=F", "Stříbro", "komodity", "$"),
    ("CL=F", "Ropa WTI", "komodity", "$"),
    ("NG=F", "Zemní plyn", "komodity", "$"),
    ("HG=F", "Měď", "komodity", "$"),
    ("VWCE.DE", "Vanguard FTSE All-World", "fondy", "€"),
    ("EUNL.DE", "iShares Core MSCI World", "fondy", "€"),
    ("QQQ", "Invesco QQQ (Nasdaq 100)", "fondy", "$"),
    ("BTC-USD", "Bitcoin", "krypto", "$"),
    ("ETH-USD", "Ethereum", "krypto", "$"),
    ("CZK=X", "USD / CZK", "meny", "b"),
    ("EURCZK=X", "EUR / CZK", "meny", "b"),
    ("EURUSD=X", "EUR / USD", "meny", "b"),
]

GAP_S = 0.4


def pct(now, then):
    if then is None or now is None or then == 0:
        return None
    return (now / then - 1) * 100


def compute(closes, stamps, highs, lows):
    last = len(closes) - 1
    price = closes[last]

    def at(back):
        return closes[max(0, last - back)]

    year = datetime.fromtimestamp(stamps[last], tz=timezone.utc).year
    ytd_idx = 0
    for i in range(last + 1):
        if datetime.fromtimestamp(stamps[i], tz=timezone.utc).year == year:
            ytd_idx = i
            break

    return {
        "price": price,
        "d1": pct(price, at(1)),
        "w1": pct(price, at(5)),
        "m1": pct(price, at(21)),
        "m3": pct(price, at(63)),
        "ytd": pct(price, closes[max(0, ytd_idx - 1)]),
        "y1": pct(price, closes[0]),
        "high": max(highs) if highs else max(closes),
        "low": min(lows) if lows else min(closes),
        "ageDays": int((time.time() - stamps[last]) // 86400),
    }


def fetch_one(session, symbol):
    r = session.get(
        CHART + symbol,
        params={"interval": "1d", "range": "1y"},
        impersonate="chrome",
        timeout=30,
    )
    r.raise_for_status()
    result = r.json()["chart"]["result"][0]
    q = (result.get("indicators", {}).get("quote") or [{}])[0]
    stamps_raw = result.get("timestamp") or []
    closes_raw = q.get("close") or []
    highs_raw = q.get("high") or []
    lows_raw = q.get("low") or []

    stamps, closes, highs, lows = [], [], [], []
    for i, c in enumerate(closes_raw):
        if c is None:
            continue
        closes.append(c)
        stamps.append(stamps_raw[i])
        if i < len(highs_raw) and highs_raw[i] is not None:
            highs.append(highs_raw[i])
        if i < len(lows_raw) and lows_raw[i] is not None:
            lows.append(lows_raw[i])

    if len(closes) < 2:
        raise RuntimeError("málo dat")

    out = compute(closes, stamps, highs, lows)
    out["currency"] = (result.get("meta") or {}).get("currency") or ""
    return out


def main():
    session = requests.Session()
    assets = []
    for i, (symbol, name, cls, unit) in enumerate(ASSETS):
        entry = {"symbol": symbol, "name": name, "cls": cls, "unit": unit}
        last_err = None
        for attempt in range(3):
            try:
                entry.update(fetch_one(session, symbol))
                last_err = None
                break
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
                time.sleep(0.8 * (attempt + 1))
        if last_err:
            entry["error"] = last_err
            print(f"  ✗ {symbol}: {last_err}", flush=True)
        if i < len(ASSETS) - 1:
            time.sleep(GAP_S)
        assets.append(entry)

    ok = [a for a in assets if "error" not in a]
    print(f"Staženo {len(ok)}/{len(ASSETS)}", flush=True)
    if len(ok) < len(ASSETS) / 2:
        sys.exit("Yahoo vrátil málo dat i přes curl_cffi.")

    snapshot = {"assets": assets, "fetchedAt": datetime.now(timezone.utc).isoformat()}
    (DIR / "_snapshot.json").write_text(json.dumps(snapshot), encoding="utf-8")
    print("Zapsáno analyza/_snapshot.json")


if __name__ == "__main__":
    main()
