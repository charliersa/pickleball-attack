// 匹克球接龍報名（LIFF + Firebase Realtime Database）
// 無 ?e= 參數：開團表單；有 ?e=<接龍ID>：報名頁
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, set, update, remove, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const LIFF_ID = '2012621364-BTCqnFfK';
// 沿用匹克球計分系統的 Firebase 專案 pickleball-ad66b，資料放在 chains/ 底下
const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_GUESTS = 3;     // 每人最多帶幾位朋友（要跟資料庫規則一致）
const FLEX_MAX_ROWS = 40; // Flex 卡片最多列幾個名字，避免超過 LINE 訊息大小限制

const db = getDatabase(initializeApp({ databaseURL: DB_URL }));
const $ = (id) => document.getElementById(id);

let profile = null; // LINE 個人資料
let chainId = null;
let chain = null;   // 目前接龍的即時資料

function setStatus(msg) {
  $('status').textContent = msg;
}

function chainUrl(id) {
  return `https://liff.line.me/${LIFF_ID}?e=${encodeURIComponent(id)}`;
}

function canSendToChat() {
  const ctx = liff.isInClient() && liff.getContext();
  return !!ctx && ['utou', 'room', 'group'].includes(ctx.type);
}

// ---------- 名額計算 ----------
// 依報名時間排序，逐筆佔名額（本人 + 同行朋友）。
// 一旦有人排不進，之後的人全部進候補，維持先來後到；有人取消時候補自動遞補。
function splitEntries(c) {
  const list = Object.entries(c.entries || {})
    .map(([uid, e]) => ({ uid, ...e }))
    .sort((a, b) => (a.ts - b.ts) || a.uid.localeCompare(b.uid));
  const confirmed = [];
  const waitlist = [];
  let used = 0;
  for (const e of list) {
    const need = 1 + (e.guests || 0);
    if (!waitlist.length && used + need <= c.capacity) {
      confirmed.push(e);
      used += need;
    } else {
      waitlist.push(e);
    }
  }
  return { confirmed, waitlist, used };
}

function personLabel(e) {
  return e.guests ? `${e.name} +${e.guests}` : e.name;
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

function buildChainFlex(c, id) {
  const { confirmed, waitlist, used } = splitEntries(c);
  const rows = [];
  let budget = FLEX_MAX_ROWS;

  const addSection = (label, color, list) => {
    rows.push({ type: 'text', text: label, weight: 'bold', size: 'sm', color, margin: 'lg' });
    list.slice(0, budget).forEach((e, i) => {
      rows.push({ type: 'text', text: `${i + 1}. ${personLabel(e)}`, size: 'sm', wrap: true });
    });
    if (list.length > budget) {
      rows.push({ type: 'text', text: `…還有 ${list.length - budget} 位`, size: 'xs', color: '#aaaaaa' });
    }
    budget = Math.max(0, budget - list.length);
  };

  if (!confirmed.length && !waitlist.length) {
    rows.push({ type: 'text', text: '還沒有人報名，快來搶頭香！', size: 'sm', color: '#aaaaaa', margin: 'lg' });
  } else {
    addSection(`正取 ${used}/${c.capacity}`, '#1DB446', confirmed);
    if (waitlist.length) addSection(`候補 ${waitlist.length} 組`, '#FF8C00', waitlist);
  }

  return {
    type: 'flex',
    altText: `【接龍】${c.title} 正取 ${used}/${c.capacity}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '🏓 匹克球接龍', size: 'xs', color: '#1DB446', weight: 'bold' },
          { type: 'text', text: c.title, weight: 'bold', size: 'xl', wrap: true },
          infoRow('日期', c.date),
          infoRow('時間', c.time),
          infoRow('地點', c.place),
          ...(c.note ? [infoRow('備註', c.note)] : []),
          { type: 'separator', margin: 'lg' },
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
function buildChainText(c, id) {
  const { confirmed, waitlist, used } = splitEntries(c);
  const lines = [
    `🏓【匹克球接龍】${c.title}`,
    `📅 ${c.date}　${c.time}`,
    `📍 ${c.place}`,
  ];
  if (c.note) lines.push(`📝 ${c.note}`);
  lines.push('', `✅ 正取 ${used}/${c.capacity}`);
  if (!confirmed.length) lines.push('（還沒有人報名）');
  confirmed.forEach((e, i) => lines.push(`${i + 1}. ${personLabel(e)}`));
  if (waitlist.length) {
    lines.push('', `⏳ 候補 ${waitlist.length} 組`);
    waitlist.forEach((e, i) => lines.push(`${i + 1}. ${personLabel(e)}`));
  }
  lines.push('', `👉 報名／修改：${chainUrl(id)}`);
  let text = lines.join('\n');
  // LINE 文字訊息上限 5000 字
  if (text.length > 5000) text = `${text.slice(0, 4900)}\n…\n👉 ${chainUrl(id)}`;
  return { type: 'text', text };
}

// 把最新名單發出去（Flex 卡片 + 文字訊息）。inChatOnly=true 時只在聊天室內自動發，不跳分享選單
async function postChain(id, { inChatOnly = false } = {}) {
  const snap = await get(ref(db, `chains/${id}`));
  const c = snap.val();
  const msg = [buildChainFlex(c, id), buildChainText(c, id)];
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

// ---------- 開團 ----------
// 日期選擇器的值 '2026-11-22' → '11/22（日）'
function formatDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${weekday}）`;
}

function todayISO() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function showCreate() {
  $('createView').hidden = false;
  setStatus('');
  $('fDate').min = todayISO(); // 不能選過去的日期
  $('createForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('createBtn');
    btn.disabled = true;
    setStatus('建立中…');
    try {
      const newRef = push(ref(db, 'chains'));
      const data = {
        title: $('fTitle').value.trim(),
        date: formatDate($('fDate').value),
        time: $('fTime').value.trim(),
        place: $('fPlace').value.trim(),
        capacity: Number($('fCapacity').value),
        createdAt: serverTimestamp(),
        creator: { id: profile.userId, name: profile.displayName.slice(0, 50) },
      };
      const note = $('fNote').value.trim();
      if (note) data.note = note; // 備註選填，沒填就不存
      await set(newRef, data);
      const result = await postChain(newRef.key);
      // 切換成報名頁，讓團主也能直接報名
      history.replaceState(null, '', `?e=${newRef.key}`);
      $('createView').hidden = true;
      chainId = newRef.key;
      showChain();
      setStatus(result === 'cancelled' ? '接龍已建立，可按「分享名單」發到群組' : '接龍已建立並發送 ✅');
    } catch (err) {
      console.error(err);
      setStatus(`建立失敗：${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- 報名頁 ----------
let lastMyGuests = null;

function renderChain() {
  const { confirmed, waitlist, used } = splitEntries(chain);
  $('cTitle').textContent = chain.title;
  $('cInfo').textContent = `${chain.date}　${chain.time}　${chain.place}`;
  $('cNote').textContent = chain.note || '';
  $('cNote').hidden = !chain.note;
  $('cConfirmedHead').textContent = `正取 ${used}/${chain.capacity}`;
  $('cWaitHead').textContent = `候補 ${waitlist.length} 組`;
  $('cWaitHead').hidden = !waitlist.length;

  const fill = (ol, list) => {
    ol.replaceChildren(...list.map((e) => {
      const li = document.createElement('li');
      li.textContent = personLabel(e); // textContent 避免名字裡的 HTML 被執行
      if (e.uid === profile.userId) li.className = 'me';
      return li;
    }));
  };
  fill($('cConfirmed'), confirmed);
  fill($('cWait'), waitlist);

  const mine = chain.entries?.[profile.userId];
  const ci = confirmed.findIndex((e) => e.uid === profile.userId);
  const wi = waitlist.findIndex((e) => e.uid === profile.userId);
  $('myState').textContent = ci >= 0 ? `你是正取第 ${ci + 1} 位 ✅`
    : wi >= 0 ? `你在候補第 ${wi + 1} 位，有人取消會自動遞補`
      : '你還沒報名';
  $('joinBtn').textContent = mine ? '更新同行人數' : '我要報名';
  $('cancelBtn').hidden = !mine;

  // 自己的同行人數有變（例如在別支手機改過）才同步下拉選單，避免蓋掉正在選的值
  const g = mine ? mine.guests : 0;
  if (g !== lastMyGuests) {
    $('guests').value = String(g);
    lastMyGuests = g;
  }
}

function setBusy(on) {
  ['joinBtn', 'cancelBtn', 'shareListBtn'].forEach((id) => { $(id).disabled = on; });
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
  const guests = Number($('guests').value);
  const mine = chain.entries?.[profile.userId];
  const entryRef = ref(db, `chains/${chainId}/entries/${profile.userId}`);
  setBusy(true);
  setStatus('處理中…');
  try {
    if (mine) {
      if (mine.guests === guests) {
        setStatus('人數沒有變動');
        return;
      }
      // 只改人數，保留原本的報名時間（排序不變）
      await update(entryRef, { guests });
    } else {
      await set(entryRef, {
        name: profile.displayName.slice(0, 50),
        guests,
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
    await announce('已取消報名');
  } catch (err) {
    console.error(err);
    setStatus(`取消失敗：${err.message}`);
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

function showChain() {
  $('chainView').hidden = false;
  setStatus('載入名單中…');
  $('guests').replaceChildren(...Array.from({ length: MAX_GUESTS + 1 }, (_, n) => {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = n ? `帶 ${n} 位朋友` : '只有我自己';
    return o;
  }));
  $('joinBtn').addEventListener('click', join);
  $('cancelBtn').addEventListener('click', cancel);
  $('shareListBtn').addEventListener('click', shareList);

  let first = true;
  onValue(ref(db, `chains/${chainId}`), (snap) => {
    chain = snap.val();
    if (!chain) {
      $('chainView').hidden = true;
      setStatus('找不到這個接龍，連結可能有誤');
      return;
    }
    renderChain();
    if (first) { setStatus(''); first = false; }
  }, (err) => setStatus(`讀取名單失敗：${err.message}`));
}

// ---------- 啟動 ----------
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
  // liff.init 完成後網址才會還原成 ?e=xxx
  chainId = new URLSearchParams(location.search).get('e');
  if (chainId) showChain();
  else showCreate();
}

main();
