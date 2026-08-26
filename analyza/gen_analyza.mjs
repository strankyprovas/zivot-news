// Generátor investičních analýz pro appku Život — běží v GitHub Actions
// přes Claude Code (headless), takže ho platí Max předplatné, ne API kredity.
//
// Vstup:  tržní data z Yahoo Finance + paměť v analyza/memory.md
// Výstup: analyza/pre.json | post.json (+ archiv) a aktualizovaná paměť.
//
// Spuštění: node analyza/gen_analyza.mjs [pre|post]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Trhy — přeneseno 1:1 z appky (src/markets.js), ať čísla sedí na to,
// co uživatel vidí v záložce Trhy.
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const ASSET_CLASSES = [
  { key: 'indexy', label: 'Akciové indexy' },
  { key: 'dluhopisy', label: 'Dluhopisy a sazby' },
  { key: 'komodity', label: 'Komodity' },
  { key: 'fondy', label: 'Fondy a ETF' },
  { key: 'krypto', label: 'Krypto' },
  { key: 'meny', label: 'Měny' },
];

const ASSETS = [
  ['^GSPC', 'S&P 500', 'indexy', 'b'],
  ['^IXIC', 'Nasdaq Composite', 'indexy', 'b'],
  ['^DJI', 'Dow Jones', 'indexy', 'b'],
  ['^GDAXI', 'DAX (Německo)', 'indexy', 'b'],
  ['^STOXX50E', 'Euro Stoxx 50', 'indexy', 'b'],
  ['^VIX', 'VIX – index strachu', 'indexy', 'b'],
  ['^TNX', 'US dluhopis 10 let (výnos)', 'dluhopisy', '%'],
  ['^IRX', 'US pokladniční poukázka 3M (výnos)', 'dluhopisy', '%'],
  ['TLT', 'TLT – dlouhé US dluhopisy', 'dluhopisy', '$'],
  ['GC=F', 'Zlato', 'komodity', '$'],
  ['SI=F', 'Stříbro', 'komodity', '$'],
  ['CL=F', 'Ropa WTI', 'komodity', '$'],
  ['NG=F', 'Zemní plyn', 'komodity', '$'],
  ['HG=F', 'Měď', 'komodity', '$'],
  ['VWCE.DE', 'Vanguard FTSE All-World', 'fondy', '€'],
  ['EUNL.DE', 'iShares Core MSCI World', 'fondy', '€'],
  ['QQQ', 'Invesco QQQ (Nasdaq 100)', 'fondy', '$'],
  ['BTC-USD', 'Bitcoin', 'krypto', '$'],
  ['ETH-USD', 'Ethereum', 'krypto', '$'],
  ['CZK=X', 'USD / CZK', 'meny', 'b'],
  ['EURCZK=X', 'EUR / CZK', 'meny', 'b'],
  ['EURUSD=X', 'EUR / USD', 'meny', 'b'],
];

const pct = (now, then) => (then == null || now == null || then === 0 ? null : (now / then - 1) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 400;

function computeChanges(closes, stamps, highs, lows) {
  const last = closes.length - 1;
  const price = closes[last];
  const at = (back) => closes[Math.max(0, last - back)];
  const year = new Date(stamps[last] * 1000).getFullYear();
  let ytdIdx = 0;
  for (let i = 0; i <= last; i++) {
    if (new Date(stamps[i] * 1000).getFullYear() === year) { ytdIdx = i; break; }
  }
  return {
    price,
    d1: pct(price, at(1)),
    w1: pct(price, at(5)),
    m1: pct(price, at(21)),
    m3: pct(price, at(63)),
    ytd: pct(price, closes[Math.max(0, ytdIdx - 1)]),
    y1: pct(price, closes[0]),
    high: highs.length ? Math.max(...highs) : Math.max(...closes),
    low: lows.length ? Math.min(...lows) : Math.min(...closes),
    ageDays: Math.floor((Date.now() / 1000 - stamps[last]) / 86400),
  };
}

async function fetchOne(symbol) {
  const url = `${CHART}${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('prázdná odpověď');
  const q = result.indicators?.quote?.[0] || {};
  const stampsRaw = result.timestamp || [];
  const closesRaw = q.close || [];
  const highsRaw = q.high || [];
  const lowsRaw = q.low || [];
  const stamps = [], closes = [], highs = [], lows = [];
  for (let i = 0; i < closesRaw.length; i++) {
    if (closesRaw[i] == null) continue;
    closes.push(closesRaw[i]);
    stamps.push(stampsRaw[i]);
    if (highsRaw[i] != null) highs.push(highsRaw[i]);
    if (lowsRaw[i] != null) lows.push(lowsRaw[i]);
  }
  if (closes.length < 2) throw new Error('málo dat');
  return { ...computeChanges(closes, stamps, highs, lows), currency: result.meta?.currency || '' };
}

async function fetchWithRetry(symbol, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchOne(symbol); }
    catch (e) { lastErr = e; if (i < tries - 1) await sleep(800 * (i + 1)); }
  }
  throw lastErr;
}

async function fetchMarkets() {
  const out = [];
  for (let i = 0; i < ASSETS.length; i++) {
    const [symbol, name, cls, unit] = ASSETS[i];
    try {
      out.push({ symbol, name, cls, unit, ...(await fetchWithRetry(symbol)) });
    } catch (e) {
      out.push({ symbol, name, cls, unit, error: e.message });
    }
    if (i < ASSETS.length - 1) await sleep(GAP_MS);
  }
  const ok = out.filter((a) => !a.error);
  if (ok.length < ASSETS.length / 2) throw new Error('Yahoo vrátil málo dat, radši nic negeneruji.');
  return { assets: out, fetchedAt: new Date().toISOString() };
}

function fmtPrice(a) {
  if (a.price == null) return '—';
  const d = a.price >= 1000 ? 0 : a.price >= 10 ? 2 : 4;
  const n = a.price.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (a.unit === '%') return `${n} %`;
  if (a.unit === '$') return `$${n}`;
  if (a.unit === '€') return `€${n}`;
  return n;
}
const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} %`);

function marketsAsText(snapshot) {
  const lines = [];
  for (const c of ASSET_CLASSES) {
    const group = snapshot.assets.filter((a) => a.cls === c.key && !a.error);
    if (!group.length) continue;
    lines.push(`${c.label.toUpperCase()} (cena | 1D | 1T | 1M | 3M | YTD | 1R | 52t min–max):`);
    for (const a of group) {
      lines.push(
        `- ${a.name}: ${fmtPrice(a)} | ${fmtPct(a.d1)} | ${fmtPct(a.w1)} | ${fmtPct(a.m1)}` +
          ` | ${fmtPct(a.m3)} | ${fmtPct(a.ytd)} | ${fmtPct(a.y1)}` +
          ` | ${a.low?.toFixed(2)}–${a.high?.toFixed(2)}`
      );
    }
    lines.push('');
  }
  const failed = snapshot.assets.filter((a) => a.error);
  if (failed.length) lines.push(`Nepodařilo se načíst: ${failed.map((a) => a.name).join(', ')}.`);
  const stale = snapshot.assets.filter((a) => !a.error && a.ageDays > 5);
  if (stale.length) {
    lines.push(
      'POZOR – u těchto aktiv je poslední kurz starší než 5 dní, neber je jako dnešní stav: ' +
        stale.map((a) => `${a.name} (${a.ageDays} dní)`).join(', ') + '.'
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt — stejná struktura jako v appce, jen bez osobních pozic
// (ty si appka dopočítá lokálně) a s pamětí drženou tady v repu.
// ---------------------------------------------------------------------------

const PICKS_SECTION = [
  '**Co bych zvážil koupit** – dva až čtyři konkrétní tipy. U KAŽDÉHO napiš:',
  'co (název aktiva nebo třídy), na jak dlouho (krátkodobě / dlouhodobě),',
  'proč – a to opři o konkrétní číslo z tabulky – a čím to může nevyjít.',
  'Když teď nic nákupu hodného nevidíš, napiš to rovnou. „Počkat" je platná odpověď',
  'a je lepší než vymyšlený tip.',
  '',
  '**Co bych teď nekupoval** – taky dva až čtyři konkrétní věci. U každého napiš,',
  'jestli je to proto, že je to přehřáté, že to padá a ještě nedopadlo, nebo že se tomu',
  'dlouhodobě nedaří bez vyhlídky na obrat. A co by tě přesvědčilo změnit názor.',
].join('\n');

const SHARED_RULES = [
  'PRAVIDLA:',
  '- Čísla ber VÝHRADNĚ z tabulky výše. Nikdy si nevymýšlej kurzy, ceny ani procenta.',
  '- Vyhledávání na webu používej na kontext a důvody (proč se něco hnulo, co se čeká),',
  '  ne na ceny – ty už máš přesné. Když si nejsi jistý, řekni to.',
  '- Piš česky, věcně, bez omáčky. Čte se to na mobilu.',
  '- Používej krátké nadpisy a odrážky, ať se to dá přelétnout očima.',
  '- Rozlišuj krátkodobý výhled (dny až týdny) a dlouhodobý (měsíce až roky).',
  '',
  'JAK PSÁT DOPORUČENÍ:',
  '- Buď konkrétní. „Diverzifikovat portfolio" není tip.',
  '- Nikdy nepiš, kolik má investovat. Velikost pozice je jeho věc.',
  '- Piš v pravděpodobnostech, ne v jistotách.',
  '- U každého tipu musí být riziko.',
  '- Nejsi licencovaný poradce a Matyáš to ví, dlouhé disclaimery nepiš.',
].join('\n');

const MEM_MARK = '===PAMET===';

function formatDateCz(d = new Date()) {
  return d.toLocaleDateString('cs-CZ', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Prague',
  });
}

function buildPrompt(session, snapshot, memory, lastTexts) {
  const ukol = session === 'post'
    ? [
        'ÚKOL – večerní uzávěrka po zavření trhů. Napiš tyto sekce:',
        '',
        '**Jak dopadl den** – kdo rostl, kdo padal a hlavně PROČ. Důvody si dohledej na webu.',
        '',
        '**Co to znamená** – jednodenní výkyv, nebo změna trendu? Porovnej s týdenními,',
        'měsíčními a ročními čísly z tabulky.',
        '',
        '**Komu se dlouhodobě nedaří** – co je pod vodou za 3 měsíce, rok, nebo u ročního minima.',
        'U každého: příležitost, nebo padající nůž?',
        '',
        '**Co se změnilo od minule** – projdi otevřené položky ze své paměti; co vychází, co ne.',
        'Když ti něco nevyšlo, přiznej to a napiš proč.',
        '',
        PICKS_SECTION,
        '',
        '**Na zítřek** – co bude hýbat trhy další den.',
      ]
    : [
        'ÚKOL – ranní přehled před otevřením trhů. Napiš tyto sekce:',
        '',
        '**Kde trhy stojí** – dvě tři věty, jak se to má po včerejšku.',
        '',
        '**Co dnes sledovat** – konkrétní události dneška: makrodata, centrální banky,',
        'výsledky velkých firem. Dohledej na webu, ať to sedí na dnešní datum.',
        '',
        '**Krátkodobě (dny až týdny)** – co je nakoupené/přeprodané, kde je riziko.',
        'Vždy uveď, z jakého čísla to vyvozuješ.',
        '',
        '**Dlouhodobě (měsíce až roky)** – co dává smysl držet nebo přikupovat a proč.',
        'Akcie, dluhopisy, komodity i fondy.',
        '',
        '**Co se změnilo od minule** – projdi otevřené položky ze své paměti; co vychází, co ne.',
        '',
        PICKS_SECTION,
        '',
        '**Na co si dát pozor** – jedna dvě věci, které by dnešek mohly obrátit.',
      ];

  return [
    'Jsi investiční analytik, který pro Matyáše dělá dvakrát denně přehled trhů.',
    'Matyáš je česky mluvící podnikatel (dělá weby), investuje vlastní peníze,',
    'orientuje se v základech, ale není profesionál. Měnu má v korunách.',
    '',
    'Vedeš si dlouhodobou paměť (níže) a tvoje analýzy na sebe navazují.',
    'Jeho konkrétní pozice řeší appka zvlášť – nezmiňuj, že je nevidíš.',
    '',
    `Dnes je ${formatDateCz()}. Relace: ${session === 'post' ? 'Po zavírce' : 'Před otevřením'}.`,
    '',
    'AKTUÁLNÍ TRŽNÍ DATA (stažená právě teď z Yahoo Finance):',
    marketsAsText(snapshot),
    '',
    'TVOJE DLOUHODOBÁ PAMĚŤ (teze, příležitosti, rizika z minulých analýz):',
    memory || '(zatím prázdná – dnes ji založíš)',
    lastTexts,
    '',
    ...ukol,
    '',
    SHARED_RULES,
    '',
    `ÚPLNĚ NAKONEC napiš na samostatný řádek značku ${MEM_MARK} a pod ni novou verzi`,
    'své paměti: max 30 odrážek markdown, každá = jedna teze/příležitost/riziko',
    's datem vzniku a stavem (běží / vyšlo / nevyšlo). Starým splněným položkám',
    'nech jeden řádek v sekci „Uzavřeno", ať se z chyb dá učit. Nic jiného za značku nepiš.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hlavní běh
// ---------------------------------------------------------------------------

function pragueHour() {
  return Number(new Intl.DateTimeFormat('cs-CZ', { hour: 'numeric', hour12: false, timeZone: 'Europe/Prague' }).format(new Date()));
}
function pragueDateStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date());
}

const session = process.argv[2] || (pragueHour() >= 18 ? 'post' : 'pre');
if (!['pre', 'post'].includes(session)) throw new Error(`Neznámá relace: ${session}`);

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log('CLAUDE_CODE_OAUTH_TOKEN není nastavený — přeskočeno (nastav secret v repu).');
  process.exit(0);
}

console.log(`Relace: ${session}, stahuji trhy…`);
const snapshot = await fetchMarkets();
console.log(`Trhy OK (${snapshot.assets.filter((a) => !a.error).length}/${ASSETS.length}).`);

const memPath = join(DIR, 'memory.md');
const memory = existsSync(memPath) ? readFileSync(memPath, 'utf8') : '';

// Poslední dvě analýzy z archivu, ať model navazuje a neopakuje se
const archDir = join(DIR, 'archive');
mkdirSync(archDir, { recursive: true });
let lastTexts = '';
try {
  const { readdirSync } = await import('node:fs');
  const posledni = readdirSync(archDir).filter((f) => f.endsWith('.json')).sort().slice(-2);
  if (posledni.length) {
    lastTexts = '\n\nCO JSI PSAL NAPOSLEDY (nezopakuj to slovo od slova, navaž):\n' +
      posledni.map((f) => {
        const j = JSON.parse(readFileSync(join(archDir, f), 'utf8'));
        return `--- ${j.date} ${j.session} ---\n` + j.text.replace(/[*#]/g, '').slice(0, 900);
      }).join('\n');
  }
} catch {}

const prompt = buildPrompt(session, snapshot, memory, lastTexts);
console.log(`Prompt: ${prompt.length} znaků. Volám Claude…`);

const raw = execFileSync(
  'claude',
  ['-p', '--model', 'opus', '--allowedTools', 'WebSearch'],
  { input: prompt, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15 * 60 * 1000 }
);

const idx = raw.lastIndexOf(MEM_MARK);
const text = (idx > 0 ? raw.slice(0, idx) : raw).trim();
const newMemory = idx > 0 ? raw.slice(idx + MEM_MARK.length).trim() : null;

if (text.length < 400) throw new Error(`Analýza podezřele krátká (${text.length} znaků), neukládám.`);

const out = {
  date: pragueDateStr(),
  session,
  text,
  generatedAt: new Date().toISOString(),
  source: 'cloud-max',
};

writeFileSync(join(DIR, `${session}.json`), JSON.stringify(out, null, 1));
writeFileSync(join(archDir, `${out.date}-${session}.json`), JSON.stringify(out, null, 1));
if (newMemory && newMemory.length > 50) writeFileSync(memPath, newMemory + '\n');

console.log(`Hotovo: ${text.length} znaků analýzy, paměť ${newMemory ? 'aktualizována' : 'beze změny'}.`);
