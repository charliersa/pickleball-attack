// 進擊的匹克團 接龍報名（LIFF + Firebase Realtime Database）
// 雙場地（6號交流場／7號挑戰場），每面 8 人：會員保留名額 + 單次接龍；會員請假時名額自動釋出
// 無 ?e= 參數：開團表單；有 ?e=<接龍ID>：報名頁
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, set, update, remove, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const LIFF_ID = '2012621364-BTCqnFfK';
// 沿用匹克球計分系統的 Firebase 專案 pickleball-ad66b，資料放在 chains/ 與 pkclub/ 底下
const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_GUESTS = 3;     // 每人最多帶幾位朋友（要跟資料庫規則一致）
const FLEX_MAX_ROWS = 40; // Flex 卡片最多列幾個名字，避免超過 LINE 訊息大小限制
const COURT_SIZE = 8;     // 每面上限人數
const DEFAULT_PRICE = 180;

const COURTS = {
  6: { no: '6', name: '進擊交流場', level: '2.5～2.99', desc: '⚔️ 同級雙打交流，以球路穩定及戰術配合為主。' },
  7: { no: '7', name: '進擊挑戰場', level: '3.0+', desc: '🔥 以 3.0+ 為主的跨級挑戰；2.99 以下可挑戰 3.0，3.0 可挑戰更高等級。' },
};
const COURT_NOS = ['6', '7'];
const PLANS = ['季繳', '月繳'];

// 2027 年 2～8 月每週日，共 30 場
const SEASON = Array.from({ length: 30 }, (_, i) => new Date(2027, 1, 7 + i * 7));
const MONTHS = [[2, 4], [3, 4], [4, 4], [5, 5], [6, 4], [7, 4], [8, 5]];
const ANNOUNCE = `🔥 進擊的匹克團｜雙場分級包場計畫
🏓 兩個場地、兩種玩法！同級交流 × 跨級挑戰，一起突破自己的等級。
📅 2～8月｜每週日固定開團
⏰ 19:00–21:00（每次 2 小時）
📍 鹿角｜6號場、7號場
⚔️ 建議程度 2.5～2.99：以同級雙打交流、球路穩定及戰術配合為主。
🔥 以 3.0+ 球友為主，安排跨級挑戰；2.99 以下可挑戰 3.0，3.0 也可挑戰更高等級（視當日球友程度與輪替安排）。
👥 每面上限 8 人，兩面共 16 人。
📋 每面季繳2人、月繳2人、單次4人。
💰 180 元／場
💰 170 元／場；4 場月份 680 元，5 場月份 850 元。
💰 1,920 元／12 場，平均 160 元／場；採固定 12 場次制。
🎁 優先保留名額、優先登記跨級挑戰、累積團內進擊積分。
📌 季繳按 12 場計，不等於任意連續三個月份；請假、補位及取消辦法將另行公告。
🏆 勇於挑戰，突破極限！進擊的匹克團，等你一起進擊！`;

const db = getDatabase(initializeApp({ databaseURL: DB_URL }));
const $ = (id) => document.getElementById(id);

let profile = null;   // LINE 個人資料
let chainId = null;
let chain = null;     // 目前接龍的即時資料
let roster = {};      // 會員名單 pkclub/members/{LINE userId}: { name, plan, court }
let selCourt = null;  // 報名頁目前查看的場地
let unsubChain = null;
let lastMyGuests = null;

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
    const need = 1 + (e.guests || 0);
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

function personLabel(e) {
  return e.guests ? `${e.name} +${e.guests}` : e.name;
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

// 日期快選：本季還沒過的週日，點了直接填入日期欄
function renderDateChips() {
  const today = toISO(new Date());
  const buttons = SEASON_ISO.map((iso, i) => ({ iso, i })).filter(({ iso }) => iso >= today).map(({ iso, i }) => {
    const b = el('button', '', `第${i + 1}週 ${formatDate(iso)}`);
    b.type = 'button'; // 避免點了就送出表單
    b.dataset.date = iso;
    b.addEventListener('click', () => {
      $('fDate').value = iso;
      highlightChip();
    });
    return b;
  });
  $('dateChips').replaceChildren(...buttons);
  $('dateChips').hidden = !buttons.length;
  if (buttons.length && !$('fDate').value) $('fDate').value = buttons[0].dataset.date;
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
      setStatus(`接龍已建立，但發送到群組失敗：${err.message}（可按「分享名單」重試）`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`建立失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 報名頁 ----------
function myMember() {
  return roster[profile.userId] || null;
}

function myEntry() {
  return chain?.entries?.[profile.userId] || null;
}

function renderChain() {
  if (!chain) return;
  const uid = profile.userId;
  const me = myMember();
  const mine = myEntry();
  if (!selCourt) selCourt = me?.court || mine?.court || '6';

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
  if (me) {
    $('myState').textContent = selCourt !== me.court ? `你的保留名額在 ${me.court}號場，可切換查看`
      : onLeave ? '你本週請假，名額已釋出給單次接龍'
        : `你是 ${me.court}號場${me.plan}會員，本週名額已保留 ✅`;
    let info = me.plan === '季繳' ? '季繳 1,920 元／12 場' : '月繳 170 元／場';
    if (me.plan === '月繳' && chain.week) {
      const d = SEASON[chain.week - 1];
      const n = SEASON.filter((x) => x.getMonth() === d.getMonth() && x >= d).length;
      info += `・本月剩 ${n} 場（含本週）`;
    }
    $('memberInfo').textContent = info;
    $('leaveBtn').textContent = onLeave ? '取消請假，恢復保留名額' : '本週請假（名額釋出給單次）';
    $('leaveBtn').className = onLeave ? '' : 'danger';
  } else {
    const mc = mine ? courts[mine.court] : null;
    const ci = mc ? mc.confirmed.findIndex((e) => e.uid === uid) : -1;
    const wi = mc ? mc.waitlist.findIndex((e) => e.uid === uid) : -1;
    $('myState').textContent = ci >= 0 ? `你是 ${mine.court}號場 單次正取第 ${ci + 1} 位 ✅`
      : wi >= 0 ? `你在 ${mine.court}號場 候補第 ${wi + 1} 位，有人取消會自動遞補`
        : '你還沒報名';
  }
  $('memberBox').hidden = !me;
  $('singleBox').hidden = !!me;

  // 自己的同行人數有變（例如在別支手機改過）才同步下拉選單，避免蓋掉正在選的值
  const g = mine ? mine.guests : 0;
  if (g !== lastMyGuests) {
    $('guests').value = String(g);
    lastMyGuests = g;
  }
  updateSingleUI(cd);

  // 名單
  $('listTitle').textContent = `${selCourt}號場名單`;
  $('listTotal').textContent = `共 ${cd.total}/${COURT_SIZE} 人`;
  $('memberHead').textContent = cd.members.length ? `會員保留 ${cd.active}/${cd.members.length}` : '會員保留（尚未設定）';
  $('memberRows').replaceChildren(...cd.members.map((m, i) => {
    const badge = el('span', m.plan === '季繳' ? 'badge q' : 'badge', m.plan);
    const row = el('div', `row${m.uid === uid ? ' me' : ''}${m.leave ? ' off' : ''}`,
      el('span', 'n', `${i + 1}.`), el('span', 'name', m.uid === uid ? `${m.name}（你）` : m.name), badge);
    if (m.leave) row.append(el('span', 'leaveTag', '請假・名額釋出'));
    return row;
  }));
  $('confirmedHead').textContent = `單次正取 ${cd.used}/${cd.cap}`;
  $('emptyHint').hidden = cd.confirmed.length > 0;
  const fill = (box, list) => box.replaceChildren(...list.map((e, i) =>
    el('div', `row${e.uid === uid ? ' me' : ''}`, el('span', 'n', `${i + 1}.`), el('span', '', personLabel(e)))));
  fill($('confirmedRows'), cd.confirmed);
  fill($('waitRows'), cd.waitlist);
  $('waitHead').textContent = `候補 ${cd.waitlist.length} 組`;
  $('waitHead').hidden = !cd.waitlist.length;
}

// 單次報名區：費用與按鈕文字跟著同行人數、場地變動
function updateSingleUI(cd = courtData(chain, selCourt, roster)) {
  const mine = myEntry();
  const heads = 1 + Number($('guests').value);
  const price = priceOf(chain);
  $('feeLine').replaceChildren(`單次 ${price} 元 × ${heads} 人 = `, el('b', '', `${price * heads} 元`), '（現場收費）');
  const otherCourt = !!mine && mine.court !== selCourt;
  $('joinBtn').textContent = otherCourt ? `你已報名 ${mine.court}號場`
    : mine ? '更新同行人數'
      : !cd.waitlist.length && cd.left >= heads ? `報名 ${selCourt}號場` : `報名 ${selCourt}號場（進候補）`;
  $('joinBtn').disabled = otherCourt;
  $('cancelBtn').hidden = !mine || otherCourt;
}

function setBusy(on) {
  ['joinBtn', 'cancelBtn', 'leaveBtn', 'shareListBtn'].forEach((id) => { $(id).disabled = on; });
  if (!on) renderChain(); // 還原 joinBtn 的 disabled 狀態
}

async function announce(doneMsg) {
  try {
    const r = await postChain(chainId, { inChatOnly: true });
    setStatus(r === 'sent' ? `${doneMsg}，已發送最新名單到聊天室` : doneMsg);
  } catch (err) {
    console.error(err);
    setStatus(`${doneMsg}，但發送名單失敗：${err.message}`);
  }
}

async function join() {
  const no = selCourt;
  const guests = Number($('guests').value);
  const mine = myEntry();
  if (mine && mine.court !== no) {
    setStatus(`你已報名 ${mine.court}號場，請先取消再改報`);
    return;
  }
  if (mine && mine.guests === guests) {
    setStatus('人數沒有變動');
    return;
  }
  const entryRef = ref(db, `chains/${chainId}/entries/${profile.userId}`);
  setBusy(true);
  setStatus('處理中…');
  try {
    if (mine) {
      // 只改人數，保留原本的報名時間（排序不變）
      await update(entryRef, { guests });
    } else {
      await set(entryRef, {
        name: profile.displayName.slice(0, 50),
        guests,
        court: no,
        ts: serverTimestamp(),
      });
    }
    await announce(mine ? '已更新人數' : '報名成功');
  } catch (err) {
    console.error(err);
    setStatus(`失敗：${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function cancel() {
  if (!confirm('確定要取消報名嗎？取消後重新報名會排到最後。')) return;
  setBusy(true);
  setStatus('處理中…');
  try {
    await remove(ref(db, `chains/${chainId}/entries/${profile.userId}`));
    $('guests').value = '0';
    await announce('已取消報名');
  } catch (err) {
    console.error(err);
    setStatus(`取消失敗：${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function toggleLeave() {
  const on = !chain.leaves?.[profile.userId];
  if (on && !confirm('確定本週請假嗎？你的名額會釋出給單次接龍。')) return;
  const leaveRef = ref(db, `chains/${chainId}/leaves/${profile.userId}`);
  setBusy(true);
  setStatus('處理中…');
  try {
    if (on) await set(leaveRef, true);
    else await remove(leaveRef);
    await announce(on ? '已請假，名額釋出給單次接龍' : '已取消請假');
  } catch (err) {
    console.error(err);
    setStatus(`失敗：${err.message}`);
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
    setStatus(`分享失敗：${err.message}`);
  } finally {
    setBusy(false);
  }
}

function openChain(id) {
  if (unsubChain) unsubChain();
  chainId = id;
  chain = null;
  selCourt = null;
  lastMyGuests = null;
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
  }, (err) => setStatus(`讀取名單失敗：${err.message}`));
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

// ---------- 啟動 ----------
function bindEvents() {
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });
  $('createForm').addEventListener('submit', onCreate);
  $('fDate').addEventListener('change', highlightChip);
  $('guests').replaceChildren(...Array.from({ length: MAX_GUESTS + 1 }, (_, n) => {
    const o = el('option', '', n ? `帶 ${n} 位朋友` : '只有我自己');
    o.value = String(n);
    return o;
  }));
  $('guests').addEventListener('change', () => updateSingleUI());
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
    setStatus(`LIFF 初始化失敗：${err.message}`);
    return;
  }
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
