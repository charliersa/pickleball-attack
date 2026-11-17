// 進擊的匹克團 接龍報名（LIFF + Firebase Realtime Database）
// 雙場地（7號交流場／6號挑戰場），每面 8 人：會員保留名額 + 單次接龍；會員請假時名額自動釋出
// 1～2 月為體驗期（單次 160 元，無會員方案）；3 月起正式推出會員方案
// 無 ?e= 參數：開團表單；有 ?e=<接龍ID>：報名頁
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, set, update, remove, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const LIFF_ID = '2012621364-BTCqnFfK';
// 沿用匹克球計分系統的 Firebase 專案 pickleball-ad66b，資料放在 chains/ 與 pkclub/ 底下
const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_GUESTS = 7;     // 每人最多帶幾位朋友（一面 8 人扣掉自己；要跟資料庫規則一致）
const FRIEND_NAME_MAX = 20;
const FLEX_MAX_ROWS = 40; // Flex 卡片最多列幾個名字，避免超過 LINE 訊息大小限制
const COURT_SIZE = 8;     // 每面上限人數
const DEFAULT_PRICE = 180;

const COURTS = {
  6: { no: '6', name: '進擊挑戰場', level: '3.0+', desc: '🔥 以 3.0+ 為主的跨級挑戰；2.99 以下可挑戰 3.0，3.0 可挑戰更高等級。' },
  7: { no: '7', name: '進擊交流場', level: '2.5～2.99', desc: '⚔️ 同級雙打交流，以球路穩定及戰術配合為主。' },
};
const COURT_NOS = ['6', '7'];
const PLANS = ['季繳', '月繳'];
const TRIAL_PRICE = 160; // 1～2 月體驗期單次價格

// 正式會員方案：2027 年 3～8 月每週日，共 26 場（1～2 月為體驗期，不計入會員季繳／月繳）
const SEASON = Array.from({ length: 26 }, (_, i) => new Date(2027, 2, 7 + i * 7));
const MONTHS = [[3, 4], [4, 4], [5, 5], [6, 4], [7, 4], [8, 5]];
const ANNOUNCE = `🔥 進擊的匹克團｜2027 雙場包場計畫 🔥

🏓 1～2 月包場暢打體驗期
🎉 體驗價只要 160 元／人／次！

📍 地點｜鹿角匹克球場
📅 時間｜每週日 19:00～21:00
🏟️ 場地｜6 號場、7 號場
👥 名額｜每面 8 人，共 16 人

⚔️ 7 號場｜進擊交流場
🎯 2.5～2.99 同級交流
以雙打交流、技術提升為主！

🔥 6 號場｜進擊挑戰場
🎯 3.0+ 競技交流
開放跨級挑戰！2.99 以下可挑戰 3.0，3.0 也能挑戰更高等級球友！

━━━━━━━━━━━━

🏆 3 月起正式推出會員方案

🥇 季繳｜1,920 元／12 場
🥈 月繳｜170 元／場（依當月場次計算）
🥉 單次｜180 元／場

👥 每面場地名額配置
▪️ 季繳會員｜2 人
▪️ 月繳會員｜2 人
▪️ 單次報名｜4 人

🎁 固定會員享優先保留名額及挑戰登記權益。

🔥 進擊的匹克團，一起突破自己的極限！`;

const db = getDatabase(initializeApp({ databaseURL: DB_URL }));
const $ = (id) => document.getElementById(id);

let profile = null;   // LINE 個人資料
let chainId = null;
let chain = null;     // 目前接龍的即時資料
let roster = {};      // 會員名單 pkclub/members/{LINE userId}: { name, plan, court }
let selCourt = null;  // 報名頁目前查看的場地
let unsubChain = null;
let form = null;      // 報名表內容（自己與朋友各選哪面場）
let formKey = null;   // 上次從資料庫同步表單時，我的報名內容

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

function chainUrl(id) {
  return `https://liff.line.me/${LIFF_ID}?e=${encodeURIComponent(id)}`;
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

// ---------- 名額計算 ----------
function cleanRoster(val) {
  const out = {};
  for (const [uid, m] of Object.entries(val || {})) {
    if (m && COURTS[m.court] && PLANS.includes(m.plan)) out[uid] = { name: String(m.name || '會員'), plan: m.plan, court: String(m.court) };
  }
  return out;
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
  const list = Object.entries(members)
    .filter(([, m]) => m.court === no)
    .map(([uid, m]) => ({ uid, ...m, leave: !!c.leaves?.[uid] }))
    .sort((a, b) => PLANS.indexOf(a.plan) - PLANS.indexOf(b.plan) || a.name.localeCompare(b.name));
  const active = list.filter((m) => !m.leave).length;
  const cap = Math.max(0, COURT_SIZE - active);
  const entries = Object.entries(c.entries || {})
    .filter(([, e]) => e.court === no)
    .map(([uid, e]) => ({ uid, ...e }));
  const s = splitEntries(entries, cap);
  return { ...COURTS[no], members: list, active, cap, ...s, total: active + s.used, left: cap - s.used };
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
  return typeof c.price === 'number' ? c.price : DEFAULT_PRICE;
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

function buildChainFlex(c, id, members) {
  const courts = COURT_NOS.map((no) => courtData(c, no, members));
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
    rows.push({ type: 'text', text: `${cd.no}號場｜${cd.name}　${cd.total}/${COURT_SIZE}`, weight: 'bold', size: 'md', margin: 'lg', wrap: true });
    rows.push({ type: 'text', text: memberLine(cd), size: 'sm', color: '#555555', wrap: true });
    addList(`單次正取 ${cd.used}/${cd.cap}`, '#1DB446', cd.confirmed);
    if (!cd.confirmed.length) rows.push({ type: 'text', text: '（還沒有人報名）', size: 'sm', color: '#aaaaaa' });
    if (cd.waitlist.length) addList(`候補 ${cd.waitlist.length} 組`, '#FF8C00', cd.waitlist);
  }

  const alt = courts.map((cd) => `${cd.no}號 ${cd.total}/${COURT_SIZE}`).join('、');
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
          { type: 'text', text: c.week ? `🏓 進擊的匹克團｜第 ${c.week} 週` : '🏓 進擊的匹克團', size: 'xs', color: '#1DB446', weight: 'bold' },
          { type: 'text', text: c.title, weight: 'bold', size: 'xl', wrap: true },
          infoRow('日期', c.date),
          infoRow('時間', c.time),
          infoRow('地點', c.place),
          infoRow('單次', `${priceOf(c)} 元／人`),
          ...(c.note ? [infoRow('備註', c.note)] : []),
          ...rows,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1DB446',
            action: { type: 'uri', label: '我要報名 / 修改', uri: chainUrl(id) },
          },
        ],
      },
    },
  };
}

// 純文字版名單：可長按複製，通知列也看得到完整內容
function buildChainText(c, id, members) {
  const lines = [
    `🏓【匹克球接龍】${c.title}`,
    `📅 ${c.date}　${c.time}`,
    `📍 ${c.place}`,
  ];
  if (c.note) lines.push(`📝 ${c.note}`);
  for (const no of COURT_NOS) {
    const cd = courtData(c, no, members);
    lines.push('', `🏟 ${cd.no}號場｜${cd.name}（${cd.level}）`, memberLine(cd), `✅ 單次正取 ${cd.used}/${cd.cap}`);
    if (!cd.confirmed.length) lines.push('（還沒有人報名）');
    cd.confirmed.forEach((e, i) => lines.push(`${i + 1}. ${personLabel(e)}`));
    if (cd.waitlist.length) {
      lines.push(`⏳ 候補 ${cd.waitlist.length} 組`);
      cd.waitlist.forEach((e, i) => lines.push(`${i + 1}. ${personLabel(e)}`));
    }
  }
  lines.push('', `👉 報名／修改：${chainUrl(id)}`);
  let text = lines.join('\n');
  // LINE 文字訊息上限 5000 字
  if (text.length > 5000) text = `${text.slice(0, 4900)}\n…\n👉 ${chainUrl(id)}`;
  return { type: 'text', text };
}

// 把最新名單發出去（Flex 卡片 + 文字訊息）。inChatOnly=true 時只在聊天室內自動發，不跳分享選單
async function postChain(id, { inChatOnly = false } = {}) {
  const [snap, rSnap] = await Promise.all([get(ref(db, `chains/${id}`)), get(ref(db, 'pkclub/members'))]);
  const c = snap.val();
  const members = cleanRoster(rSnap.val());
  const msg = [buildChainFlex(c, id, members), buildChainText(c, id, members)];
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
  ['chainView', 'createView', 'infoView'].forEach((v) => { $(v).hidden = v !== id; });
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === id));
  setStatus('');
}

// ---------- 開團 ----------
// '2026-11-22' → '11/22（日）'
function formatDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${weekday}）`;
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SEASON_ISO = SEASON.map(toISO);

// 日期早於正式球季開始（3 月）：視為 1～2 月體驗期，預設單次價格用體驗價
function defaultPriceFor(iso) {
  return SEASON_ISO.length && iso < SEASON_ISO[0] ? TRIAL_PRICE : DEFAULT_PRICE;
}

// 日期快選：本季還沒過的週日，點了直接填入日期欄
function renderDateChips() {
  const today = toISO(new Date());
  const buttons = SEASON_ISO.map((iso, i) => ({ iso, i })).filter(({ iso }) => iso >= today).map(({ iso, i }) => {
    const b = el('button', '', `第${i + 1}週 ${formatDate(iso)}`);
    b.type = 'button'; // 避免點了就送出表單
    b.dataset.date = iso;
    b.addEventListener('click', () => {
      $('fDate').value = iso;
      $('fPrice').value = defaultPriceFor(iso);
      highlightChip();
    });
    return b;
  });
  $('dateChips').replaceChildren(...buttons);
  $('dateChips').hidden = !buttons.length;
  if (buttons.length && !$('fDate').value) {
    $('fDate').value = buttons[0].dataset.date;
    $('fPrice').value = defaultPriceFor(buttons[0].dataset.date);
  }
  highlightChip();
}

function highlightChip() {
  document.querySelectorAll('#dateChips button').forEach((b) => {
    b.classList.toggle('on', b.dataset.date === $('fDate').value);
  });
}

// 開團頁的名額表：依會員名單自動算出每面季繳／月繳／單次
function renderCreateCourts() {
  const head = el('div', '', el('span', '', '場地'), el('span', 'c', '季繳'), el('span', 'c', '月繳'), el('span', 'c', '單次'));
  const rows = COURT_NOS.map((no) => {
    const ms = Object.values(roster).filter((m) => m.court === no);
    const q = ms.filter((m) => m.plan === '季繳').length;
    const mo = ms.filter((m) => m.plan === '月繳').length;
    const single = el('span', 'c ok', String(Math.max(0, COURT_SIZE - ms.length)));
    single.style.fontWeight = 'bold';
    return el('div', '',
      el('span', '', el('b', '', `${no}號`), ` ${COURTS[no].name.slice(2)} `, el('span', 'small', COURTS[no].level)),
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
    const week = SEASON_ISO.indexOf(iso) + 1;
    const newRef = push(ref(db, 'chains'));
    const data = {
      title: $('fTitle').value.trim(),
      date: formatDate(iso),
      time: $('fTime').value.trim(),
      place: $('fPlace').value.trim(),
      price: Number($('fPrice').value),
      createdAt: serverTimestamp(),
      creator: { id: profile.userId, name: profile.displayName.slice(0, 50) },
    };
    if (week) data.week = week; // 本季的週日才記週次
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
  return roster[profile.userId] || null;
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
  const uid = profile.userId;
  const me = myMember();
  if (!selCourt) selCourt = me?.court || COURT_NOS.find((no) => myEntry(no)) || '6';

  const courts = Object.fromEntries(COURT_NOS.map((no) => [no, courtData(chain, no, roster)]));
  const cd = courts[selCourt];

  // 標題
  $('cKicker').textContent = chain.week ? `進擊的匹克團｜第 ${chain.week} 週` : '進擊的匹克團';
  $('cTitle').textContent = chain.title;
  $('cInfo').textContent = `${chain.date}　${chain.time}　${chain.place}`;
  $('cNote').textContent = chain.note || '';
  $('cNote').hidden = !chain.note;

  // 場地卡片
  $('courtCards').replaceChildren(...COURT_NOS.map((no) => {
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
  $('courtDesc').textContent = cd.desc;

  // 我的狀態
  const onLeave = !!chain.leaves?.[uid];
  // 單次報名狀態（兩面場可以各報一筆）
  const singleLines = COURT_NOS.filter((no) => myEntry(no)).map((no) => {
    const key = entryKey(no);
    const ci = courts[no].confirmed.findIndex((e) => e.uid === key);
    const wi = courts[no].waitlist.findIndex((e) => e.uid === key);
    const who = myEntry(no).self === false ? '你幫朋友報的' : '你';
    return ci >= 0 ? `${who} ${no}號場 單次正取第 ${ci + 1} 組 ✅` : `${who} ${no}號場 候補第 ${wi + 1} 組，有人取消會自動遞補`;
  });
  const lines = [...singleLines];
  if (me) {
    lines.unshift(onLeave ? `你本週請假，${me.court}號場會員名額已釋出給單次接龍`
      : `你是 ${me.court}號場${me.plan}會員，本週名額已保留 ✅`);
    let info = me.plan === '季繳' ? '季繳 1,920 元／12 場' : '月繳 170 元／場';
    if (me.plan === '月繳' && chain.week) {
      const d = SEASON[chain.week - 1];
      const n = SEASON.filter((x) => x.getMonth() === d.getMonth() && x >= d).length;
      info += `・本月剩 ${n} 場（含本週）`;
    }
    $('memberInfo').textContent = info;
    $('leaveBtn').textContent = onLeave ? '取消請假，恢復保留名額' : '本週請假（名額釋出給單次）';
    $('leaveBtn').className = onLeave ? '' : 'danger';
  }
  $('myState').textContent = lines.length ? lines.join('\n') : '你還沒報名';
  $('memberBox').hidden = !me;

  // 我的報名在資料庫有變（例如在別支手機改過）才重設表單，避免蓋掉正在填的內容
  const key = JSON.stringify(COURT_NOS.map((no) => myEntry(no)));
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
  $('listTotal').textContent = `共 ${cd.total}/${COURT_SIZE} 人・已簽到 ${checkedCount}/${attending.length + cd.confirmed.length}`;
  $('memberHead').textContent = cd.members.length ? `會員保留 ${cd.active}/${cd.members.length}` : '會員保留（尚未設定）';
  $('memberRows').replaceChildren(...cd.members.map((m, i) => {
    const badge = el('span', m.plan === '季繳' ? 'badge q' : 'badge', m.plan);
    const row = el('div', `row${m.uid === uid ? ' me' : ''}${m.leave ? ' off' : ''}`,
      el('span', 'n', `${i + 1}.`), el('span', 'name', m.uid === uid ? `${m.name}（你）` : m.name), badge);
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
// form = { self: { 6: bool, 7: bool }, dupr, pay, friends: [{ name, dupr, court }] }
// 送出時每面場各存成一筆報名：自己有沒有打 + 這面場的朋友
function formFromEntries() {
  const mine = COURT_NOS.map((no) => myEntry(no)).filter(Boolean);
  const f = {
    self: {},
    friends: [],
    pay: mine.map((e) => e.pay).find(Boolean) || 'cash',
    dupr: String(mine.map((e) => e.dupr).find(Boolean) || loadMyDupr() || ''),
  };
  for (const no of COURT_NOS) {
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
  const entries = { ...(chain.entries || {}) };
  for (const no of COURT_NOS) {
    const key = entryKey(no);
    const d = desiredEntry(no);
    const ex = myEntry(no);
    if (!d) delete entries[key];
    else entries[key] = { ...d, ts: ex ? ex.ts : Number.MAX_SAFE_INTEGER }; // 新報名排最後
  }
  const sim = { ...chain, entries };
  return Object.fromEntries(COURT_NOS.map((no) => {
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
  const selfRow = el('div', 'srow', el('span', 'who', `${profile.displayName}（你）`),
    duprInput(form.dupr, (v) => { form.dupr = v; }),
    el('div', 'seg', ...COURT_NOS.map((no) => (me?.court === no
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
      el('div', 'seg', ...COURT_NOS.map((no) => segButton(`${no}號`, f.court === no, () => { f.court = no; renderSignupForm(); }))),
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

// DUPR 跟場地建議程度不符時提醒（不擋報名）
function levelHints() {
  const people = [
    ...COURT_NOS.filter((no) => form.self[no]).map((no) => ({ name: '你', dupr: form.dupr, court: no })),
    ...form.friends.map((f, i) => ({ name: f.name.trim() || `朋友 ${i + 1}`, dupr: f.dupr, court: f.court })),
  ];
  return people.map((p) => {
    const d = parseDupr(p.dupr);
    if (!d) return null;
    const c = COURTS[p.court];
    const challengeNo = COURT_NOS.find((no) => COURTS[no].name === '進擊挑戰場');
    if (c.name === '進擊交流場' && d >= 3) return `💡 ${p.name} DUPR ${d}，建議報 ${challengeNo}號場挑戰場`;
    if (c.name === '進擊挑戰場' && d < 3) return `💡 ${p.name} DUPR ${d}，在 ${p.court}號場屬跨級挑戰`;
    return null;
  }).filter(Boolean);
}

// 摘要：每面場人數、正取或候補、費用、程度提醒；按鈕與付款區
function renderSignupSummary() {
  const place = previewPlacement();
  const price = priceOf(chain);
  let heads = 0;
  const lines = COURT_NOS.map((no) => {
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

  const hasMine = COURT_NOS.some((no) => myEntry(no));
  $('joinBtn').textContent = hasMine ? '更新報名' : '送出報名';
  $('joinBtn').disabled = !heads && !hasMine;
  $('cancelBtn').hidden = !hasMine;

  // LINE Pay 付款區：已存成 LINE Pay 的報名，還沒收款的金額
  const lp = COURT_NOS.map((no) => myEntry(no)).filter((e) => e && e.pay === 'linepay' && !e.paid);
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
  for (const no of COURT_NOS) {
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
  ['joinBtn', 'cancelBtn', 'addFriendBtn', 'payDoneBtn', 'leaveBtn', 'shareListBtn'].forEach((id) => { $(id).disabled = on; });
  if (!on) renderChain(); // 還原 joinBtn 的 disabled 狀態
}

// 正取名單的指紋：兩面場「未請假的會員 + 單次正取」是誰。只改同行人數、進候補都不會改變它
function confirmedSig(c, members) {
  return COURT_NOS.map((no) => {
    const cd = courtData(c, no, members);
    return [...cd.members.filter((m) => !m.leave).map((m) => m.uid), '|', ...cd.confirmed.map((e) => e.uid)].join(',');
  }).join('#');
}

// 異動後只有正取名單有變才自動發到聊天室；before 是異動前的指紋
async function announce(doneMsg, before) {
  try {
    const [snap, rSnap] = await Promise.all([get(ref(db, `chains/${chainId}`)), get(ref(db, 'pkclub/members'))]);
    if (confirmedSig(snap.val(), cleanRoster(rSnap.val())) === before) {
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
  for (const no of COURT_NOS) {
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
  for (const no of COURT_NOS) if (myEntry(no)) changes[entryKey(no)] = null;
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

async function toggleLeave() {
  const on = !chain.leaves?.[profile.userId];
  if (on && !confirm('確定本週請假嗎？你的名額會釋出給單次接龍。')) return;
  const leaveRef = ref(db, `chains/${chainId}/leaves/${profile.userId}`);
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
    }
  }, (err) => setStatus(`讀取名單失敗：${errText(err)}`));
}

// ---------- 團資訊 ----------
function renderInfo() {
  const cells = MONTHS.map(([m, n]) => el('div', '', el('b', '', `${m}月`), el('span', 'muted', `${n} 場`), el('span', 'ok', `${n * 170} 元`)));
  const total = el('div', '', el('b', '', '合計'), el('span', 'muted', `${MONTHS.reduce((s, [, n]) => s + n, 0)} 場`));
  total.style.background = '#f3f8f4';
  total.style.border = '0';
  $('monthGrid').replaceChildren(...cells, total);
  $('myId').textContent = profile.userId;
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
  $('fDate').addEventListener('change', () => { $('fPrice').value = defaultPriceFor($('fDate').value); highlightChip(); });
  $('addFriendBtn').addEventListener('click', addFriend);
  $('payDoneBtn').addEventListener('click', reportPaid);
  $('joinBtn').addEventListener('click', join);
  $('cancelBtn').addEventListener('click', cancel);
  $('leaveBtn').addEventListener('click', toggleLeave);
  $('shareListBtn').addEventListener('click', shareList);
  $('copyAnnounceBtn').addEventListener('click', async () => {
    await copyText(ANNOUNCE);
    setStatus('已複製招募公告，可貼到 LINE 群組 ✅');
  });
  $('copyIdBtn').addEventListener('click', async () => {
    await copyText(profile.userId);
    setStatus('已複製你的 ID ✅');
  });
}

async function main() {
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

  bindEvents();
  showOpenInLine();
  $('fDate').min = toISO(new Date()); // 不能選過去的日期
  renderDateChips();
  renderCreateCourts();
  renderInfo();
  $('tabs').hidden = false;

  // 會員名單即時同步（團主在 Firebase 後台改名單，頁面會自動更新）
  onValue(ref(db, 'pkclub/members'), (snap) => {
    roster = cleanRoster(snap.val());
    renderCreateCourts();
    if (chain) renderChain();
  }, (err) => console.error('讀取會員名單失敗', err));

  // liff.init 完成後網址才會還原成 ?e=xxx
  const id = new URLSearchParams(location.search).get('e');
  if (id) {
    openChain(id);
    showView('chainView');
    setStatus('載入名單中…');
  } else {
    showView('createView');
  }
}

main();
