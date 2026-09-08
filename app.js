/* ゆるふわレガシー 階級判定 v1.1 — 静的サイト(ビルド不要)
   名寄せ: data/cards.json(レガシー適法カードの英名+日本語名、名前リスト更新.pyで生成) → 無ければ Scryfall fuzzy
   価格:   晴れる屋 unisearch_api(CORS許可) → 無ければ Scryfall USD×為替 */
'use strict';

const VERSION = 'YFL1';
const TIERS = [
  { k: '1K',   name: 'こんぺいとう',   max: 1000 },
  { k: '2K',   name: 'ラムネ',         max: 2000 },
  { k: '3K',   name: 'グミ',           max: 3000 },
  { k: '4K',   name: 'キャラメル',     max: 4000 },
  { k: '5K',   name: 'わたあめ',       max: 5000 },
  { k: '10K',  name: 'マシュマロ',     max: 10000 },
  { k: '30K',  name: 'ぷりん',         max: 30000 },
  { k: '60K',  name: 'ドーナツ',       max: 60000 },
  { k: '120K', name: 'ショートケーキ', max: 120000 },
  { k: '250K', name: 'パフェ',         max: 250000 },
  { k: '500K', name: 'ホールケーキ',   max: 500000 },
  { k: 'X',    name: 'レガシー',       max: Infinity },
];
TIERS.forEach((t, i) => { t.color = t.k === 'X' ? '#d5d5d5' : 'hsl(' + (205 + i * 13) + ', 75%, 86%)'; });
const GRACE = 1.10;
const VALID_DAYS = 30;
const HARERUYA_API = 'https://www.hareruyamtg.com/ja/products/search/unisearch_api';
const HARERUYA_DETAIL = 'https://www.hareruyamtg.com/ja/products/detail/';
const SCRYFALL = 'https://api.scryfall.com';
const RATE_API = 'https://open.er-api.com/v6/latest/USD';
const RATE_FALLBACK = 150;
const CARD_TTL = 7 * 86400e3;
const PRICE_TTL = 24 * 3600e3;

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yen = (n) => (n == null ? '?' : Math.round(n).toLocaleString('ja-JP'));
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- キャッシュ ----------
const store = {
  get(key, ttl) {
    try { const raw = localStorage.getItem(key); if (!raw) return null; const o = JSON.parse(raw); if (Date.now() - o.t > ttl) return null; return o.v; } catch (e) { return null; }
  },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch (e) {} },
  raw(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } },
  put(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} },
};
let useCache = true;

// ---------- カードDB(data/cards.json) ----------
// レコード: {name, ja, h(晴れる屋検索名), basic, legal: 'legal'|'banned'|'not_legal'}
const DB = { ready: null, byName: new Map(), byJa: new Map(), list: [], banned: new Set() };
function loadDB() {
  if (DB.ready) return DB.ready;
  DB.ready = fetch('data/cards.json').then((r) => r.json()).then((d) => {
    for (const b of d.banned || []) DB.banned.add(b);
    for (const [name, ja, h, basic] of d.cards) {
      const rec = { name, ja: ja || '', h: h || name, basic: !!basic, legal: 'legal', lc: name.toLowerCase() };
      DB.byName.set(rec.lc, rec); if (ja) DB.byJa.set(ja, rec); DB.list.push(rec);
    }
    for (const b of d.banned || []) if (!DB.byName.has(b.toLowerCase())) {
      const rec = { name: b, ja: '', h: b, basic: false, legal: 'banned', lc: b.toLowerCase() };
      DB.byName.set(rec.lc, rec); DB.list.push(rec);
    }
    return DB;
  }).catch((e) => { console.warn('cards.json 読み込み失敗', e); return DB; });
  return DB.ready;
}
function searchDB(q) {
  q = q.trim(); if (!q) return [];
  const lq = q.toLowerCase();
  const hits = [];
  for (const r of DB.list) {
    let score = -1, len = r.name.length;
    if (r.lc === lq || r.ja === q) score = 0;
    else if (r.lc.startsWith(lq)) score = 1;
    else if (r.ja && r.ja.startsWith(q)) { score = 1; len = r.ja.length; }
    else if (r.lc.split(/[\s,]+/).some((w) => w.startsWith(lq))) score = 2;
    else if (r.lc.includes(lq)) score = 3;
    else if (r.ja && r.ja.includes(q)) { score = 3; len = r.ja.length; }
    if (score >= 0) { hits.push([score, len, r]); if (hits.length > 3000) break; }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, 15).map((h) => h[2]);
}

// ---------- 名寄せ(DB → Scryfall) ----------
function lookupName(name) { return name.split('//')[0].trim(); }
function recFromScryfall(c) {
  const faces = (c.card_faces || []).map((f) => f.name);
  let h = c.name;
  if ((c.layout === 'split' || c.layout === 'aftermath') && faces.length) h = faces.join('/');
  else if (faces.length) h = faces[0];
  const lg = (c.legalities || {}).legacy;
  return { name: c.name, ja: '', h, basic: /^Basic/.test(c.type_line || ''), legal: lg === 'banned' ? 'banned' : (lg === 'legal' || lg === 'restricted') ? 'legal' : 'not_legal', lc: c.name.toLowerCase() };
}
function resolveLocal(n) {
  const jp = n.match(/《([^》]*)》/);
  if (jp) { const sl = jp[1].split('/'); n = sl.length > 1 ? sl.slice(1).join('/').trim() : jp[1].trim(); }
  const lc = n.toLowerCase();
  let r = DB.byName.get(lc) || DB.byJa.get(n);
  if (r) return r;
  r = DB.byName.get(lookupName(n).toLowerCase()); if (r) return r;
  // 表面名・分割名で引く
  for (const x of DB.list) if (x.h.toLowerCase() === lc || x.h.toLowerCase() === lc.replace(/\s*\/\/\s*/g, '/')) return x;
  return null;
}
async function resolveNames(names, onProgress) {
  await loadDB();
  const out = new Map(); const todo = [];
  for (const n of names) {
    const r = resolveLocal(n); if (r) { out.set(n, r); continue; }
    const c = useCache ? store.get('yfl.card2.' + n.toLowerCase(), CARD_TTL) : null;
    if (c) out.set(n, c); else todo.push(n);
  }
  for (const n of todo) {
    if (onProgress) onProgress('名寄せ中(Scryfall): ' + n);
    try {
      const r = await fetch(SCRYFALL + '/cards/named?fuzzy=' + encodeURIComponent(lookupName(n)));
      if (r.ok) {
        const c = recFromScryfall(await r.json());
        const local = DB.byName.get(c.lc); const rec = local || c;
        out.set(n, rec); store.set('yfl.card2.' + n.toLowerCase(), rec);
      }
    } catch (e) {}
    await sleep(110);
  }
  return out;
}

// ---------- 価格 ----------
async function fetchHareruya(rec) {
  const url = HARERUYA_API + '?fq.card_name=' + encodeURIComponent(rec.h) + '&fq.foil_flg=0&fq.price=1%7E%2A&sort=price+asc&rows=60';
  const r = await fetch(url);
  if (!r.ok) throw new Error('hareruya http ' + r.status);
  const d = await r.json();
  const docs = ((d.response || {}).docs || []).filter((x) =>
    x.foil_flg === '0' && +x.price > 0 &&
    !/傷|Damaged|プレイド|PLD/i.test(x.product_name || '') &&
    !/【アート・カード】|トークン|プレイマット/.test(x.product_name || ''));
  if (!docs.length) return null;
  const inStock = docs.filter((x) => +x.stock > 0);
  const pick = (inStock.length ? inStock : docs).reduce((a, b) => (+a.price <= +b.price ? a : b));
  return { price: +pick.price, product: pick.product, pname: pick.product_name, stock: +pick.stock, src: inStock.length ? 'hareruya' : 'hareruya-nostock' };
}
async function fetchScryfallMin(rec) {
  const q = '!"' + rec.name.replace(/"/g, '') + '" game:paper';
  const r = await fetch(SCRYFALL + '/cards/search?q=' + encodeURIComponent(q) + '&unique=prints&order=usd&dir=asc');
  if (!r.ok) return null;
  const d = await r.json();
  for (const c of d.data || []) if (c.prices && c.prices.usd) return { usd: +c.prices.usd, set: c.set };
  for (const c of d.data || []) if (c.prices && c.prices.usd_foil) return { usd: +c.prices.usd_foil, set: c.set, foil: true };
  return null;
}
let ratePromise = null;
function getRate() {
  const manual = parseFloat($('#rate').value);
  if (manual > 0) return Promise.resolve({ rate: manual, src: '手入力' });
  const c = store.get('yfl.rate', PRICE_TTL); if (c) return Promise.resolve(c);
  if (!ratePromise) ratePromise = fetch(RATE_API).then((r) => r.json()).then((d) => {
    if (d && d.rates && d.rates.JPY) { const v = { rate: d.rates.JPY, src: 'open.er-api.com' }; store.set('yfl.rate', v); return v; }
    return { rate: RATE_FALLBACK, src: '既定値' };
  }).catch(() => ({ rate: RATE_FALLBACK, src: '既定値' }));
  return ratePromise;
}
// 外部API(晴れる屋/Scryfall)への同時リクエストを2並列・300ms間隔に制限
const limiter = { active: 0, max: 2, gap: 300, queue: [] };
function withLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      limiter.active++;
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { await sleep(limiter.gap); limiter.active--; const next = limiter.queue.shift(); if (next) next(); }
    };
    if (limiter.active < limiter.max) run(); else limiter.queue.push(run);
  });
}
const priceInflight = new Map();
function priceCard(rec) {
  if (rec.basic) return Promise.resolve({ price: 0, src: 'basic' });
  const key = 'yfl.price.' + rec.lc;
  const c = useCache ? store.get(key, PRICE_TTL) : null; if (c) return Promise.resolve(c);
  if (priceInflight.has(key)) return priceInflight.get(key);
  const p = (async () => {
    let res = null;
    try { res = await withLimit(() => fetchHareruya(rec)); } catch (e) { console.warn('hareruya', rec.name, e); }
    if (!res) {
      try { const rate = await getRate(); const s = await withLimit(() => fetchScryfallMin(rec)); if (s) res = { price: Math.ceil(s.usd * rate.rate), src: 'scryfall', usd: s.usd, set: s.set }; } catch (e) {}
    }
    if (!res) res = { price: null, src: 'none' };
    store.set(key, res); priceInflight.delete(key);
    return res;
  })();
  priceInflight.set(key, p);
  return p;
}

// ---------- 階級・ハッシュ・コード ----------
function tierFor(total, grace) {
  for (const t of TIERS) {
    if (total <= t.max) return { tier: t, grace: false };
    if (grace && total <= t.max * GRACE) return { tier: t, grace: true };
  }
  return { tier: TIERS[TIERS.length - 1], grace: false };
}
function fnv1a(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function toB32(nums, len) { let bits = ''; for (const n of nums) bits += n.toString(2).padStart(32, '0'); let s = ''; for (let i = 0; i + 5 <= bits.length && s.length < len; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)]; return s; }
function deckHash(entries) {
  const items = [];
  for (const e of entries) for (let i = 0; i < e.qty; i++) items.push((e.side ? 'sb:' : '') + e.name.toLowerCase());
  items.sort();
  const s = items.join('\n');
  return toB32([fnv1a(s, 2166136261), fnv1a(s, 0x9747b28c)], 8);
}
function checksum(s) { return toB32([fnv1a(s, 0x811c9dc5 ^ 0x5bd1e995)], 2); }
function makeCode(tierK, hash, dateStr, total) { const body = [VERSION, tierK, hash, dateStr, Math.round(total)].join('.'); return body + '.' + checksum(body); }
function parseCode(code) {
  const p = code.trim().toUpperCase().split('.');
  if (p.length !== 6 || p[0] !== VERSION) return { ok: false, reason: '形式が違います(YFL1.階級.ハッシュ.日付.合計.チェック)' };
  const [ver, tier, hash, date, total, chk] = p;
  if (checksum([ver, tier, hash, date, total].join('.')) !== chk) return { ok: false, reason: 'チェック桁が一致しません(打ち間違い or 改ざん)' };
  const t = TIERS.find((x) => x.k === tier); if (!t) return { ok: false, reason: '階級が不正です' };
  if (!/^\d{8}$/.test(date)) return { ok: false, reason: '日付が不正です' };
  const d = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
  const age = Math.floor((Date.now() - d.getTime()) / 86400e3);
  return { ok: true, tier: t, hash, date, dateObj: d, total: +total, ageDays: age, valid: age >= 0 && age <= VALID_DAYS };
}
function todayStr() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function b64u(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
function tierLabel(t) { return t.k === 'X' ? '無差別級' : t.k + '級'; }
function badgeHtml(t, cls) { return '<span class="badge ' + (cls || '') + '" style="background:' + t.color + '">' + tierLabel(t) + ' ' + t.name + '</span>'; }

// ---------- デッキ状態 ----------
// deck.main / deck.side: [{name, qty}]  / cards: name→rec / prices: name→{price,...}
const deck = { main: [], side: [] };
const cards = new Map();
const prices = new Map();
function saveDeck() { store.put('yfl.deck', deck); }
function loadDeck() { const d = store.raw('yfl.deck'); if (d && d.main) { deck.main = d.main; deck.side = d.side || []; } }
function count(list) { return list.reduce((a, e) => a + e.qty, 0); }

async function ensureCard(name) {
  if (cards.has(name)) return cards.get(name);
  const m = await resolveNames([name]);
  const rec = m.get(name); if (rec) cards.set(name, rec);
  return rec;
}
function ensurePrice(rec) {
  if (!rec || prices.has(rec.name)) return;
  prices.set(rec.name, null);
  priceCard(rec).then((p) => { prices.set(rec.name, p); renderLists(); updateLive(); });
}
function addCard(rec, side, qty) {
  const list = side ? deck.side : deck.main;
  const e = list.find((x) => x.name === rec.name);
  if (e) e.qty += (qty || 1); else list.push({ name: rec.name, qty: qty || 1 });
  cards.set(rec.name, rec); ensurePrice(rec);
  saveDeck(); renderLists(); updateLive();
}
function changeQty(side, name, delta) {
  const list = side ? deck.side : deck.main;
  const i = list.findIndex((x) => x.name === name); if (i < 0) return;
  list[i].qty += delta; if (list[i].qty <= 0) list.splice(i, 1);
  saveDeck(); renderLists(); updateLive();
}
function moveCard(side, name) {
  const from = side ? deck.side : deck.main, to = side ? deck.main : deck.side;
  const i = from.findIndex((x) => x.name === name); if (i < 0) return;
  const e = from.splice(i, 1)[0];
  const t = to.find((x) => x.name === name); if (t) t.qty += e.qty; else to.push(e);
  saveDeck(); renderLists(); updateLive();
}
function rowHtml(e, side) {
  const rec = cards.get(e.name); const p = prices.get(e.name);
  let pr, cls = 'pr';
  if (rec && rec.basic) { pr = '0円'; cls += ' zero'; }
  else if (p === undefined || p === null) { pr = '取得中…'; cls += ' wait'; }
  else if (p.price == null) { pr = '価格なし'; cls += ' hi'; }
  else { pr = yen(p.price * e.qty) + '円'; if (p.price >= 1000) cls += ' hi'; }
  let flag = '';
  if (rec && rec.legal === 'banned') flag = '<span class="flag">禁止</span>';
  else if (rec && rec.legal === 'not_legal') flag = '<span class="flag">使用不可</span>';
  else if (!rec) flag = '<span class="flag">不明</span>';
  const title = p && p.price != null && !(rec && rec.basic) ? ('単価 ' + yen(p.price) + '円 ' + (p.pname || '')) : '';
  return '<div class="row" data-side="' + (side ? 1 : 0) + '" data-name="' + esc(e.name) + '" title="' + esc(title) + '">' +
    '<div class="nm">' + esc(e.name) + (rec && rec.ja ? '<small>' + esc(rec.ja) + '</small>' : '') + flag + '</div>' +
    '<div class="ctl"><button data-act="dec" title="1枚減らす">−</button><span class="qty">' + e.qty + '</span><button data-act="inc" title="1枚増やす">+</button>' +
    '<span class="' + cls + '">' + pr + '</span>' +
    '<button data-act="move" title="' + (side ? 'メインへ' : 'サイドへ') + '">' + (side ? '↑' : '↓') + '</button><button data-act="del" title="削除">×</button></div></div>';
}
function renderLists() {
  const sortFn = (a, b) => { const pa = prices.get(a.name), pb = prices.get(b.name); return ((pb && pb.price) || 0) * b.qty - ((pa && pa.price) || 0) * a.qty || a.name.localeCompare(b.name); };
  $('#mainList').innerHTML = deck.main.length ? [...deck.main].sort(sortFn).map((e) => rowHtml(e, false)).join('') : '<div class="empty">まだカードがありません</div>';
  $('#sideList').innerHTML = deck.side.length ? [...deck.side].sort(sortFn).map((e) => rowHtml(e, true)).join('') : '<div class="empty">サイドは空です</div>';
  $('#mainCount').textContent = count(deck.main); $('#sideCount').textContent = count(deck.side);
}
function liveTotal() {
  let total = 0, pending = 0, missing = [];
  for (const [list, side] of [[deck.main, false], [deck.side, true]]) for (const e of list) {
    const rec = cards.get(e.name); const p = prices.get(e.name);
    if (rec && rec.basic) continue;
    if (!p) { pending++; continue; }
    if (p.price == null) { missing.push(e.name); continue; }
    total += p.price * e.qty;
  }
  return { total, pending, missing };
}
function updateLive() {
  const { total, pending } = liveTotal();
  const res = tierFor(total, $('#grace').checked);
  const t = res.tier;
  const b = $('#liveBadge'); b.textContent = tierLabel(t) + ' ' + t.name; b.style.background = t.color;
  $('#liveTotal').textContent = yen(total);
  $('#liveNote').textContent = (pending ? '(' + pending + '枚 取得中) ' : '') + (res.grace ? '上限 ' + yen(t.max) + '円を超過、猶予内' : isFinite(t.max) ? '/ 上限 ' + yen(t.max) + '円' : '');
  const n = count(deck.main), s = count(deck.side);
  const idx = TIERS.indexOf(t);
  let line = 'メイン ' + n + '枚 + サイド ' + s + '枚';
  if (idx > 0) line += ' / ' + tierLabel(TIERS[idx - 1]) + 'まであと ' + yen(total - TIERS[idx - 1].max) + '円';
  if (isFinite(t.max) && !res.grace) line += ' / 残り予算 ' + yen(t.max - total) + '円';
  $('#liveLine').textContent = line;
  $('#result').hidden = true; $('#breakdownCard').hidden = true;
}

// ---------- 検索UI ----------
let ddItems = [], ddSel = -1;
function renderDD(items, q) {
  const dd = $('#dd');
  ddItems = items; ddSel = items.length ? 0 : -1;
  if (!q) { dd.hidden = true; return; }
  if (!items.length) { dd.innerHTML = '<div class="hint">見つかりません。' + (DB.list.length ? '英名の途中でも日本語名でも探せます。' : 'カードリスト読み込み中…') + '</div>'; dd.hidden = false; return; }
  dd.innerHTML = items.map((r, i) => '<div class="item' + (i === ddSel ? ' sel' : '') + '" data-i="' + i + '"><span class="nm">' + esc(r.name) + (r.ja ? '<span class="ja">' + esc(r.ja) + '</span>' : '') + (r.legal === 'banned' ? '<span class="ban">レガシー禁止</span>' : '') + '</span>' +
    '<button class="ghost" data-add="main" data-i="' + i + '">メイン</button><button class="ghost" data-add="side" data-i="' + i + '">サイド</button></div>').join('');
  dd.hidden = false;
}
function ddPick(i, side) {
  const r = ddItems[i]; if (!r) return;
  addCard(r, side, 1);
  toast((side ? 'サイド' : 'メイン') + 'に追加: ' + r.name);
  $('#q').value = ''; renderDD([], ''); $('#q').focus();
}
let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await loadDB();
    const q = $('#q').value;
    renderDD(searchDB(q), q);
  }, 60);
}

// ---------- テキスト入出力 ----------
function parseDecklist(text) {
  const main = [], side = [];
  let cur = main, sawMain = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { if (sawMain && cur === main) cur = side; continue; }
    if (/^(sideboard|side|sb|サイドボード|サイド)\s*[:：]?$/i.test(line) || /^\/\/\s*sideboard/i.test(line)) { cur = side; continue; }
    if (/^(deck|main|maindeck|mainboard|メイン|メインデッキ|メインボード)\s*[:：]?$/i.test(line)) { cur = main; continue; }
    if (/^(commander|companion|統率者|相棒)\s*[:：]?$/i.test(line)) continue;
    if (/^(\/\/|#)/.test(line)) continue;
    let target = cur, body = line;
    if (/^SB:\s*/i.test(body)) { target = side; body = body.replace(/^SB:\s*/i, ''); }
    const m = body.match(/^(\d+)\s*[xX×]?\s+(.+)$/) || body.match(/^(.+?)\s*[xX×]\s*(\d+)$/);
    let qty, name;
    if (m) { if (/^\d+$/.test(m[1])) { qty = +m[1]; name = m[2]; } else { qty = +m[2]; name = m[1]; } } else { qty = 1; name = body; }
    const jp = name.match(/《([^》]*)》/);
    if (jp) { const sl = jp[1].split('/'); name = sl.length > 1 ? sl.slice(1).join('/').trim() : jp[1].trim(); }
    name = name.replace(/\s+\([A-Za-z0-9]{2,6}\)\s*[\w★☆-]*\s*$/, '').replace(/\s*\*F\*\s*$/i, '').replace(/\s+#\d+$/, '').replace(/\s+\[[^\]]*\]$/, '').trim();
    if (!name) continue;
    target.push({ qty, name, raw }); sawMain = true;
  }
  return { main, side };
}
async function importText(text) {
  const { main, side } = parseDecklist(text);
  if (!main.length && !side.length) { toast('デッキリストが空です'); return; }
  const setStatus = (s) => { $('#status').textContent = s; };
  setStatus('カード名を名寄せ中…');
  const names = [...new Set([...main, ...side].map((e) => e.name))];
  const m = await resolveNames(names, setStatus);
  deck.main = []; deck.side = [];
  const unknown = [];
  for (const [list, target] of [[main, deck.main], [side, deck.side]]) for (const e of list) {
    const rec = m.get(e.name);
    if (!rec) { unknown.push(e.name); continue; }
    cards.set(rec.name, rec); ensurePrice(rec);
    const x = target.find((y) => y.name === rec.name); if (x) x.qty += e.qty; else target.push({ name: rec.name, qty: e.qty });
  }
  saveDeck(); renderLists(); updateLive();
  setStatus(unknown.length ? '読み込み完了。見つからなかった名前: ' + unknown.join(', ') : '読み込み完了');
}
function exportText() {
  const line = (e) => e.qty + ' ' + e.name;
  return deck.main.map(line).join('\n') + (deck.side.length ? '\n\nSideboard\n' + deck.side.map(line).join('\n') : '') + '\n';
}

// ---------- 判定 ----------
let last = null;
async function judge() {
  if (!deck.main.length && !deck.side.length) { toast('デッキが空です'); return; }
  useCache = !$('#nocache').checked;
  const btn = $('#run'); btn.disabled = true;
  const setStatus = (s) => { $('#status').textContent = s; };
  const setBar = (p) => { $('#bar').style.width = Math.round(p * 100) + '%'; };
  try {
    setBar(0.1); setStatus('価格を確認中…');
    const names = [...new Set([...deck.main, ...deck.side].map((e) => e.name))];
    const recs = [];
    for (const n of names) { const r = await ensureCard(n); if (r) recs.push(r); }
    if (!useCache) prices.clear();
    let done = 0;
    await Promise.all(recs.map(async (r) => { const p = await priceCard(r); prices.set(r.name, p); done++; setBar(0.1 + 0.8 * done / recs.length); setStatus('価格取得 ' + done + '/' + recs.length); }));
    const rate = await getRate();
    const rows = [], unknown = [], banned = [], noprice = [], over4 = [];
    let total = 0;
    for (const [list, isSide] of [[deck.main, false], [deck.side, true]]) for (const e of list) {
      const rec = cards.get(e.name);
      if (!rec) { unknown.push(e.name); rows.push({ name: e.name, qty: e.qty, side: isSide, unit: null, sub: 0, src: 'unknown' }); continue; }
      const p = prices.get(rec.name) || { price: null, src: 'none' };
      if (rec.legal === 'banned') banned.push(rec.name); else if (rec.legal !== 'legal') unknown.push(rec.name + '(レガシー使用不可)');
      if (!rec.basic && p.price == null) noprice.push(rec.name);
      const sub = (p.price || 0) * e.qty; total += sub;
      rows.push({ name: rec.name, qty: e.qty, side: isSide, unit: rec.basic ? 0 : p.price, sub, src: rec.basic ? 'basic' : p.src, product: p.product, pname: p.pname, stock: p.stock, usd: p.usd, rec });
    }
    const copies = new Map();
    for (const r of rows) if (r.rec && !r.rec.basic) copies.set(r.name, (copies.get(r.name) || 0) + r.qty);
    for (const [n, c] of copies) if (c > 4) over4.push(n + '×' + c);
    const res = tierFor(total, $('#grace').checked);
    const hash = deckHash(rows.filter((r) => r.rec).map((r) => ({ name: r.name, qty: r.qty, side: r.side })));
    const dateStr = todayStr();
    const code = makeCode(res.tier.k, hash, dateStr, total);
    last = { rows, total, res, hash, code, dateStr, rate, text: exportText(), banned, unknown, noprice, over4 };
    renderResult(last); updateLiveFrom(last);
    setStatus('判定完了: 為替 ' + rate.rate.toFixed(1) + '円 (' + rate.src + ') / 判定日 ' + dateStr); setBar(1);
    history.replaceState(null, '', '#deck=' + b64u(last.text));
  } catch (e) { console.error(e); setStatus('エラー: ' + e.message); }
  finally { btn.disabled = false; }
}
function updateLiveFrom(L) {
  const t = L.res.tier; const b = $('#liveBadge'); b.textContent = tierLabel(t) + ' ' + t.name; b.style.background = t.color;
  $('#liveTotal').textContent = yen(L.total);
  $('#liveNote').textContent = L.res.grace ? '(上限 ' + yen(t.max) + '円を超過、猶予10%以内)' : (isFinite(t.max) ? '/ 上限 ' + yen(t.max) + '円' : '');
  $('#liveLine').textContent = 'メイン ' + count(deck.main) + '枚 + サイド ' + count(deck.side) + '枚 / ハッシュ ' + L.hash + ' / 判定日 ' + L.dateStr;
}
function spellTableText(L) { return '[ゆるふわ ' + L.res.tier.k + '] ' + L.code; }
function renderResult(L) {
  $('#result').hidden = false; $('#breakdownCard').hidden = false;
  const t = L.res.tier; const idx = TIERS.indexOf(t);
  const mainN = count(deck.main), sideN = count(deck.side);
  const w = [];
  if (L.res.grace) w.push('<div class="warn">上限を超えていますが猶予10%以内です。主催者が「猶予なし」の場合は ' + badgeHtml(TIERS[idx + 1], 'small') + ' になります。</div>');
  if (L.banned.length) w.push('<div class="warn bad">レガシー禁止カードが含まれています: ' + esc(L.banned.join(', ')) + '</div>');
  if (L.unknown.length) w.push('<div class="warn bad">カードが見つからない/使用不可: ' + esc(L.unknown.join(', ')) + '</div>');
  if (L.noprice.length) w.push('<div class="warn">価格が取得できませんでした(0円で計算): ' + esc(L.noprice.join(', ')) + '</div>');
  if (L.over4.length) w.push('<div class="warn bad">同名カードが5枚以上あります: ' + esc(L.over4.join(', ')) + '</div>');
  if (mainN < 60) w.push('<div class="warn">メインが60枚未満です(' + mainN + '枚)</div>');
  if (sideN > 15) w.push('<div class="warn">サイドが15枚を超えています(' + sideN + '枚)</div>');
  if (!w.length) w.push('<div class="warn ok">問題なし。レガシー適法・価格取得OK。</div>');
  $('#warnings').innerHTML = w.join('');
  $('#code').textContent = L.code;
  $('#stExample').textContent = spellTableText(L);
  const rows = [...L.rows].sort((a, b) => (b.sub - a.sub) || (a.side - b.side));
  let h = '<tr><th>カード</th><th class="num">枚</th><th class="num">単価</th><th class="num">小計</th><th>取得元</th></tr>';
  for (const r of rows) {
    const nm = esc(r.name) + (r.rec && r.rec.ja ? ' <span class="src">' + esc(r.rec.ja) + '</span>' : '');
    const link = r.product ? '<a href="' + HARERUYA_DETAIL + r.product + '" target="_blank" rel="noopener">' + nm + '</a>' : nm;
    let src = '';
    if (r.src === 'basic') src = '基本土地(0円)';
    else if (r.src === 'hareruya') src = '晴れる屋 在庫' + r.stock + '<div class="src">' + esc(r.pname || '') + '</div>';
    else if (r.src === 'hareruya-nostock') src = '晴れる屋(在庫なし)<div class="src">' + esc(r.pname || '') + '</div>';
    else if (r.src === 'scryfall') src = 'Scryfall $' + r.usd + '×為替';
    else if (r.src === 'unknown') src = '<span style="color:#c00">不明</span>';
    else src = '<span style="color:#c00">価格なし</span>';
    h += '<tr class="' + (r.side ? 'sb' : '') + '"><td>' + (r.side ? '<span class="src">SB</span> ' : '') + link + '</td><td class="num">' + r.qty + '</td><td class="num">' + (r.unit == null ? '?' : yen(r.unit)) + '</td><td class="num">' + yen(r.sub) + '</td><td>' + src + '</td></tr>';
  }
  h += '<tr><th>合計</th><th class="num">' + rows.reduce((a, r) => a + r.qty, 0) + '</th><th></th><th class="num">' + yen(L.total) + '</th><th></th></tr>';
  $('#breakdown').innerHTML = h;
  let s = '';
  if (idx > 0) {
    const lower = TIERS[idx - 1]; const need = L.total - lower.max;
    const cand = rows.filter((r) => r.unit > 0); let acc = 0; const picks = [];
    for (const r of cand) { if (acc >= need) break; const n = Math.min(r.qty, Math.ceil((need - acc) / r.unit)); acc += n * r.unit; picks.push(esc(r.name) + '×' + n); }
    s += '<h3>ひとつ下の階級にするには</h3><p class="mute">' + badgeHtml(lower, 'small') + ' まであと <b>' + yen(need) + '円</b>。例: ' + picks.join('、') + ' を抜く/安いカードに替える。</p>';
  }
  if (idx < TIERS.length - 1 && !L.res.grace) s += '<p class="mute">この階級の残り予算: <b>' + yen(t.max - L.total) + '円</b></p>';
  $('#suggest').innerHTML = s;
}

// ---------- オーバーレイPNG ----------
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function saveOverlay(L) {
  const t = L.res.tier;
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 200;
  const g = cv.getContext('2d');
  g.fillStyle = '#222'; roundRect(g, 0, 0, 640, 200, 24); g.fill();
  g.fillStyle = t.color; roundRect(g, 16, 16, 200, 168, 18); g.fill();
  g.fillStyle = '#222'; g.textAlign = 'center';
  g.font = 'bold ' + (t.k.length > 3 ? 44 : 56) + 'px sans-serif'; g.fillText(t.k === 'X' ? '∞' : t.k, 116, 106);
  g.font = 'bold 20px sans-serif'; g.fillText(t.k === 'X' ? '無差別級' : t.name, 116, 158);
  g.textAlign = 'left'; g.fillStyle = '#fff';
  g.font = 'bold 28px sans-serif'; g.fillText('ゆるふわレガシー', 240, 60);
  g.font = '24px sans-serif'; g.fillText('デッキ合計 ' + yen(L.total) + '円' + (L.res.grace ? ' (猶予)' : ''), 240, 100);
  g.font = '18px monospace'; g.fillStyle = '#ccc'; g.fillText('#' + L.hash + '  ' + L.dateStr, 240, 140);
  g.font = '14px sans-serif'; g.fillStyle = '#999'; g.fillText('晴れる屋最安価格基準 / 30日有効', 240, 172);
  const a = document.createElement('a'); a.download = 'yurufuwa_' + t.k + '_' + L.hash + '.png'; a.href = cv.toDataURL('image/png'); a.click();
}

// ---------- 検証 ----------
function verify() {
  const r = parseCode($('#vcode').value);
  if (!r.ok) { $('#vresult').innerHTML = '<div class="warn bad">無効: ' + esc(r.reason) + '</div>'; return; }
  const out = [];
  out.push('<div class="tierbig">' + badgeHtml(r.tier, 'big') + '<div><div class="total">' + yen(r.total) + '円</div><div class="mute">判定日 ' + r.date.slice(0, 4) + '/' + r.date.slice(4, 6) + '/' + r.date.slice(6, 8) + '(' + r.ageDays + '日前) / ハッシュ ' + r.hash + '</div></div></div>');
  out.push(r.valid ? '<div class="warn ok">有効期間内(' + VALID_DAYS + '日)です。チェック桁OK。</div>' : '<div class="warn bad">有効期限切れ(' + VALID_DAYS + '日超)または未来の日付です。再判定してもらってください。</div>');
  const strict = tierFor(r.total, false).tier, loose = tierFor(r.total, true).tier;
  if (r.tier.k !== loose.k && r.tier.k !== strict.k) out.push('<div class="warn bad">合計 ' + yen(r.total) + '円 と階級 ' + r.tier.k + ' が矛盾しています(改ざんの可能性)。</div>');
  else if (r.tier.k !== strict.k) out.push('<div class="warn">この階級は猶予10%を使っています(猶予なしなら ' + tierLabel(strict) + ')。</div>');
  const dtext = $('#vdeck').value.trim();
  if (dtext) {
    out.push('<div id="vhash" class="mute">デッキリストを照合中…</div>');
    const { main, side } = parseDecklist(dtext);
    resolveNames([...new Set([...main, ...side].map((e) => e.name))]).then((m) => {
      const entries = [];
      for (const [list, isSide] of [[main, false], [side, true]]) for (const e of list) { const c = m.get(e.name); if (c) entries.push({ name: c.name, qty: e.qty, side: isSide }); }
      const h = deckHash(entries); const el = $('#vhash'); if (!el) return;
      el.innerHTML = h === r.hash ? '<div class="warn ok">デッキリストのハッシュ ' + h + ' がコードと一致しました。</div>' : '<div class="warn bad">デッキリストのハッシュ ' + h + ' がコード(' + r.hash + ')と一致しません。リストが違うか、変更後に再判定していません。</div>';
    });
  }
  $('#vresult').innerHTML = out.join('');
}

// ---------- UI ----------
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 1600); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch (e) { prompt('コピーしてください', text); } }

const SAMPLE = [
  '4 Goblin Guide', '4 Monastery Swiftspear', '4 Eidolon of the Great Revel', '4 Lightning Bolt', '4 Lava Spike', '4 Rift Bolt', '4 Skewer the Critics',
  '4 Fireblast', '4 Price of Progress', '4 Chain Lightning', '2 Searing Blood', '18 Mountain',
  '', 'Sideboard', '3 Red Elemental Blast', '3 Smash to Smithereens', '3 Roiling Vortex', '3 Surgical Extraction', '3 Sulfuric Vortex',
].join('\n');

document.addEventListener('DOMContentLoaded', () => {
  $('#legend').innerHTML = TIERS.map((t) => badgeHtml(t, 'small').replace('</span>', ' <small>' + (isFinite(t.max) ? '〜' + yen(t.max) + '円' : '上限なし') + '</small></span>')).join('');
  $('#tierTable').innerHTML = '<tr><th>階級</th><th>愛称</th><th class="num">上限</th></tr>' + TIERS.map((t) => '<tr><td>' + badgeHtml(t) + '</td><td>' + t.name + '</td><td class="num">' + (isFinite(t.max) ? yen(t.max) + '円' : '上限なし') + '</td></tr>').join('');
  document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
  }));
  // 検索
  const q = $('#q');
  q.addEventListener('input', onSearchInput);
  q.addEventListener('focus', () => { loadDB(); if (q.value) onSearchInput(); });
  q.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (ddItems.length) { ddSel = (ddSel + 1) % ddItems.length; renderDD(ddItems, q.value); highlight(); } }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (ddItems.length) { ddSel = (ddSel - 1 + ddItems.length) % ddItems.length; renderDD(ddItems, q.value); highlight(); } }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (ddSel >= 0) ddPick(ddSel, ev.shiftKey); }
    else if (ev.key === 'Escape') { renderDD([], ''); }
  });
  function highlight() { const el = $('#dd .item.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  $('#dd').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-add]'); if (b) { ddPick(+b.dataset.i, b.dataset.add === 'side'); return; }
    const it = ev.target.closest('.item'); if (it) ddPick(+it.dataset.i, false);
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.searchbox')) $('#dd').hidden = true; });
  // リスト操作
  for (const id of ['#mainList', '#sideList']) $(id).addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const row = b.closest('.row'); const side = row.dataset.side === '1'; const name = row.dataset.name;
    if (b.dataset.act === 'inc') changeQty(side, name, 1);
    else if (b.dataset.act === 'dec') changeQty(side, name, -1);
    else if (b.dataset.act === 'del') changeQty(side, name, -999);
    else if (b.dataset.act === 'move') moveCard(side, name);
  });
  $('#basicsBtn').addEventListener('click', async () => {
    await loadDB();
    const pick = prompt('足す基本土地と枚数(例: 島 10, 山 8 / Island 10)', '島 20');
    if (!pick) return;
    for (const part of pick.split(/[,、]/)) {
      const m = part.trim().match(/^(.+?)\s*[x×]?\s*(\d+)$/) || part.trim().match(/^(\d+)\s*[x×]?\s*(.+)$/);
      if (!m) continue;
      const [a, b] = /^\d+$/.test(m[1]) ? [m[2], +m[1]] : [m[1], +m[2]];
      const rec = resolveLocal(a.trim()); if (rec) addCard(rec, false, b); else toast('見つかりません: ' + a);
    }
  });
  $('#sample').addEventListener('click', () => importText(SAMPLE));
  $('#clear').addEventListener('click', () => { if (!deck.main.length && !deck.side.length) return; if (!confirm('デッキを全部消しますか?')) return; deck.main = []; deck.side = []; saveDeck(); renderLists(); updateLive(); history.replaceState(null, '', location.pathname); });
  $('#importBtn').addEventListener('click', () => importText($('#deck').value));
  $('#exportBtn').addEventListener('click', () => { $('#deck').value = exportText(); });
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.copy;
    if (k === 'text') { copy(exportText()); return; }
    if (!last) return;
    if (k === 'code') copy(last.code);
    else if (k === 'spelltable') copy(spellTableText(last));
    else if (k === 'url') copy(location.origin + location.pathname + '#deck=' + b64u(last.text));
  }));
  $('#grace').addEventListener('change', updateLive);
  $('#run').addEventListener('click', judge);
  $('#overlay').addEventListener('click', () => { if (last) saveOverlay(last); });
  $('#vrun').addEventListener('click', verify);
  $('#vprice').addEventListener('click', async () => { document.querySelector('[data-tab=judge]').click(); await importText($('#vdeck').value); judge(); });
  // 初期化: 共有URL → 保存デッキ
  const m = location.hash.match(/#deck=(.+)/);
  loadDB().then(async () => {
    if (m) { try { await importText(unb64u(m[1])); judge(); return; } catch (e) {} }
    loadDeck();
    for (const e of [...deck.main, ...deck.side]) { const rec = await ensureCard(e.name); if (rec) ensurePrice(rec); }
    renderLists(); updateLive();
  });
  renderLists();
});
