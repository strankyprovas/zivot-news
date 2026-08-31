// Ranní brífink pro appku Život — běží ve VEŘEJNÉM repu (Actions zdarma),
// ale data čte a zapisuje do PRIVÁTNÍHO repa zivot-brain přes BRAIN_PAT.
// Do tohoto repa ani do logů se žádný osobní obsah nedostane (logy
// veřejného repa jsou vidět — proto se loguje jen délka textů).

import { execFileSync } from 'node:child_process';

const PAT = process.env.BRAIN_PAT;
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!PAT || !OAUTH) {
  console.log('Chybí BRAIN_PAT nebo CLAUDE_CODE_OAUTH_TOKEN — přeskočeno.');
  process.exit(0);
}

const API = 'https://api.github.com/repos/strankyprovas/zivot-brain/contents';
const HDRS = {
  Authorization: `Bearer ${PAT}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

async function readFileFromBrain(path) {
  const r = await fetch(`${API}/${path}?t=${Date.now()}`, { headers: HDRS });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub čtení ${path}: ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, text: Buffer.from(j.content, 'base64').toString('utf8') };
}

async function writeFileToBrain(path, text, message) {
  const existing = await readFileFromBrain(path).catch(() => null);
  const body = { message, content: Buffer.from(text, 'utf8').toString('base64') };
  if (existing?.sha) body.sha = existing.sha;
  const r = await fetch(`${API}/${path}`, { method: 'PUT', headers: HDRS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub zápis ${path}: ${r.status}`);
}

function pragueDateStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date());
}
function formatDateCz() {
  return new Date().toLocaleDateString('cs-CZ', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Prague',
  });
}

// Záložní crony: když už dnešní brífink v zivot-brain je, nic negenerovat.
try {
  const done = await readFileFromBrain('brief/latest.json');
  if (done && JSON.parse(done.text)?.date === pragueDateStr()) {
    console.log('Dnešní brífink už existuje — přeskočeno.');
    process.exit(0);
  }
} catch {}

const ctxFile = await readFileFromBrain('context/context.json');
if (!ctxFile) {
  console.log('context.json v zivot-brain neexistuje — přeskočeno.');
  process.exit(0);
}
const ctx = JSON.parse(ctxFile.text);
const today = pragueDateStr();
const ageH = Math.round((Date.now() - new Date(ctx.uploadedAt).getTime()) / 3600000);
if (ageH > 72) {
  console.log(`Kontext je ${ageH} h starý — appka se dlouho neotevřela, negeneruji.`);
  process.exit(0);
}

const SYSTEM = [
  'Jsi Matyášův ranní parťák. Každé ráno mu sestavíš brífink, podle kterého si zorganizuje den.',
  '',
  'Matyáš je česky mluvící podnikatel z Brna – dělá weby pro malé podniky (firma StránkyProVás),',
  'stará se o zhruba dvacet klientských webů, shání nové zakázky a zároveň na sobě chce pracovat:',
  'cvičit, číst, meditovat, rehabilitovat záda. Pracuje sám na sebe, takže den si musí naplnit sám –',
  'a přesně s tím mu pomáháš.',
  '',
  `⚠️ DŮLEŽITÉ K DATŮM: níže uvedená data appka nahrála ${ctx.uploadedAt} (před ${ageH} h,`,
  'typicky včera večer). Stavy „hotovo ✓ / nehotovo" u návyků a úkolů se vztahují k OKAMŽIKU',
  'NAHRÁNÍ, ne k dnešnímu ránu — dnešek začíná čistý. „Hotovo" ze včerejška je splněný včerejšek.',
  'Sekce KALENDÁŘ NA DNEŠEK (pokud je v datech) už platí pro dnešní den.',
  '',
  'Napiš tyhle sekce, v tomhle pořadí:',
  '',
  '**Kde jsi** – dvě tři věty. Co se povedlo (série, splněné dny), co visí, jak vypadá dnešek.',
  'Buď konkrétní, opři to o čísla z dat. Když je něco po termínu, začni tím.',
  '',
  '**Dnešní plán** – rozvrhni den do bloků od rána do večera. Když jsou v datech',
  'události z kalendáře na dnešek, postav plán KOLEM NICH – ty časy jsou zabrané.',
  'U každého bloku napiš čas, co dělat a proč zrovna to. Vycházej z jeho skutečných úkolů,',
  'zakázek a rutin z dat níže, nevymýšlej si aktivity, které nikde nejsou. Ať to dohromady dá',
  'plný, ale zvládnutelný den – zhruba šest až osm hodin práce plus osobní věci. Pauzy a jídlo.',
  '',
  '**Na čem dnes vydělat** – jedna až tři konkrétní věci, které dnes posunou peníze:',
  'komu napsat, co doprodat, který lead dotáhnout, který nápad ze seznamu rozjet.',
  'U každé napiš první krok, který zabere do dvaceti minut.',
  '',
  '**Pro sebe** – tři až pět seberozvojových věcí na dnešek. Vybírej z jeho volných aktivit',
  'v datech a zohledni, co tenhle měsíc zanedbává. Rehabilitace zad není volitelná.',
  'U každé napiš, kdy ji vecpat do dne.',
  '',
  '**Jedna věta na dnešek** – co je ta jedna věc, která když se povede, bude den dobrý.',
  '',
  'PRAVIDLA:',
  '- ⚠️ NEJDŮLEŽITĚJŠÍ: nedoporučuj nic, co už je v datech označené jako hotové.',
  '  Data obsahují seznam dřívějších doporučení i hotových nápadů – projdi je dřív,',
  '  než něco navrhneš. Opakovat práci, kterou má za sebou, je ta nejhorší chyba.',
  '- Každý den nabídni něco jiného. Radši míň položek než recyklovat včerejšek.',
  '- Piš česky, přímo, jako kamarád. Bez omáčky a bez motivačních frází.',
  '- Vycházej z dat níže. Nevymýšlej si úkoly, klienty ani schůzky, které tam nejsou.',
  '- Čte se to na mobilu ráno – krátké odrážky, žádné dlouhé odstavce.',
  '- Nekaž ho a nemoralizuj. Celé to má jít přečíst za dvě minuty.',
  '',
  `Dnes je ${formatDateCz()}.`,
  '',
  'ÚPLNĚ NAKONEC napiš na samostatný řádek značku ===AKCE=== a pod ni JSON pole',
  '3–6 konkrétních odškrtnutelných úkolů na dnešek ve tvaru:',
  '[{"text":"Napsat Grasel ohledně feedu","area":"prace"}] — area je "prace", "penize"',
  'nebo "sebe". Text do dvanácti slov, v infinitivu. Nic jiného za značkou.',
].join('\n');

const prompt = SYSTEM + '\n\nDATA:\n' + ctx.input;
console.log(`Kontext ${ageH} h starý, prompt ${prompt.length} znaků. Volám Claude…`);

const raw = execFileSync('claude', ['-p', '--model', 'opus'], {
  input: prompt, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60 * 1000,
});

const MARK = '===AKCE===';
const idx = raw.lastIndexOf(MARK);
const text = (idx > 0 ? raw.slice(0, idx) : raw).trim();
let actions = [];
if (idx > 0) {
  try {
    const m = raw.slice(idx + MARK.length).match(/\[[\s\S]*\]/);
    if (m) {
      actions = JSON.parse(m[0])
        .filter((a) => a && typeof a.text === 'string' && a.text.trim())
        .slice(0, 6)
        .map((a) => ({ text: a.text.trim(), area: ['prace', 'penize', 'sebe'].includes(a.area) ? a.area : 'prace' }));
    }
  } catch (e) {
    console.log('Akce se nepodařilo naparsovat:', e.message);
  }
}

if (text.length < 300) throw new Error(`Brífink podezřele krátký (${text.length}), neukládám.`);

const out = JSON.stringify(
  { date: today, text, actions, generatedAt: new Date().toISOString(), source: 'cloud-max' },
  null, 1
);
await writeFileToBrain('brief/latest.json', out, `Brífink ${today}`);
await writeFileToBrain(`brief/archive/${today}.json`, out, `Brífink ${today} (archiv)`);
console.log(`Hotovo: ${text.length} znaků, ${actions.length} akcí. Uloženo do zivot-brain.`);
