// 進擊的匹克團 接龍報名（LIFF + Firebase Realtime Database + Google 試算表設定）
// 每週五、週日兩個時段，各兩面場（鹿角 4、5 號），每面 8 人：會員保留名額 + 單次接龍；會員請假時名額自動釋出
// 場次行事曆、價格、場地分級從 Google 試算表「鹿角包場計劃」讀取（sheet.js）；報名資料存 Firebase
// 無 ?e= 參數：開團表單；有 ?e=<接龍ID>：報名頁
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, set, update, remove, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { loadConfig, DAYS, DAY_KEYS, KINDS } from './sheet.js?v=23';

const LIFF_ID = '2012621364-BTCqnFfK';
// 沿用匹克球計分系統的 Firebase 專案 pickleball-ad66b，資料放在 chains/ 與 pkclub/ 底下
const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_GUESTS = 7;     // 每人最多帶幾位朋友（一面 8 人扣掉自己；要跟資料庫規則一致）
const FRIEND_NAME_MAX = 20;
const FLEX_MAX_ROWS = 40; // Flex 卡片最多列幾個名字，避免超過 LINE 訊息大小限制
const DEFAULT_TIME = '19:00 - 21:00';
const PLANS = ['季繳', '月繳'];
const SEASON_SESSIONS = 12; // 季繳涵蓋指定團別 12 場

// 改版前的接龍（沒有存 courts 欄位）：週日 6 號挑戰場、7 號交流場
const LEGACY_COURTS = [
  { no: '6', kind: '挑戰', name: '進擊挑戰場', level: '3.0+' },
  { no: '7', kind: '交流', name: '進擊交流場', level: '2.5～2.99' },
];
// 舊會員資料（key 是 LINE ID、court 是 6／7）視為週日會員，對應到新場地
const LEGACY_COURT_MAP = { 6: '4', 7: '5' };

const db = getDatabase(initializeApp({ databaseURL: DB_URL }));
const $ = (id) => document.getElementById(id);

let CFG = null;       // 試算表設定 { sessions, ops, names, source }
let profile = null;   // LINE 個人資料
let chainId = null;
let chain = null;     // 目前接龍的即時資料
let roster = {};      // 會員名單 pkclub/members/{會員key}: { name, plan, court, day }
let applications = {}; // 會員申請 pkclub/applications/{會員key}: { name, plan, court, day, ts }
let applyForm = { day: 'sun', plan: '季繳', court: null }; // 申請表單目前的選擇
let createDay = 'sun'; // 開團表單目前的時段
let selCourt = null;  // 報名頁目前查看的場地
let unsubChain = null;
let form = null;      // 報名表內容（自己與朋友各選哪面場）
let formKey = null;   // 上次從資料庫同步表單時，我的報名內容
let notices = {};     // 公告欄 pkclub/notices/{id}: { text, pinned, ts, editedAt, author: { id, name } }
let editingNotice = null; // 團主管理正在編輯的公告 ID（null = 發布新公告）
let noticeExpanded = false;
const NOTICE_MAX = 500;
const NOTICE_PREVIEW = 3; // 公告欄預設顯示幾則，其餘按「顯示全部」展開

// LIFF 的錯誤有時 message 是空的，改顯示錯誤代碼
function errText(err) {
  return err?.message || err?.code || String(err);
}

function setStatus(msg) {
  $('status').textContent = msg;
}

// 建立元素的小工具；文字一律用 textContent，避免名字裡的 HTML 被執行
function el(tag, cls, ...children) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

// action = 'cancel'：從群組圖卡的「取消報名」按鈕開啟，載入後直接詢問是否取消
function chainUrl(id, action) {
  return `https://liff.line.me/${LIFF_ID}?e=${encodeURIComponent(id)}${action ? `&a=${action}` : ''}`;
}

function canSendToChat() {
  const ctx = liff.isInClient() && liff.getContext();
  return !!ctx && ['utou', 'room', 'group'].includes(ctx.type);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // LINE 內建瀏覽器有時不支援 clipboard API，改用舊方法
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- 日期 ----------
// '2026-11-22' → '11/22（日）'
function formatDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${weekday}）`;
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const fmt = (n) => n.toLocaleString('en-US');

// ---------- 試算表設定 ----------
const opsOf = (day) => CFG.ops[day] || CFG.ops.sun;
const sessionsOf = (day) => CFG.sessions.filter((s) => s.day === day);
const formalOf = (day) => sessionsOf(day).filter((s) => !s.trial);
const sessionAt = (iso) => CFG.sessions.find((s) => s.iso === iso) || null;
const courtView = (c) => ({ ...c, icon: KINDS[c.kind]?.icon || '🏓', desc: KINDS[c.kind]?.desc || '' });

// 這個時段的場地：取行事曆裡最後一場的配置（之後的開團最可能沿用）
function defaultCourts(day) {
  const list = sessionsOf(day);
  return (list[list.length - 1] || CFG.sessions[0]).courts;
}

// 日期沒在行事曆上（例如臨時加開）：依星期判斷時段，價格依體驗期／正式期
function sessionFor(iso) {
  const s = sessionAt(iso);
  if (s) return s;
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay() === 5 ? 'fri' : 'sun';
  const firstFormal = formalOf(day)[0];
  const trial = !!firstFormal && iso < firstFormal.iso;
  return { iso, day, trial, title: `${DAYS[day].label}${trial ? '體驗暢打' : '分級包場'}`, price: trial ? opsOf(day).trial : opsOf(day).single, courts: defaultCourts(day) };
}

// ---------- 接龍的時段與場地 ----------
function chainDay(c) {
  return DAYS[c?.day] ? c.day : 'sun';
}

function chainCourts(c) {
  if (!c?.courts) return LEGACY_COURTS.map(courtView);
  return Object.entries(c.courts)
    .map(([no, x]) => courtView({ no, kind: KINDS[x.kind] ? x.kind : '交流', name: x.name, level: x.level }))
    .sort((a, b) => Number(a.no) - Number(b.no));
}

const courtNos = (c) => chainCourts(c).map((x) => x.no);
const courtSize = (c) => opsOf(chainDay(c)).courtSize;

// ---------- 名額計算 ----------
// 會員 key：新格式「LINE ID_sun」「LINE ID_fri」（週五、週日分開），舊格式就是 LINE ID（週日、6／7 號場）
function memberKey(uid, day) {
  return `${uid}_${day}`;
}

function normalizeMember(key, m, fallbackName) {
  if (!m || !PLANS.includes(m.plan) || !/^\d{1,2}$/.test(String(m.court))) return null;
  const legacy = !key.includes('_');
  const day = DAYS[m.day] ? m.day : (key.endsWith('_fri') ? 'fri' : 'sun');
  const rawCourt = String(m.court);
  return {
    lineId: key.split('_')[0],
    name: String(m.name || fallbackName),
    plan: m.plan,
    day,
    rawCourt,
    court: legacy && !m.day ? (LEGACY_COURT_MAP[rawCourt] || rawCourt) : rawCourt,
    ts: m.ts || 0,
  };
}

function cleanList(val, fallbackName) {
  const out = {};
  for (const [key, m] of Object.entries(val || {})) {
    const x = normalizeMember(key, m, fallbackName);
    if (x) out[key] = x;
  }
  return out;
}

// 我在某個時段的會員資料（含 key）；舊格式會員只算週日
function memberOf(uid, day, list = roster) {
  const key = memberKey(uid, day);
  if (list[key]) return { key, ...list[key] };
  if (day === 'sun' && list[uid]?.day === 'sun') return { key: uid, ...list[uid] };
  return null;
}

// 依報名時間排序，逐筆佔名額（本人 + 同行朋友）。
// 一旦有人排不進，之後的人全部進候補，維持先來後到；有人取消時候補自動遞補。
function splitEntries(list, capacity) {
  const sorted = [...list].sort((a, b) => (a.ts - b.ts) || a.uid.localeCompare(b.uid));
  const confirmed = [];
  const waitlist = [];
  let used = 0;
  for (const e of sorted) {
    const need = headsOf(e);
    if (!waitlist.length && used + need <= capacity) {
      confirmed.push(e);
      used += need;
    } else {
      waitlist.push(e);
    }
  }
  return { confirmed, waitlist, used };
}

// 單一場地的會員、名額與名單
function courtData(c, no, members) {
  const day = chainDay(c);
  const size = courtSize(c);
  const court = chainCourts(c).find((x) => x.no === no);
  const list = Object.entries(members)
    .filter(([, m]) => m.day === day && (m.court === no || m.rawCourt === no))
    .map(([key, m]) => ({ uid: key, ...m, leave: !!c.leaves?.[key] }))
    .sort((a, b) => PLANS.indexOf(a.plan) - PLANS.indexOf(b.plan) || a.name.localeCompare(b.name));
  const active = list.filter((m) => !m.leave).length;
  const cap = Math.max(0, size - active);
  const entries = Object.entries(c.entries || {})
    .filter(([, e]) => e.court === no)
    .map(([uid, e]) => ({ uid, ...e }));
  const s = splitEntries(entries, cap);
  return { ...court, size, members: list, active, cap, ...s, total: active + s.used, left: cap - s.used };
}

// 朋友名字（選填）；Firebase 會把陣列存成物件，讀回來統一轉成陣列
function friendList(e) {
  return Object.values(e?.friends || {}).filter(Boolean);
}

// 這筆報名佔幾個名額：self === false 代表報名人自己不打這面場，只幫朋友報
function headsOf(e) {
  return (e.self === false ? 0 : 1) + (e.guests || 0);
}

// DUPR：1.000～8.000，最多三位小數；空白或不合法回傳 null
function parseDupr(v) {
  const t = String(v ?? '').trim();
  const n = Number(t);
  return t && n >= 1 && n <= 8 ? Math.round(n * 1000) / 1000 : null;
}

function friendDuprs(e) {
  return Array.from({ length: e?.guests || 0 }, (_, i) => e.friendDupr?.[i] || null);
}

// 名字後面接 DUPR，例如「小赫 3.25」
const withDupr = (name, d) => (d ? `${name} ${d}` : name);

function personLabel(e) {
  const fd = friendDuprs(e);
  const names = friendList(e).map((n, i) => withDupr(n, fd[i]));
  if (e.self === false) {
    return names.length ? `${names.join('、')}（${e.name} 代報）` : `${e.name} 代報 ${e.guests} 位`;
  }
  const me = withDupr(e.name, e.dupr);
  if (!e.guests) return me;
  return `${me} +${e.guests}${names.length ? `（${names.join('、')}）` : ''}`;
}

// 自己的 DUPR 記在這支手機，下次報名自動帶入
function loadMyDupr() {
  try { return localStorage.getItem('myDupr') || ''; } catch { return ''; }
}

function saveMyDupr(v) {
  try { if (v) localStorage.setItem('myDupr', String(v)); } catch { /* 無痕模式等情況忽略 */ }
}

function memberLine(cd) {
  const on = cd.members.filter((m) => !m.leave).map((m) => m.name);
  const off = cd.members.filter((m) => m.leave).map((m) => m.name);
  return `👑 會員 ${on.length}/${cd.members.length}：${on.join('、') || '—'}${off.length ? `（${off.join('、')} 請假）` : ''}`;
}

function priceOf(c) {
  return typeof c.price === 'number' ? c.price : opsOf(chainDay(c)).single;
}

// ---------- Flex Message ----------
function infoRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#aaaaaa', size: 'sm', flex: 1 },
      { type: 'text', text: value, color: '#666666', size: 'sm', flex: 4, wrap: true },
    ],
  };
}

function kickerOf(c) {
  const day = DAYS[chainDay(c)].label;
  return c.week ? `進擊的匹克團｜${day}第 ${c.week} 場` : `進擊的匹克團｜${day}`;
}

function buildChainFlex(c, id, members) {
  const courts = courtNos(c).map((no) => courtData(c, no, members));
  const rows = [];
  let budget = FLEX_MAX_ROWS;

  const addList = (label, color, list) => {
    rows.push({ type: 'text', text: label, weight: 'bold', size: 'sm', color, margin: 'sm' });
    list.slice(0, budget).forEach((e, i) => {
      rows.push({ type: 'text', text: `${i + 1}. ${personLabel(e)}`, size: 'sm', wrap: true });
    });
    if (list.length > budget) {
      rows.push({ type: 'text', text: `…還有 ${list.length - budget} 位`, size: 'xs', color: '#aaaaaa' });
    }
    budget = Math.max(0, budget - list.length);
  };

  for (const cd of courts) {
    rows.push({ type: 'separator', margin: 'lg' });
    rows.push({ type: 'text', text: `${cd.no}號場｜${cd.name}（${cd.level}）　${cd.total}/${cd.size}`, weight: 'bold', size: 'md', margin: 'lg', wrap: true });
    rows.push({ type: 'text', text: memberLine(cd), size: 'sm', color: '#555555', wrap: true });
    addList(`單次正取 ${cd.used}/${cd.cap}`, '#1DB446', cd.confirmed);
    if (!cd.confirmed.length) rows.push({ type: 'text', text: '（還沒有人報名）', size: 'sm', color: '#aaaaaa' });
    if (cd.waitlist.length) addList(`候補 ${cd.waitlist.length} 組`, '#FF8C00', cd.waitlist);
  }

  const alt = courts.map((cd) => `${cd.no}號 ${cd.total}/${cd.size}`).join('、');
  return {
    type: 'flex',
    altText: `【接龍】${c.title} ${alt}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `🏓 ${kickerOf(c)}`, size: 'xs', color: '#1DB446', weight: 'bold' },
          { type: 'text', text: c.title, weight: 'bold', size: 'xl', wrap: true },
          infoRow('日期', c.date),
          infoRow('時間', c.time),
          infoRow('地點', c.place),
          infoRow('單次', `${priceOf(c)} 元／人`),
          ...(c.note ? [infoRow('備註', c.note)] : []),
          ...rows,
        ],
      },
      // 這張卡是報名者用 LIFF 發的，LINE 規定按鈕只能開網址；要在聊天室一鍵取消，請在群組輸入「取消報名」，
      // LINE 機器人（pickleball-line-bot）會直接取消並回一張帶一鍵取消按鈕的名單卡
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#1DB446',
                flex: 3,
                action: { type: 'uri', label: '我要報名 / 修改', uri: chainUrl(id) },
              },
              {
                type: 'button',
                style: 'secondary',
                flex: 2,
                action: { type: 'uri', label: '取消報名', uri: chainUrl(id, 'cancel') },
              },
            ],
          },
          { type: 'text', text: '💬 也可以在群組輸入「取消報名」或「請假」', size: 'xxs', color: '#aaaaaa', align: 'center' },
        ],
      },
    },
  };
}

// 把最新名單發出去（只發 Flex 卡片）。inChatOnly=true 時只在聊天室內自動發，不跳分享選單
async function postChain(id, { inChatOnly = false } = {}) {
  const [snap, rSnap] = await Promise.all([get(ref(db, `chains/${id}`)), get(ref(db, 'pkclub/members'))]);
  const c = snap.val();
  const members = cleanList(rSnap.val(), '會員');
  const msg = [buildChainFlex(c, id, members)];
  if (canSendToChat()) {
    await liff.sendMessages(msg);
    return 'sent';
  }
  if (inChatOnly) return 'skipped';
  if (!liff.isApiAvailable('shareTargetPicker')) {
    throw new Error('此環境不支援分享，請從 LINE 聊天室開啟');
  }
  const res = await liff.shareTargetPicker(msg);
  return res ? 'shared' : 'cancelled';
}

// ---------- 分頁 ----------
function showView(id) {
  ['chainView', 'createView', 'infoView', 'reviewView'].forEach((v) => { $(v).hidden = v !== id; });
  if (id === 'reviewView') renderReview();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === id));
  setStatus('');
}

// ---------- 開團 ----------
// 選了日期：依試算表帶入時段、活動名稱、地點、價格
function applyCreateDate(iso) {
  $('fDate').value = iso;
  if (!iso) return;
  const s = sessionFor(iso);
  createDay = s.day;
  $('fTitle').value = s.title;
  $('fPrice').value = s.price;
  $('fPlace').value = `鹿角 ${s.courts.map((x) => x.no).join('、')}號場`;
  highlightChip();
  renderCreateCourts();
}

// 日期快選：行事曆上還沒過的場次（最近 16 場），點了直接帶入
function renderDateChips() {
  const today = toISO(new Date());
  const buttons = CFG.sessions.filter((s) => s.iso >= today).slice(0, 16).map((s) => {
    const b = el('button', '', `${formatDate(s.iso)}${s.trial ? ' 體驗' : ''}`);
    b.type = 'button'; // 避免點了就送出表單
    b.dataset.date = s.iso;
    b.addEventListener('click', () => applyCreateDate(s.iso));
    return b;
  });
  $('dateChips').replaceChildren(...buttons);
  $('dateChips').hidden = !buttons.length;
  if (buttons.length && !$('fDate').value) applyCreateDate(buttons[0].dataset.date);
  highlightChip();
}

function highlightChip() {
  document.querySelectorAll('#dateChips button').forEach((b) => {
    b.classList.toggle('on', b.dataset.date === $('fDate').value);
  });
}

// 開團頁的名額表：依會員名單自動算出每面季繳／月繳／單次
function renderCreateCourts() {
  if (!CFG) return;
  const iso = $('fDate').value;
  const s = iso ? sessionFor(iso) : { day: createDay, courts: defaultCourts(createDay) };
  const size = opsOf(s.day).courtSize;
  $('createCourtsLabel').textContent = `場地與名額（${DAYS[s.day].label}・依會員名單帶入）`;
  $('createCourtsHint').textContent = `每面上限 ${size} 人，共 ${size * s.courts.length} 人；會員請假時名額自動釋出給單次接龍`;
  const head = el('div', '', el('span', '', '場地'), el('span', 'c', '季繳'), el('span', 'c', '月繳'), el('span', 'c', '單次'));
  const rows = s.courts.map((c) => {
    const ms = Object.values(roster).filter((m) => m.day === s.day && m.court === c.no);
    const q = ms.filter((m) => m.plan === '季繳').length;
    const mo = ms.filter((m) => m.plan === '月繳').length;
    const single = el('span', 'c ok', String(Math.max(0, size - ms.length)));
    single.style.fontWeight = 'bold';
    return el('div', '',
      el('span', '', el('b', '', `${c.no}號`), ` ${c.name} `, el('span', 'small', c.level)),
      el('span', 'c', String(q)), el('span', 'c', String(mo)), single);
  });
  $('createCourts').replaceChildren(head, ...rows);
}

async function onCreate(ev) {
  ev.preventDefault();
  const btn = $('createBtn');
  btn.disabled = true;
  setStatus('建立中…');
  try {
    const iso = $('fDate').value;
    const s = sessionFor(iso);
    const week = formalOf(s.day).findIndex((x) => x.iso === iso) + 1;
    const newRef = push(ref(db, 'chains'));
    const data = {
      title: $('fTitle').value.trim(),
      date: formatDate(iso),
      time: $('fTime').value.trim(),
      place: $('fPlace').value.trim(),
      price: Number($('fPrice').value),
      day: s.day,
      // 把當天的場地分級存進接龍，之後改試算表也不會影響已開的團
      courts: Object.fromEntries(s.courts.map((c) => [c.no, { kind: c.kind, name: c.name, level: c.level }])),
      createdAt: serverTimestamp(),
      creator: { id: profile.userId, name: profile.displayName.slice(0, 50) },
    };
    if (week) data.week = week; // 正式期的場次才記第幾場
    const note = $('fNote').value.trim();
    if (note) data.note = note; // 備註選填，沒填就不存
    await set(newRef, data);
    // 接龍已存好：不論發送成功與否都切換成報名頁，避免重按造成重複開團
    history.replaceState(null, '', `?e=${newRef.key}`);
    openChain(newRef.key);
    showView('chainView');
    try {
      const result = await postChain(newRef.key);
      setStatus(result === 'cancelled' ? '接龍已建立，可按「分享名單」發到群組' : '接龍已建立並發送 ✅');
    } catch (err) {
      console.error(err);
      setStatus(`接龍已建立，但發送到群組失敗：${errText(err)}（可按「分享名單」重試）`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`建立失敗：${errText(err)}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 報名頁 ----------
function myMember() {
  return chain ? memberOf(profile.userId, chainDay(chain)) : null;
}

// 每人每面場各一筆報名：key 是「LINE ID_場地」；舊資料 key 是 LINE ID，靠 court 欄位區分
function entryKey(no) {
  const uid = profile.userId;
  return chain?.entries?.[uid]?.court === no ? uid : `${uid}_${no}`;
}

function myEntry(no = selCourt) {
  return chain?.entries?.[entryKey(no)] || null;
}

function isMe(e) {
  return e.uid === profile.userId || e.uid.startsWith(`${profile.userId}_`);
}

function renderChain() {
  if (!chain) return;
  const me = myMember();
  const nos = courtNos(chain);
  const size = courtSize(chain);
  if (!nos.includes(selCourt)) selCourt = (me && nos.includes(me.court) ? me.court : null) || nos.find((no) => myEntry(no)) || nos[0];

  const courts = Object.fromEntries(nos.map((no) => [no, courtData(chain, no, roster)]));
  const cd = courts[selCourt];

  // 標題
  $('cKicker').textContent = kickerOf(chain);
  $('cTitle').textContent = chain.title;
  $('cInfo').textContent = `${chain.date}　${chain.time}　${chain.place}`;
  $('cNote').textContent = chain.note || '';
  $('cNote').hidden = !chain.note;

  // 場地卡片
  $('courtCards').replaceChildren(...nos.map((no) => {
    const c = courts[no];
    const left = el('span', 'left',
      c.left > 0 && !c.waitlist.length ? `單次剩 ${c.left} 位` : c.waitlist.length ? `已額滿・候補 ${c.waitlist.length} 組` : '已額滿・可候補');
    left.style.color = c.left > 0 && !c.waitlist.length ? '#1DB446' : '#FF8C00';
    const b = el('button', no === selCourt ? 'on' : '',
      el('span', 't', `${no}號場｜${c.name}`), el('span', 'lv', `建議程度 ${c.level}`), left);
    b.type = 'button';
    b.addEventListener('click', () => { selCourt = no; setStatus(''); renderChain(); });
    return b;
  }));
  $('courtDesc').textContent = `${cd.icon} ${cd.desc}`;

  // 我的狀態
  const onLeave = !!(me && chain.leaves?.[me.key]);
  // 單次報名狀態（兩面場可以各報一筆）
  const singleLines = nos.filter((no) => myEntry(no)).map((no) => {
    const key = entryKey(no);
    const ci = courts[no].confirmed.findIndex((e) => e.uid === key);
    const wi = courts[no].waitlist.findIndex((e) => e.uid === key);
    const who = myEntry(no).self === false ? '你幫朋友報的' : '你';
    return ci >= 0 ? `${who} ${no}號場 單次正取第 ${ci + 1} 組 ✅` : `${who} ${no}號場 候補第 ${wi + 1} 組，有人取消會自動遞補`;
  });
  const lines = [...singleLines];
  if (me) {
    const dayLabel = DAYS[chainDay(chain)].label;
    lines.unshift(onLeave ? `你本次請假，${me.court}號場會員名額已釋出給單次接龍`
      : `你是${dayLabel} ${me.court}號場${me.plan}會員，本次名額已保留 ✅`);
    const o = opsOf(chainDay(chain));
    let info = me.plan === '季繳' ? `季繳 ${fmt(o.seasonPer * SEASON_SESSIONS)} 元／${SEASON_SESSIONS} 場` : `月繳 ${o.monthly} 元／場`;
    const s = chain.week ? formalOf(chainDay(chain))[chain.week - 1] : null;
    if (me.plan === '月繳' && s) {
      const n = formalOf(s.day).filter((x) => x.iso.slice(0, 7) === s.iso.slice(0, 7) && x.iso >= s.iso).length;
      info += `・本月${dayLabel}剩 ${n} 場（含本次）`;
    }
    $('memberInfo').textContent = info;
    $('leaveBtn').textContent = onLeave ? '取消請假，恢復保留名額' : '本次請假（名額釋出給單次）';
    $('leaveBtn').className = onLeave ? '' : 'danger';
  }
  $('myState').textContent = lines.length ? lines.join('\n') : '你還沒報名';
  $('memberBox').hidden = !me;

  // 我的報名在資料庫有變（例如在別支手機改過）才重設表單，避免蓋掉正在填的內容
  const key = JSON.stringify(nos.map((no) => myEntry(no)));
  if (key !== formKey) {
    form = formFromEntries();
    formKey = key;
  }
  renderSignupForm();

  // 名單
  const checkinBtn = (checkinUid) => {
    const checked = !!chain.checkins?.[checkinUid];
    const btn = el('button', `checkin${checked ? ' on' : ''}`, checked ? '✓' : '');
    btn.type = 'button';
    btn.title = checked ? '已簽到，點一下取消' : '點一下簽到';
    btn.addEventListener('click', () => toggleCheckin(checkinUid));
    return btn;
  };
  const attending = cd.members.filter((m) => !m.leave);
  const checkedCount = [...attending, ...cd.confirmed].filter((p) => chain.checkins?.[p.uid]).length;
  $('listTitle').textContent = `${selCourt}號場名單`;
  $('listTotal').textContent = `共 ${cd.total}/${size} 人・已簽到 ${checkedCount}/${attending.length + cd.confirmed.length}`;
  $('memberHead').textContent = cd.members.length ? `會員保留 ${cd.active}/${cd.members.length}` : '會員保留（尚未設定）';
  $('memberRows').replaceChildren(...cd.members.map((m, i) => {
    const mine = m.lineId === profile.userId;
    const badge = el('span', m.plan === '季繳' ? 'badge q' : 'badge', m.plan);
    const row = el('div', `row${mine ? ' me' : ''}${m.leave ? ' off' : ''}`,
      el('span', 'n', `${i + 1}.`), el('span', 'name', mine ? `${m.name}（你）` : m.name), badge);
    if (m.leave) row.append(el('span', 'leaveTag', '請假・名額釋出'));
    else row.append(checkinBtn(m.uid));
    return row;
  }));
  $('confirmedHead').textContent = `單次正取 ${cd.used}/${cd.cap}`;
  $('emptyHint').hidden = cd.confirmed.length > 0;
  const fill = (box, list) => box.replaceChildren(...list.map((e, i) =>
    el('div', `row${isMe(e) ? ' me' : ''}`, el('span', 'n', `${i + 1}.`), el('span', '', personLabel(e)), payTag(e))));
  $('confirmedRows').replaceChildren(...cd.confirmed.map((e, i) =>
    el('div', `row${isMe(e) ? ' me' : ''}`, el('span', 'n', `${i + 1}.`), el('span', '', personLabel(e)), payTag(e), checkinBtn(e.uid))));
  fill($('waitRows'), cd.waitlist);
  $('waitHead').textContent = `候補 ${cd.waitlist.length} 組`;
  $('waitHead').hidden = !cd.waitlist.length;
}

// ---------- 報名表 ----------
// form = { self: { 4: bool, 5: bool }, dupr, pay, friends: [{ name, dupr, court }] }
// 送出時每面場各存成一筆報名：自己有沒有打 + 這面場的朋友
function formFromEntries() {
  const nos = courtNos(chain);
  const mine = nos.map((no) => myEntry(no)).filter(Boolean);
  const f = {
    self: {},
    friends: [],
    pay: mine.map((e) => e.pay).find(Boolean) || 'cash',
    dupr: String(mine.map((e) => e.dupr).find(Boolean) || loadMyDupr() || ''),
  };
  for (const no of nos) {
    const e = myEntry(no);
    f.self[no] = !!e && e.self !== false;
    const names = friendList(e);
    const fd = friendDuprs(e);
    for (let i = 0; i < (e?.guests || 0); i++) {
      f.friends.push({ name: names[i] === '朋友' ? '' : names[i] || '', dupr: fd[i] ? String(fd[i]) : '', court: no });
    }
  }
  return f;
}

// 依表單算出某面場要存的報名；沒人就回傳 null（代表刪除）
function desiredEntry(no) {
  const fr = form.friends.filter((f) => f.court === no);
  if (!form.self[no] && !fr.length) return null;
  const names = fr.map((f) => f.name.trim().slice(0, FRIEND_NAME_MAX));
  const duprs = fr.map((f) => parseDupr(f.dupr));
  const e = { name: profile.displayName.slice(0, 50), guests: fr.length, court: no };
  // 名字或 DUPR 有填才存朋友資料；沒填名字顯示「朋友」
  if (names.some(Boolean) || duprs.some(Boolean)) e.friends = names.map((x) => x || '朋友');
  if (duprs.some(Boolean)) e.friendDupr = Object.fromEntries(duprs.map((d, i) => [i, d]).filter(([, d]) => d));
  if (form.self[no]) {
    const d = parseDupr(form.dupr);
    if (d) e.dupr = d;
  } else {
    e.self = false;
  }
  e.pay = form.pay;
  return e;
}

function sameEntry(a, b) {
  return a.guests === (b.guests || 0) && (a.self !== false) === (b.self !== false) && a.pay === (b.pay || 'cash')
    && (a.dupr || null) === (b.dupr || null)
    && JSON.stringify(friendList(a)) === JSON.stringify(friendList(b))
    && JSON.stringify(friendDuprs(a)) === JSON.stringify(friendDuprs(b));
}

// 預覽：照表單送出後，每面場會在正取還是候補
function previewPlacement() {
  const nos = courtNos(chain);
  const entries = { ...(chain.entries || {}) };
  for (const no of nos) {
    const key = entryKey(no);
    const d = desiredEntry(no);
    const ex = myEntry(no);
    if (!d) delete entries[key];
    else entries[key] = { ...d, ts: ex ? ex.ts : Number.MAX_SAFE_INTEGER }; // 新報名排最後
  }
  const sim = { ...chain, entries };
  return Object.fromEntries(nos.map((no) => {
    const cd = courtData(sim, no, roster);
    return [no, cd.confirmed.some((e) => e.uid === entryKey(no)) ? '正取' : '候補'];
  }));
}

function segButton(text, on, onClick, disabled = false) {
  const b = el('button', on ? 'on' : '', text);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function duprInput(value, onInput) {
  const input = el('input', 'dupr');
  input.inputMode = 'decimal';
  input.maxLength = 6;
  input.placeholder = 'DUPR';
  input.value = value;
  input.addEventListener('input', () => { onInput(input.value); renderSignupSummary(); });
  return input;
}

function renderSignupForm() {
  const me = myMember();
  const nos = courtNos(chain);
  const selfRow = el('div', 'srow', el('span', 'who', `${profile.displayName}（你）`),
    duprInput(form.dupr, (v) => { form.dupr = v; }),
    el('div', 'seg', ...nos.map((no) => (me?.court === no
      ? segButton(`${no}號 會員`, false, () => {}, true)
      : segButton(`${no}號`, form.self[no], () => { form.self[no] = !form.self[no]; renderSignupForm(); })))));

  const friendRows = form.friends.map((f, i) => {
    const input = el('input', 'who');
    input.maxLength = FRIEND_NAME_MAX;
    input.placeholder = `朋友 ${i + 1} 名字`;
    input.value = f.name;
    input.addEventListener('input', () => { f.name = input.value; renderSignupSummary(); });
    const del = el('button', 'del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', '移除這位朋友');
    del.addEventListener('click', () => { form.friends.splice(i, 1); renderSignupForm(); });
    return el('div', 'srow', input, duprInput(f.dupr, (v) => { f.dupr = v; }),
      el('div', 'seg', ...nos.map((no) => segButton(`${no}號`, f.court === no, () => { f.court = no; renderSignupForm(); }))),
      del);
  });
  $('signupRows').replaceChildren(selfRow, ...friendRows);
  $('addFriendBtn').hidden = form.friends.length >= MAX_GUESTS;

  // 付款方式
  $('paySeg').replaceChildren(
    segButton('現金（現場）', form.pay === 'cash', () => { form.pay = 'cash'; renderSignupForm(); }),
    segButton('LINE Pay', form.pay === 'linepay', () => { form.pay = 'linepay'; renderSignupForm(); }));
  renderSignupSummary();
}

// '3.0+' → [3, 8]；'2.5～2.99' → [2.5, 2.99]；'2.0' → [1, 2.49]（初學）
function levelRange(level) {
  const nums = String(level).match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!nums.length) return null;
  if (/\+|以上/.test(level)) return [nums[0], 8];
  if (nums.length >= 2) return [nums[0], nums[1]];
  return [1, nums[0] + 0.49];
}

// DUPR 跟場地建議程度不符時提醒（不擋報名）
function levelHints() {
  const courts = chainCourts(chain);
  const people = [
    ...courts.filter((c) => form.self[c.no]).map((c) => ({ name: '你', dupr: form.dupr, court: c.no })),
    ...form.friends.map((f, i) => ({ name: f.name.trim() || `朋友 ${i + 1}`, dupr: f.dupr, court: f.court })),
  ];
  return people.map((p) => {
    const d = parseDupr(p.dupr);
    const c = courts.find((x) => x.no === p.court);
    const r = c && levelRange(c.level);
    if (!d || !r) return null;
    const fit = courts.find((x) => { const xr = levelRange(x.level); return xr && d >= xr[0] && d <= xr[1]; });
    if (d > r[1]) return `💡 ${p.name} DUPR ${d}，高於 ${c.no}號場建議程度${fit && fit.no !== c.no ? `，建議報 ${fit.no}號場${fit.name}` : ''}`;
    if (d < r[0]) return c.kind === '挑戰' ? `💡 ${p.name} DUPR ${d}，在 ${c.no}號場屬跨級挑戰` : `💡 ${p.name} DUPR ${d}，低於 ${c.no}號場建議程度${fit && fit.no !== c.no ? `，建議報 ${fit.no}號場${fit.name}` : ''}`;
    return null;
  }).filter(Boolean);
}

// 摘要：每面場人數、正取或候補、費用、程度提醒；按鈕與付款區
function renderSignupSummary() {
  const nos = courtNos(chain);
  const place = previewPlacement();
  const price = priceOf(chain);
  let heads = 0;
  const lines = nos.map((no) => {
    const n = (form.self[no] ? 1 : 0) + form.friends.filter((f) => f.court === no).length;
    heads += n;
    return n ? `${no}號場 ${n} 人 → ${place[no]}` : null;
  }).filter(Boolean);
  const how = form.pay === 'linepay' ? 'LINE Pay 付款' : '現場付現金';
  lines.push(heads ? `單次 ${price} 元 × ${heads} 人 = ${price * heads} 元（${how}）` : '請點選自己或朋友要打的場地');
  if ([form.dupr, ...form.friends.map((f) => f.dupr)].some((v) => String(v || '').trim() && !parseDupr(v))) {
    lines.push('⚠️ DUPR 請填 1.000～8.000 之間的數字，或留空');
  }
  lines.push(...levelHints());
  $('signupSummary').textContent = lines.join('\n');

  const hasMine = nos.some((no) => myEntry(no));
  $('joinBtn').textContent = hasMine ? '更新報名' : '送出報名';
  $('joinBtn').disabled = !heads && !hasMine;
  $('cancelBtn').hidden = !hasMine;

  // LINE Pay 付款區：已存成 LINE Pay 的報名，還沒收款的金額
  const lp = nos.map((no) => myEntry(no)).filter((e) => e && e.pay === 'linepay' && !e.paid);
  const due = lp.reduce((sum, e) => sum + headsOf(e) * price, 0);
  const reported = lp.length > 0 && lp.every((e) => e.payReported);
  $('payBox').hidden = !lp.length;
  $('payAmount').textContent = reported ? `已回報 LINE Pay 付款 ${due} 元，等團主確認` : `請用 LINE Pay 付款 ${due} 元`;
  $('payDoneBtn').hidden = reported;
}

// 名單上的付款狀態標籤
function payTag(e) {
  if (e.paid) return el('span', 'payTag paid', '已收 ✅');
  if (e.pay === 'linepay') return e.payReported ? el('span', 'payTag rep', 'LINE Pay 待確認') : el('span', 'payTag lp', 'LINE Pay 未付');
  return el('span', 'payTag cash', '現場付');
}

// 回報已用 LINE Pay 付款（標在每一筆 LINE Pay 的報名上）
async function reportPaid() {
  const changes = {};
  for (const no of courtNos(chain)) {
    const e = myEntry(no);
    if (e && e.pay === 'linepay' && !e.paid) changes[`${entryKey(no)}/payReported`] = true;
  }
  if (!Object.keys(changes).length) return;
  setBusy(true);
  try {
    await update(ref(db, `chains/${chainId}/entries`), changes);
    setStatus('已回報付款，團主確認後會標成「已收 ✅」');
  } catch (err) {
    console.error(err);
    setStatus(`回報失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

function addFriend() {
  if (form.friends.length >= MAX_GUESTS) return;
  form.friends.push({ name: '', court: selCourt });
  renderSignupForm();
  document.querySelector('#signupRows .srow:last-child input')?.focus();
}

function setBusy(on) {
  ['joinBtn', 'cancelBtn', 'addFriendBtn', 'payDoneBtn', 'leaveBtn', 'shareListBtn', 'applyBtn', 'cancelApplyBtn', 'quitMemberBtn'].forEach((id) => { $(id).disabled = on; });
  if (!on) renderChain(); // 還原 joinBtn 的 disabled 狀態
}

// 正取名單的指紋：每面場「未請假的會員 + 單次正取」是誰。只改同行人數、進候補都不會改變它
function confirmedSig(c, members) {
  return courtNos(c).map((no) => {
    const cd = courtData(c, no, members);
    return [...cd.members.filter((m) => !m.leave).map((m) => m.uid), '|', ...cd.confirmed.map((e) => e.uid)].join(',');
  }).join('#');
}

// 異動後只有正取名單有變才自動發到聊天室；before 是異動前的指紋
async function announce(doneMsg, before) {
  try {
    const [snap, rSnap] = await Promise.all([get(ref(db, `chains/${chainId}`)), get(ref(db, 'pkclub/members'))]);
    if (confirmedSig(snap.val(), cleanList(rSnap.val(), '會員')) === before) {
      setStatus(`${doneMsg}（正取名單沒變，未發送到聊天室）`);
      return;
    }
    const r = await postChain(chainId, { inChatOnly: true });
    setStatus(r === 'sent' ? `${doneMsg}，已發送最新名單到聊天室` : doneMsg);
  } catch (err) {
    console.error(err);
    setStatus(`${doneMsg}，但發送名單失敗：${errText(err)}`);
  }
}

// 一次送出兩面場的報名（多路徑更新，兩面場同時成功或同時失敗）
async function writeMyEntries(changes, doneMsg) {
  const before = confirmedSig(chain, roster);
  setBusy(true);
  setStatus('處理中…');
  try {
    await update(ref(db, `chains/${chainId}/entries`), changes);
    formKey = null; // 送出後以資料庫為準重設表單
    await announce(doneMsg, before);
  } catch (err) {
    console.error(err);
    setStatus(`失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function join() {
  if ([form.dupr, ...form.friends.map((f) => f.dupr)].some((v) => String(v || '').trim() && !parseDupr(v))) {
    setStatus('DUPR 請填 1.000～8.000 之間的數字，或留空');
    return;
  }
  saveMyDupr(parseDupr(form.dupr));
  const changes = {};
  const done = [];
  let removing = false;
  for (const no of courtNos(chain)) {
    const d = desiredEntry(no);
    const ex = myEntry(no);
    if (!d && !ex) continue;
    if (d && ex && sameEntry(d, ex)) continue;
    if (!d) {
      removing = true;
      changes[entryKey(no)] = null;
      done.push(`取消 ${no}號場`);
    } else {
      // 已報過的保留原本報名時間（排序不變）；新報名用伺服器時間
      changes[entryKey(no)] = { ...d, ts: ex ? ex.ts : serverTimestamp() };
      // 保留付款狀態；人數變多時，已回報的 LINE Pay 要重新回報差額
      if (ex?.paid) changes[entryKey(no)].paid = true;
      if (ex?.payReported && d.pay === 'linepay' && headsOf(d) <= headsOf(ex)) changes[entryKey(no)].payReported = true;
      done.push(ex ? `更新 ${no}號場` : `報名 ${no}號場`);
    }
  }
  if (!done.length) {
    setStatus('報名內容沒有變動');
    return;
  }
  if (removing && !confirm('有一面場的報名會被取消，取消後重新報名會排到最後。確定送出嗎？')) return;
  await writeMyEntries(changes, `已${done.join('、')}`);
}

async function cancel() {
  if (!confirm('確定要取消你和朋友的全部報名嗎？取消後重新報名會排到最後。')) return;
  const changes = {};
  for (const no of courtNos(chain)) if (myEntry(no)) changes[entryKey(no)] = null;
  await writeMyEntries(changes, '已取消全部報名');
}

// 現場簽到：點名字旁的勾勾，不會發送到群組（避免洗版），只存在 Firebase 給大家即時看到
async function toggleCheckin(checkinUid) {
  const on = !chain.checkins?.[checkinUid];
  try {
    if (on) await set(ref(db, `chains/${chainId}/checkins/${checkinUid}`), true);
    else await remove(ref(db, `chains/${chainId}/checkins/${checkinUid}`));
  } catch (err) {
    console.error(err);
    setStatus(`簽到失敗：${errText(err)}`);
  }
}

// 會員請假：key 是會員 key（週五、週日分開）
async function toggleLeave() {
  const me = myMember();
  if (!me) return;
  const on = !chain.leaves?.[me.key];
  if (on && !confirm('確定本次請假嗎？你的名額會釋出給單次接龍。')) return;
  const leaveRef = ref(db, `chains/${chainId}/leaves/${me.key}`);
  const before = confirmedSig(chain, roster);
  setBusy(true);
  setStatus('處理中…');
  try {
    if (on) await set(leaveRef, true);
    else await remove(leaveRef);
    await announce(on ? '已請假，名額釋出給單次接龍' : '已取消請假', before);
  } catch (err) {
    console.error(err);
    setStatus(`失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function shareList() {
  setBusy(true);
  try {
    const r = await postChain(chainId);
    setStatus({ sent: '已發送 ✅', shared: '已分享 ✅', cancelled: '已取消分享' }[r]);
  } catch (err) {
    console.error(err);
    setStatus(`分享失敗：${errText(err)}`);
    alert(`分享失敗：${errText(err)}`); // 狀態列在頁面最下面容易沒看到，跳窗提醒
  } finally {
    setBusy(false);
  }
}

function openChain(id) {
  if (unsubChain) unsubChain();
  chainId = id;
  chain = null;
  selCourt = null;
  form = null;
  formKey = null;
  document.querySelector('#tabs [data-view="chainView"]').hidden = false;
  setStatus('載入名單中…');

  let first = true;
  unsubChain = onValue(ref(db, `chains/${id}`), (snap) => {
    chain = snap.val();
    if (!chain || !('price' in chain)) {
      chain = null;
      $('chainView').hidden = true;
      setStatus(snap.exists() ? '這是舊版接龍，請重新開團' : '找不到這個接龍，連結可能有誤');
      return;
    }
    renderChain();
    if (first) {
      if ($('status').textContent === '載入名單中…') setStatus('');
      first = false;
      runPendingAction();
    }
  }, (err) => setStatus(`讀取名單失敗：${errText(err)}`));
}

// 從群組圖卡「取消報名」開啟：名單與會員名單都載入後執行一次
// 有單次報名 → 取消全部報名；沒有報名但是會員 → 本次請假
let pendingAction = null;
let rosterLoaded = false;
async function runPendingAction() {
  if (pendingAction !== 'cancel' || !chain || !rosterLoaded) return;
  pendingAction = null;
  history.replaceState(null, '', `?e=${encodeURIComponent(chainId)}`); // 重新整理時不要再跳一次
  const hasEntry = courtNos(chain).some((no) => myEntry(no));
  const me = myMember();
  if (hasEntry) await cancel();
  else if (me && !chain.leaves?.[me.key]) await toggleLeave();
  else setStatus(me ? '你本次已經請假了' : '你目前沒有報名這一場，不需要取消');
}

// ---------- 團資訊（內容依試算表） ----------
const monthOf = (iso) => Number(iso.slice(5, 7));

function courtCard(c) {
  return el('div', 'card',
    el('div', 'h', `${c.icon} ${c.no}號場｜${c.name} `, el('span', 'ok', c.level)),
    el('div', 'd', c.desc));
}

function buildAnnounce() {
  const o = opsOf('sun');
  const nos = [...new Set(CFG.sessions.flatMap((s) => s.courts.map((c) => c.no)))].sort((a, b) => a - b);
  const dayList = DAY_KEYS.filter((d) => sessionsOf(d).length);
  const dayBlocks = dayList.map((d) => [
    `📅 ${DAYS[d].label}場`,
    ...defaultCourts(d).map((c0) => { const c = courtView(c0); return `${c.icon} ${c.no} 號場｜${c.name}　🎯 ${c.level}`; }),
  ].join('\n'));
  return `🔥 進擊的匹克團｜2027 雙時段包場計畫 🔥

🏓 1～2 月包場暢打體驗期
🎉 體驗價只要 ${o.trial} 元／人／次！

📍 地點｜鹿角匹克球場
📅 時間｜每${dayList.map((d) => DAYS[d].label).join('、')} 19:00～21:00
🏟️ 場地｜${nos.map((n) => `${n} 號場`).join('、')}
👥 名額｜每面 ${o.courtSize} 人，每團共 ${o.courtSize * o.courtCount} 人

${dayBlocks.join('\n\n')}

━━━━━━━━━━━━

🏆 3 月起正式推出會員方案（${dayList.map((d) => DAYS[d].label).join('、')}同價、分開報名）

🥇 季繳｜${fmt(o.seasonPer * SEASON_SESSIONS)} 元／${SEASON_SESSIONS} 場
🥈 月繳｜${o.monthly} 元／場（4 場月份 ${fmt(o.monthly * 4)}、5 場月份 ${fmt(o.monthly * 5)}）
🥉 單次｜${o.single} 元／場

👥 每面場地名額配置
▪️ 季繳會員｜${o.seasonSeats / o.courtCount} 人
▪️ 月繳會員｜${o.monthSeats / o.courtCount} 人
▪️ 單次報名｜${o.courtSize - (o.seasonSeats + o.monthSeats) / o.courtCount} 人

🎁 固定會員享優先保留名額及挑戰登記權益。

🔥 進擊的匹克團，一起突破自己的極限！`;
}

function renderInfo() {
  const o = opsOf('sun');
  const dayList = DAY_KEYS.filter((d) => sessionsOf(d).length);
  const nos = [...new Set(CFG.sessions.flatMap((s) => s.courts.map((c) => c.no)))].sort((a, b) => a - b);
  const perCourt = { q: o.seasonSeats / o.courtCount, m: o.monthSeats / o.courtCount };
  perCourt.s = o.courtSize - perCourt.q - perCourt.m;

  $('infoTime').textContent = `每${dayList.map((d) => DAYS[d].label).join('、')} 19:00–21:00（每次 2 小時）`;
  $('infoPlace').textContent = `鹿角｜${nos.map((n) => `${n}號場`).join('、')}`;
  $('infoSeats').textContent = `每面上限 ${o.courtSize} 人，每團 ${o.courtCount} 面共 ${o.courtSize * o.courtCount} 人`;
  $('infoTrial').textContent = `🎉 1～2 月體驗期：單次 ${o.trial} 元／人／次，不分會員，每面場地可容納 ${o.courtSize} 人。`;
  $('planSingle').textContent = String(o.single);
  $('planMonthly').textContent = String(o.monthly);
  $('planMonthlyNote').textContent = `元／場・4場${fmt(o.monthly * 4)}／5場${fmt(o.monthly * 5)}`;
  $('planSeason').textContent = fmt(o.seasonPer * SEASON_SESSIONS);
  $('planSeasonNote').textContent = `元／${SEASON_SESSIONS}場・均${o.seasonPer}`;

  // 場地分級：每個時段一組
  $('courtLevels').replaceChildren(...dayList.flatMap((d) => [
    el('div', 'sec', `${DAYS[d].label}場`),
    ...defaultCourts(d).map((c) => courtCard(courtView(c))),
  ]));

  // 名額配置
  $('seatTable').replaceChildren(
    el('div', '', el('span', '', '類型'), el('span', 'c', '每面'), el('span', 'c', `每團（${o.courtCount}面）`)),
    ...[['季繳', perCourt.q], ['月繳', perCourt.m], ['單次接龍', perCourt.s], ['合計', o.courtSize]].map(([t, n], i, arr) => {
      const row = el('div', '', el('span', '', t), el('span', 'c', String(n)), el('span', 'c', String(n * o.courtCount)));
      if (i === arr.length - 1) row.style.fontWeight = 'bold';
      return row;
    }));

  // 每月場次（月繳金額）：週五、週日分開
  $('monthGrids').replaceChildren(...dayList.flatMap((d) => {
    const formal = formalOf(d);
    const months = [...new Set(formal.map((s) => monthOf(s.iso)))];
    const m = opsOf(d).monthly;
    const cells = months.map((mo) => {
      const n = formal.filter((s) => monthOf(s.iso) === mo).length;
      return el('div', '', el('b', '', `${mo}月`), el('span', 'muted', `${n} 場`), el('span', 'ok', `${fmt(n * m)} 元`));
    });
    const total = el('div', '', el('b', '', '合計'), el('span', 'muted', `${formal.length} 場`));
    total.style.background = '#f3f8f4';
    total.style.border = '0';
    return [el('div', 'sec', `${DAYS[d].label}場`), el('div', 'months', ...cells, total)];
  }));

  // 資料一律從 Google Sheet 讀取；前台不顯示試算表連結，只在讀不到、改用備用資料時提示
  $('sheetSource').hidden = CFG.source === 'sheet';
  $('sheetSource').textContent = CFG.source === 'cache' ? '⚠️ 場次資料暫時讀不到，顯示上次讀到的內容' : '⚠️ 場次資料暫時讀不到，顯示預設內容';
  $('myId').textContent = profile.userId;
}

// ---------- 會員申請 ----------
function applyCourts() {
  return defaultCourts(applyForm.day);
}

// 週五、週日兩個時段都一直顯示；依選到的時段顯示：申請表單／審核中（可取消）／已是會員（可退出）
function renderMembership() {
  const days = DAY_KEYS.filter((d) => DAYS[d]);
  if (!days.includes(applyForm.day)) applyForm.day = days[0];
  const mine = memberOf(profile.userId, applyForm.day);
  const app = mine ? null : memberOf(profile.userId, applyForm.day, applications);
  const label = DAYS[applyForm.day].label;

  $('applyDaySeg').replaceChildren(...days.map((d) => {
    const tag = memberOf(profile.userId, d) ? '・會員' : memberOf(profile.userId, d, applications) ? '・審核中' : '';
    return segButton(`${DAYS[d].label}${tag}`, applyForm.day === d, () => { applyForm.day = d; renderMembership(); });
  }));

  $('memberStatusBox').hidden = !mine && !app;
  $('memberStatusBox').textContent = mine ? `你是${label} ${mine.court}號場${mine.plan}會員 ✅`
    : app ? `你的${label}會員申請審核中：${app.court}號場・${app.plan}` : '';
  $('quitMemberBtn').hidden = !mine;
  $('quitMemberBtn').textContent = `退出${label}會員`;
  $('cancelApplyBtn').hidden = !app;
  $('cancelApplyBtn').textContent = `取消${label}會員申請`;
  $('memberApplyBox').hidden = !!(mine || app);
  if (mine || app) return;

  const courts = applyCourts();
  if (!courts.some((c) => c.no === applyForm.court)) applyForm.court = courts[0]?.no || null;
  $('applyPlanSeg').replaceChildren(...PLANS.map((p) =>
    segButton(p, applyForm.plan === p, () => { applyForm.plan = p; renderMembership(); })));
  $('applyCourtSeg').replaceChildren(...courts.map((c) =>
    segButton(`${c.no}號 ${c.level}`, applyForm.court === c.no, () => { applyForm.court = c.no; renderMembership(); })));
  $('applyBtn').textContent = `送出${label}會員申請`;
}

// 退出會員：從會員名單刪除，之後的團就不再保留名額
async function quitMembership() {
  const m = memberOf(profile.userId, applyForm.day);
  if (!m) return;
  const label = DAYS[m.day].label;
  if (!confirm(`確定要退出${label}會員（${m.court}號場・${m.plan}）嗎？退出後不再保留名額，要重新申請才能恢復。`)) return;
  setBusy(true);
  try {
    await remove(ref(db, `pkclub/members/${m.key}`));
    setStatus(`已退出${label}會員`);
  } catch (err) {
    console.error(err);
    setStatus(`退出失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function applyMembership() {
  if (!applyForm.court) return;
  setBusy(true);
  try {
    await set(ref(db, `pkclub/applications/${memberKey(profile.userId, applyForm.day)}`), {
      name: profile.displayName.slice(0, 50),
      plan: applyForm.plan,
      court: applyForm.court,
      day: applyForm.day,
      ts: serverTimestamp(),
    });
    setStatus(`已送出${DAYS[applyForm.day].label}會員申請，等團主審核 ✅`);
  } catch (err) {
    console.error(err);
    setStatus(`申請失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function cancelApplication() {
  const a = memberOf(profile.userId, applyForm.day, applications);
  if (!a || !confirm(`確定要取消${DAYS[a.day].label}會員申請嗎？`)) return;
  setBusy(true);
  try {
    await remove(ref(db, `pkclub/applications/${a.key}`));
    setStatus('已取消申請');
  } catch (err) {
    console.error(err);
    setStatus(`取消失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

// ---------- 會員審核（團主用） ----------
function renderReview() {
  const list = Object.entries(applications).sort(([, a], [, b]) => (a.ts || 0) - (b.ts || 0));
  $('reviewEmptyHint').hidden = list.length > 0;
  $('reviewRows').replaceChildren(...list.map(([appKey, a]) => {
    const dayLabel = DAYS[a.day].label;
    const o = opsOf(a.day);
    const occupied = Object.values(roster).filter((m) => m.day === a.day && m.court === a.court && m.plan === a.plan).length;
    const suggest = (a.plan === '季繳' ? o.seasonSeats : o.monthSeats) / o.courtCount;
    const approveBtn = el('button', 'on', '核准 ✅');
    approveBtn.type = 'button';
    const rejectBtn = el('button', '', '拒絕');
    rejectBtn.type = 'button';
    rejectBtn.style.color = '#e5484d';
    rejectBtn.style.borderColor = '#e5484d';
    approveBtn.addEventListener('click', () => approveApplication(appKey, a));
    rejectBtn.addEventListener('click', () => rejectApplication(appKey, a));
    return el('div', 'card',
      el('div', 'h', `${a.name}　申請${dayLabel} ${a.court}號場・${a.plan}`),
      el('div', 'd', `目前${dayLabel} ${a.court}號場${a.plan}會員 ${occupied} 人（建議 ${suggest} 人）`),
      el('div', 'seg', approveBtn, rejectBtn));
  }));
  renderRosterAdmin();
}

// 會員名單（團主用）：依時段、場地分組，每位會員可移除
function renderRosterAdmin() {
  const all = Object.entries(roster).map(([key, m]) => ({ key, ...m }));
  $('rosterEmptyHint').hidden = all.length > 0;
  const groups = [];
  for (const day of DAY_KEYS) {
    const courts = [...new Set(all.filter((m) => m.day === day).map((m) => m.court))].sort((a, b) => a - b);
    for (const no of courts) {
      const ms = all.filter((m) => m.day === day && m.court === no)
        .sort((a, b) => PLANS.indexOf(a.plan) - PLANS.indexOf(b.plan) || a.name.localeCompare(b.name));
      const court = defaultCourts(day).find((c) => c.no === no);
      groups.push(el('div', 'sec', `${DAYS[day].label} ${no}號場${court ? `｜${court.name}` : ''}（${ms.length} 人）`));
      groups.push(el('div', 'rows', ...ms.map((m, i) => {
        const del = el('button', 'removeBtn', '移除');
        del.type = 'button';
        del.addEventListener('click', () => removeMember(m));
        return el('div', 'row', el('span', 'n', `${i + 1}.`), el('span', 'name', m.name),
          el('span', m.plan === '季繳' ? 'badge q' : 'badge', m.plan), del);
      })));
    }
  }
  $('rosterRows').replaceChildren(...groups);
}

async function removeMember(m) {
  const label = `${DAYS[m.day].label} ${m.court}號場・${m.plan}`;
  if (!confirm(`確定要把 ${m.name}（${label}）從會員名單移除嗎？\n移除後不再保留名額，要重新申請才能恢復。`)) return;
  setBusy(true);
  try {
    await remove(ref(db, `pkclub/members/${m.key}`));
    setStatus(`已移除會員 ${m.name}（${label}）`);
  } catch (err) {
    console.error(err);
    setStatus(`移除失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function approveApplication(appKey, a) {
  const dayLabel = DAYS[a.day].label;
  if (!confirm(`核准 ${a.name}（${dayLabel} ${a.court}號場・${a.plan}）成為會員嗎？`)) return;
  setBusy(true);
  try {
    await update(ref(db, 'pkclub'), {
      [`members/${memberKey(a.lineId, a.day)}`]: { name: a.name, plan: a.plan, court: a.court, day: a.day },
      [`applications/${appKey}`]: null,
    });
    setStatus(`已核准 ${a.name} 成為${dayLabel}會員`);
  } catch (err) {
    console.error(err);
    setStatus(`核准失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

async function rejectApplication(appKey, a) {
  if (!confirm(`確定要拒絕 ${a.name} 的申請嗎？`)) return;
  setBusy(true);
  try {
    await remove(ref(db, `pkclub/applications/${appKey}`));
    setStatus(`已拒絕 ${a.name} 的申請`);
  } catch (err) {
    console.error(err);
    setStatus(`操作失敗：${errText(err)}`);
  } finally {
    setBusy(false);
  }
}

// ---------- 公告欄 ----------
// 上次打開網站時看過的最新公告時間；比它新（或之後才編輯）的公告標「新」
const noticeSeenAt = (() => {
  try { return Number(localStorage.getItem('noticeSeen')) || 0; } catch { return 0; }
})();

function markNoticesSeen() {
  const latest = Math.max(0, ...Object.values(notices).map((n) => n.editedAt || n.ts || 0));
  try { if (latest) localStorage.setItem('noticeSeen', String(latest)); } catch { /* 忽略 */ }
}

function cleanNotices(val) {
  const out = {};
  for (const [id, n] of Object.entries(val || {})) {
    if (n && typeof n.text === 'string' && n.text.trim()) out[id] = n;
  }
  return out;
}

// 置頂在前，其餘新的在前
function sortedNotices() {
  return Object.entries(notices).map(([id, n]) => ({ id, ...n }))
    .sort((a, b) => (!!b.pinned - !!a.pinned) || (b.ts || 0) - (a.ts || 0));
}

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${formatDate(toISO(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 公告內文：網址變成可點的連結，其餘一律當純文字
function noticeText(text) {
  const box = el('div', 'txt');
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'）]+/g)) {
    box.append(text.slice(last, m.index));
    const a = el('a', '', m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener';
    box.append(a);
    last = m.index + m[0].length;
  }
  box.append(text.slice(last));
  return box;
}

function noticeMeta(n) {
  const who = n.author?.name ? `${n.author.name}・` : '';
  return `${who}${formatTs(n.ts)}${n.editedAt ? `（${formatTs(n.editedAt)} 編輯）` : ''}`;
}

function noticeCard(n) {
  const isNew = (n.editedAt || n.ts || 0) > noticeSeenAt;
  const txt = noticeText(n.text);
  if (n.pinned) txt.prepend('📌 ');
  if (isNew) txt.prepend(el('span', 'newTag', '新'));
  return el('div', 'notice', txt, el('div', 'meta', noticeMeta(n)));
}

function renderNoticeBoard() {
  const list = sortedNotices();
  $('noticeBoard').hidden = list.length === 0;
  const shown = noticeExpanded ? list : list.slice(0, NOTICE_PREVIEW);
  $('noticeRows').replaceChildren(...shown.map(noticeCard));
  $('noticeCount').textContent = list.length > 1 ? `共 ${list.length} 則` : '';
  const more = list.length > NOTICE_PREVIEW;
  $('noticeMoreBtn').hidden = !more;
  $('noticeMoreBtn').textContent = noticeExpanded ? '收合' : `顯示全部 ${list.length} 則 ▾`;
}

// 團主管理：公告列表（編輯／置頂／刪除）
function renderNoticeAdmin() {
  $('noticeAdminRows').replaceChildren(...sortedNotices().map((n) => {
    const btn = (text, onClick, color) => {
      const b = segButton(text, false, onClick);
      if (color) { b.style.color = color; b.style.borderColor = color; }
      return b;
    };
    const card = el('div', 'card',
      noticeText(`${n.pinned ? '📌 ' : ''}${n.text}`),
      el('div', 'd', noticeMeta(n)),
      el('div', 'seg',
        btn('編輯', () => editNotice(n.id)),
        btn(n.pinned ? '取消置頂' : '置頂', () => togglePinNotice(n)),
        btn('刪除', () => deleteNotice(n), '#e5484d')));
    if (n.id === editingNotice) card.style.borderColor = '#06C755';
    return card;
  }));
}

function renderNoticeForm() {
  const editing = !!editingNotice;
  $('noticeFormLabel').textContent = editing ? '編輯公告' : '新公告';
  $('noticeSaveBtn').textContent = editing ? '儲存修改' : '發布公告';
  $('noticeCancelEditBtn').hidden = !editing;
  $('noticeLen').textContent = `${$('noticeText').value.length} / ${NOTICE_MAX}`;
  // 只有在 LINE 裡開才能發到聊天室（聊天室內直接發、其他情況跳分享選單）
  $('noticeSendRow').hidden = !liff.isInClient();
}

function editNotice(id) {
  const n = notices[id];
  if (!n) return;
  editingNotice = id;
  $('noticeText').value = n.text;
  $('noticePinned').checked = !!n.pinned;
  $('noticeSend').checked = false; // 修改錯字通常不用再發一次到群組
  renderNoticeForm();
  renderNoticeAdmin();
  $('noticeText').focus();
}

function resetNoticeForm() {
  editingNotice = null;
  $('noticeText').value = '';
  $('noticePinned').checked = false;
  $('noticeSend').checked = true;
  renderNoticeForm();
  renderNoticeAdmin();
}

async function sendNoticeToChat(text) {
  const msg = [{ type: 'text', text: `📢 進擊的匹克團公告\n\n${text}` }];
  if (canSendToChat()) {
    await liff.sendMessages(msg);
    return 'sent';
  }
  if (!liff.isApiAvailable('shareTargetPicker')) return 'skipped';
  return (await liff.shareTargetPicker(msg)) ? 'sent' : 'cancelled';
}

async function saveNotice() {
  const text = $('noticeText').value.trim();
  if (!text) { setStatus('請先輸入公告內容'); return; }
  const pinned = $('noticePinned').checked;
  const send = !$('noticeSendRow').hidden && $('noticeSend').checked;
  const id = editingNotice;
  if (id && !notices[id]) { setStatus('這則公告已被刪除，改為發布新公告'); editingNotice = null; return; }
  $('noticeSaveBtn').disabled = true;
  try {
    if (id) {
      await update(ref(db, `pkclub/notices/${id}`), { text, pinned, editedAt: serverTimestamp() });
    } else {
      await set(push(ref(db, 'pkclub/notices')), {
        text, pinned, ts: serverTimestamp(),
        author: { id: profile.userId, name: profile.displayName.slice(0, 50) },
      });
    }
    const done = id ? '公告已更新' : '公告已發布';
    resetNoticeForm();
    if (!send) { setStatus(`${done} ✅`); return; }
    try {
      const r = await sendNoticeToChat(text);
      setStatus(r === 'sent' ? `${done}，也已發送到聊天室 ✅` : `${done} ✅（未發送到聊天室）`);
    } catch (err) {
      console.error(err);
      setStatus(`${done}，但發送到聊天室失敗：${errText(err)}`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`公告儲存失敗：${errText(err)}`);
  } finally {
    $('noticeSaveBtn').disabled = false;
  }
}

async function togglePinNotice(n) {
  try {
    await update(ref(db, `pkclub/notices/${n.id}`), { pinned: !n.pinned });
    setStatus(n.pinned ? '已取消置頂' : '已置頂 📌');
  } catch (err) {
    console.error(err);
    setStatus(`操作失敗：${errText(err)}`);
  }
}

async function deleteNotice(n) {
  if (!confirm(`確定要刪除這則公告嗎？\n\n${n.text.slice(0, 60)}${n.text.length > 60 ? '…' : ''}`)) return;
  try {
    await remove(ref(db, `pkclub/notices/${n.id}`));
    if (editingNotice === n.id) resetNoticeForm();
    setStatus('公告已刪除');
  } catch (err) {
    console.error(err);
    setStatus(`刪除失敗：${errText(err)}`);
  }
}

// 不是在 LINE App 裡開（例如被丟到 Chrome / Safari）就無法發到群組，提示改用 LINE 開啟
function showOpenInLine() {
  if (liff.isInClient()) return;
  const e = new URLSearchParams(location.search).get('e');
  const a = el('a', '', '在 LINE 中開啟');
  a.href = `https://line.me/R/app/${LIFF_ID}${e ? `?e=${encodeURIComponent(e)}` : ''}`;
  a.style.cssText = 'display:block;text-align:center;margin-top:8px;padding:10px;border-radius:8px;background:#06C755;color:#fff;text-decoration:none';
  const box = el('div', 'note', '⚠️ 目前不是在 LINE 裡開啟，報名後無法自動發送名單到群組。請在 LINE 群組點連結開啟，或按下方按鈕。', a);
  box.style.margin = '12px 0 0';
  $('tabs').after(box);
}

// ---------- 啟動 ----------
function bindEvents() {
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });
  $('createForm').addEventListener('submit', onCreate);
  $('fDate').addEventListener('change', () => applyCreateDate($('fDate').value));
  $('addFriendBtn').addEventListener('click', addFriend);
  $('payDoneBtn').addEventListener('click', reportPaid);
  $('joinBtn').addEventListener('click', join);
  $('cancelBtn').addEventListener('click', cancel);
  $('leaveBtn').addEventListener('click', toggleLeave);
  $('shareListBtn').addEventListener('click', shareList);
  $('copyAnnounceBtn').addEventListener('click', async () => {
    await copyText(buildAnnounce());
    setStatus('已複製招募公告，可貼到 LINE 群組 ✅');
  });
  $('copyIdBtn').addEventListener('click', async () => {
    await copyText(profile.userId);
    setStatus('已複製你的 ID ✅');
  });
  $('applyBtn').addEventListener('click', applyMembership);
  $('cancelApplyBtn').addEventListener('click', cancelApplication);
  $('quitMemberBtn').addEventListener('click', quitMembership);
  $('noticeSaveBtn').addEventListener('click', saveNotice);
  $('noticeCancelEditBtn').addEventListener('click', resetNoticeForm);
  $('noticeText').addEventListener('input', renderNoticeForm);
  $('noticeMoreBtn').addEventListener('click', () => { noticeExpanded = !noticeExpanded; renderNoticeBoard(); });
}

async function main() {
  // 試算表跟 LIFF 登入同時進行，省等待時間
  const cfgPromise = loadConfig();
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (err) {
    // 外部瀏覽器登入後網址會帶一次性的 code，重新整理或重開分頁時會失效；
    // 把登入參數清掉、只保留 ?e= 重新載入一次
    const params = new URLSearchParams(location.search);
    if (params.has('code') && !sessionStorage.getItem('liffRetried')) {
      sessionStorage.setItem('liffRetried', '1');
      const e = params.get('e') || new URLSearchParams(params.get('liff.state') || '').get('e');
      location.replace(location.pathname + (e ? `?e=${encodeURIComponent(e)}` : ''));
      return;
    }
    setStatus(`LIFF 初始化失敗：${errText(err)}（請從 LINE 聊天室裡開啟連結）`);
    return;
  }
  sessionStorage.removeItem('liffRetried');
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return;
  }
  try {
    profile = await liff.getProfile();
  } catch (err) {
    setStatus('無法取得 LINE 個人資料，請確認 LIFF 有勾選 profile 權限');
    return;
  }
  CFG = await cfgPromise;

  bindEvents();
  showOpenInLine();
  $('fTime').value = DEFAULT_TIME;
  $('fDate').min = toISO(new Date()); // 不能選過去的日期
  renderDateChips();
  renderCreateCourts();
  renderInfo();
  renderMembership();
  renderNoticeForm();
  $('tabs').hidden = false;

  // 公告欄即時同步：團主一發布，所有開著網站的人畫面馬上更新
  onValue(ref(db, 'pkclub/notices'), (snap) => {
    notices = cleanNotices(snap.val());
    if (editingNotice && !notices[editingNotice]) resetNoticeForm(); // 編輯中的公告被別人刪掉
    renderNoticeBoard();
    renderNoticeAdmin();
    markNoticesSeen();
  }, (err) => console.error('讀取公告失敗', err));

  // 會員名單即時同步（團主審核通過，或在 Firebase 後台改名單，頁面會自動更新）
  onValue(ref(db, 'pkclub/members'), (snap) => {
    roster = cleanList(snap.val(), '會員');
    rosterLoaded = true;
    renderCreateCourts();
    renderMembership();
    if (chain) renderChain();
    if (!$('reviewView').hidden) renderReview();
    runPendingAction();
  }, (err) => console.error('讀取會員名單失敗', err));

  // 會員申請即時同步
  onValue(ref(db, 'pkclub/applications'), (snap) => {
    applications = cleanList(snap.val(), '球友');
    renderMembership();
    if (!$('reviewView').hidden) renderReview();
  }, (err) => console.error('讀取會員申請失敗', err));

  // liff.init 完成後網址才會還原成 ?e=xxx
  const params = new URLSearchParams(location.search);
  const id = params.get('e');
  if (id) {
    pendingAction = params.get('a');
    openChain(id);
    showView('chainView');
    setStatus('載入名單中…');
  } else {
    showView('createView');
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`啟動失敗：${errText(err)}（請關閉頁面後重新開啟）`);
});
