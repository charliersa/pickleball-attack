// 從 Google 試算表「鹿角包場計劃」讀取營運設定（場次行事曆、收費、場地分級）
// 試算表需設為「知道連結的人可檢視」；改試算表內容，網站重新整理後就會跟著變
// 讀不到時依序改用：上次成功讀到的快取 → 內建預設值（跟試算表 2027 年版本相同）
const SHEET_ID = '12SkrU1zbPJ0c-1PQffjE5BBHT3ON2fZJWgvfgp0MNf8';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const CACHE_KEY = 'sheetConfig.v1';
const TIMEOUT_MS = 6000;

export const DAYS = {
  sun: { label: '週日', short: '日', wd: 0 },
  fri: { label: '週五', short: '五', wd: 5 },
};
export const DAY_KEYS = ['fri', 'sun']; // 一週裡的先後順序

// 場地類型：行事曆「場地／程度」欄裡的關鍵字
export const KINDS = {
  挑戰: { icon: '🔥', name: '進擊挑戰場', desc: '以 3.0+ 為主的跨級挑戰；2.99 以下可挑戰 3.0，3.0 可挑戰更高等級。' },
  交流: { icon: '⚔️', name: '進擊交流場', desc: '同級雙打交流，以球路穩定及戰術配合為主。' },
  初學: { icon: '🌱', name: '初學友善場', desc: '初學友善，從基本動作、規則與輪轉開始，輕鬆上手。' },
};

const DEFAULT_OPS = {
  courtSize: 8, courtCount: 2, trial: 160, single: 180, monthly: 170, seasonPer: 160, seasonSeats: 4, monthSeats: 4,
};
const DEFAULT_NAMES = {
  sun: { 挑戰: '進擊挑戰場', 交流: '進擊交流場' },
  fri: { 初學: '初學友善場', 交流: '進階交流場' },
};
const DEFAULT_COURTS = {
  sun: '第4場地挑戰3.0+／第5場地交流2.5～2.99',
  fri: '第5場地初學2.0／第4場地交流2.5～3.3',
};

const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s元]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

// 簡易 CSV 解析（處理引號與欄位內的逗號、換行）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// '第4場地挑戰3.0+／第5場地交流2.5～2.99' → [{ no:'4', kind:'挑戰', level:'3.0+', name }, …]（依場地號碼排序）
export function parseCourts(str, day, names) {
  return String(str || '').split(/[／/]/).map((part) => {
    const m = part.match(/第?\s*(\d{1,2})\s*號?場地?\s*(挑戰|交流|初學)\s*(.*)/);
    if (!m) return null;
    const [, no, kind, rawLevel] = m;
    const level = rawLevel.trim().replace(/^(\d)$/, '$1.0') || '—';
    return { no, kind, level, name: names?.[day]?.[kind] || KINDS[kind].name };
  }).filter(Boolean).sort((a, b) => Number(a.no) - Number(b.no));
}

function dayOf(date, weekdayCell) {
  if (weekdayCell === '五') return 'fri';
  if (weekdayCell === '日') return 'sun';
  return Object.keys(DAYS).find((k) => DAYS[k].wd === date.getDay()) || null;
}

function parseOps(rows) {
  const ops = { sun: { ...DEFAULT_OPS }, fri: { ...DEFAULT_OPS } };
  const names = { sun: {}, fri: {} };
  const labels = [
    ['每面上限人數', 'courtSize'], ['場地數', 'courtCount'], ['1～2月體驗單價', 'trial'], ['3月起單次單價', 'single'],
    ['3月起月繳每場', 'monthly'], ['3月起季繳每場', 'seasonPer'], ['季繳人數', 'seasonSeats'], ['月繳人數', 'monthSeats'],
  ];
  for (const r of rows) {
    // 左半（A、B 欄）是週日、右半（C、D 欄）是週五；第一列的標題會被併進 A 欄，所以用「包含」比對
    for (const [day, li, vi] of [['sun', 0, 1], ['fri', 2, 3]]) {
      const label = r[li] || '';
      const hit = labels.find(([l]) => label.startsWith(l) || label.endsWith(` ${l}`));
      if (hit && num(r[vi]) !== null) ops[day][hit[1]] = num(r[vi]);
    }
    // 場別列：「週五進階交流場｜2.5～3.3」
    const m = (r[0] || '').match(/^(週日|週五)(.+?場)/);
    const kind = m && Object.keys(KINDS).find((k) => m[2].includes(k));
    if (kind) names[m[1] === '週日' ? 'sun' : 'fri'][kind] = m[2];
  }
  for (const day of Object.keys(names)) names[day] = { ...DEFAULT_NAMES[day], ...names[day] };
  return { ops, names };
}

function parseSchedule(rows, ops, names) {
  const sessions = [];
  for (const r of rows) {
    const m = (r[0] || '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!m) continue;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const day = dayOf(date, r[1]);
    if (!day) continue;
    const title = r[2] || `${DAYS[day].label}包場`;
    const courts = parseCourts(r[3], day, names);
    const trial = title.includes('體驗');
    const price = num(r[7]) ?? (trial ? ops[day].trial : ops[day].single);
    sessions.push({ iso: toISO(date), day, title, trial, price, courts: courts.length ? courts : parseCourts(DEFAULT_COURTS[day], day, names) });
  }
  return sessions.sort((a, b) => a.iso.localeCompare(b.iso));
}

// 跟試算表 2027 年版本相同的內建預設：1～8 月每週五、週日，1～2 月體驗期
function defaultConfig() {
  const ops = { sun: { ...DEFAULT_OPS }, fri: { ...DEFAULT_OPS } };
  const names = DEFAULT_NAMES;
  const sessions = [];
  for (let d = new Date(2027, 0, 1); d < new Date(2027, 8, 1); d.setDate(d.getDate() + 1)) {
    const day = dayOf(d);
    if (!day) continue;
    const trial = d.getMonth() < 2;
    sessions.push({
      iso: toISO(d), day, trial,
      title: `${DAYS[day].label}${trial ? '體驗暢打' : '分級包場'}`,
      price: trial ? ops[day].trial : ops[day].single,
      courts: parseCourts(DEFAULT_COURTS[day], day, names),
    });
  }
  return { sessions, ops, names };
}

async function fetchSheet(name, signal) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error('試算表未公開'); // 沒開放檢視時會回登入頁 HTML
  return parseCsv(text);
}

// 回傳 { sessions, ops, names, source: 'sheet' | 'cache' | 'default', error? }
export async function loadConfig() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const [opsRows, schedRows] = await Promise.all([
      fetchSheet('營運總覽', ctrl.signal).catch(() => []), // 營運總覽讀不到就用預設單價，不影響行事曆
      fetchSheet('2027場次行事曆', ctrl.signal),
    ]);
    const { ops, names } = parseOps(opsRows);
    const sessions = parseSchedule(schedRows, ops, names);
    if (!sessions.length) throw new Error('行事曆沒有場次');
    const cfg = { sessions, ops, names };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch { /* 無痕模式等情況忽略 */ }
    return { ...cfg, source: 'sheet' };
  } catch (err) {
    console.warn('讀取試算表失敗', err);
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached?.sessions?.length) return { ...cached, source: 'cache', error: err };
    } catch { /* 快取壞掉就用預設 */ }
    return { ...defaultConfig(), source: 'default', error: err };
  } finally {
    clearTimeout(timer);
  }
}
