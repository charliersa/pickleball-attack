/**
 * 進擊的匹克團｜把 Firebase 的報名資料同步到這份 Google 試算表
 *
 * - 只「讀」Firebase、不寫入，網站報名完全不受影響
 * - 寫入三個系統分頁（每次同步整頁覆蓋，請勿手動修改）：
 *     系統_會員名單、系統_報名明細、系統_每場統計
 * - 原本的分頁（營運總覽、2027場次行事曆…）不會被動到
 * - 試算表選單「進擊的匹克團」：立即同步／開啟自動同步（每 10 分鐘）／停止自動同步
 *
 * 讀取權限：先試目前 Google 帳號的 Firebase 權限，被拒絕就改用公開讀取（資料庫規則 chains 需有 ".read": true）。
 */

const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const PLANS = ['季繳', '月繳'];
const DAY_LABEL = { sun: '週日', fri: '週五' };
// 改版前的接龍（沒有 courts 欄位）：週日 6 號挑戰場、7 號交流場；舊會員 6→4、7→5
const LEGACY_COURTS = { 6: { name: '進擊挑戰場', level: '3.0+' }, 7: { name: '進擊交流場', level: '2.5～2.99' } };
const LEGACY_COURT_MAP = { 6: '4', 7: '5' };
const DEFAULT_COURT_SIZE = 8;
const SHEETS = { members: '系統_會員名單', entries: '系統_報名明細', stats: '系統_每場統計' };

// ---------- 選單 ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('進擊的匹克團')
    .addItem('立即同步報名資料', 'syncAll')
    .addSeparator()
    .addItem('開啟自動同步（每 10 分鐘）', 'installTrigger')
    .addItem('停止自動同步', 'removeTrigger')
    .addToUi();
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
  syncAll();
  toast('已開啟自動同步，每 10 分鐘更新一次');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'syncAll')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

function toast(msg) {
  try { SpreadsheetApp.getActive().toast(msg, '進擊的匹克團', 5); } catch (e) { /* 定時觸發時沒有畫面 */ }
}

// ---------- 讀 Firebase ----------
// 依序嘗試：指令碼屬性 FIREBASE_SECRET → 目前 Google 帳號的權限 → 公開讀取（資料庫規則有開放 .read 的節點）
let oauthFailed = false;
function fetchDb(path) {
  const secret = PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET');
  const tries = [];
  if (secret) tries.push({ url: `${DB_URL}/${path}.json?auth=${encodeURIComponent(secret)}`, opt: {} });
  if (!oauthFailed) tries.push({ url: `${DB_URL}/${path}.json`, opt: { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` } }, oauth: true });
  tries.push({ url: `${DB_URL}/${path}.json`, opt: {} });
  let last = null;
  for (const t of tries) {
    const res = UrlFetchApp.fetch(t.url, Object.assign({ muteHttpExceptions: true }, t.opt));
    if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()) || {};
    if (t.oauth) oauthFailed = true; // 帳號沒有 Firebase 權限，之後直接改用公開讀取
    last = res;
  }
  throw new Error(`讀取 Firebase「${path}」失敗（HTTP ${last.getResponseCode()}）：${last.getContentText().slice(0, 200)}`
    + '\n請確認 Firebase 資料庫規則已發布最新版（chains 要有 ".read": true）');
}

// ---------- 跟網站相同的名額邏輯（index.js） ----------
function normalizeMember(key, m) {
  if (!m || PLANS.indexOf(m.plan) < 0 || !/^\d{1,2}$/.test(String(m.court))) return null;
  const legacy = key.indexOf('_') < 0;
  const day = DAY_LABEL[m.day] ? m.day : (/_fri$/.test(key) ? 'fri' : 'sun');
  const rawCourt = String(m.court);
  return {
    key,
    lineId: key.split('_')[0],
    name: String(m.name || ''),
    plan: m.plan,
    day,
    rawCourt,
    court: legacy && !m.day ? (LEGACY_COURT_MAP[rawCourt] || rawCourt) : rawCourt,
    ts: m.ts || 0,
  };
}

function cleanList(val) {
  return Object.keys(val || {}).map((k) => normalizeMember(k, val[k])).filter(Boolean);
}

const headsOf = (e) => (e.self === false ? 0 : 1) + (e.guests || 0);
const listOf = (v) => (Array.isArray(v) ? v : Object.keys(v || {}).sort((a, b) => a - b).map((k) => v[k])).filter((x) => x != null);

function chainDay(c) {
  return DAY_LABEL[c.day] ? c.day : 'sun';
}

function chainCourts(c) {
  const src = c.courts || LEGACY_COURTS;
  return Object.keys(src).sort((a, b) => a - b).map((no) => ({ no, name: src[no].name, level: src[no].level }));
}

// 依報名時間排序，逐筆佔名額；一旦有人排不進，之後全部進候補（先來後到）
function splitEntries(list, capacity) {
  const sorted = list.slice().sort((a, b) => (a.ts - b.ts) || (a.uid < b.uid ? -1 : 1));
  const confirmed = [];
  const waitlist = [];
  let used = 0;
  sorted.forEach((e) => {
    const need = headsOf(e);
    if (!waitlist.length && used + need <= capacity) { confirmed.push(e); used += need; } else waitlist.push(e);
  });
  return { confirmed, waitlist, used };
}

function courtData(c, no, members, size) {
  const day = chainDay(c);
  const ms = members.filter((m) => m.day === day && (m.court === no || m.rawCourt === no))
    .map((m) => Object.assign({}, m, { leave: !!(c.leaves && c.leaves[m.key]) }));
  const active = ms.filter((m) => !m.leave).length;
  const cap = Math.max(0, size - active);
  const entries = Object.keys(c.entries || {}).map((uid) => Object.assign({ uid }, c.entries[uid])).filter((e) => e.court === no);
  return Object.assign({ members: ms, active, cap, size }, splitEntries(entries, cap));
}

// 接龍只存「1/3（日）」：依建立時間推年份（跨年開團時自動算到下一年）
function chainIso(c) {
  const m = String(c.date || '').match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  const created = new Date(c.createdAt || Date.now());
  let y = created.getFullYear();
  const mo = Number(m[1]);
  if (mo < created.getMonth() + 1 - 6) y += 1;
  return `${y}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

// 營運總覽的「每面上限人數」：A/B 欄週日、C/D 欄週五
function readCourtSizes() {
  const sizes = { sun: DEFAULT_COURT_SIZE, fri: DEFAULT_COURT_SIZE };
  const sh = SpreadsheetApp.getActive().getSheetByName('營運總覽');
  if (!sh) return sizes;
  sh.getDataRange().getDisplayValues().forEach((r) => {
    if (String(r[0]).indexOf('每面上限人數') === 0 && Number(r[1])) sizes.sun = Number(r[1]);
    if (String(r[2]).indexOf('每面上限人數') === 0 && Number(r[3])) sizes.fri = Number(r[3]);
  });
  return sizes;
}

// ---------- 寫入分頁 ----------
function writeTable(name, headers, rows, stamp) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1).setValue(`⚙️ 系統自動同步自報名網站，請勿手動修改（每次同步會整頁覆蓋）｜最後同步：${stamp}`).setFontColor('#888888');
  sh.getRange(2, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3f8f4');
  if (rows.length) sh.getRange(3, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(2);
}

const payText = (e) => (e.paid ? '已收' : e.pay === 'linepay' ? (e.payReported ? 'LINE Pay 已回報待確認' : 'LINE Pay 未付') : '現場付');
const tsDate = (ts) => (typeof ts === 'number' && ts > 0 ? new Date(ts) : '');

// ---------- 主程式 ----------
function syncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // 上一次同步還沒跑完
  try {
    const members = cleanList(fetchDb('pkclub/members'));
    const apps = cleanList(fetchDb('pkclub/applications'));
    const chains = fetchDb('chains');
    const sizes = readCourtSizes();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');

    // 1. 會員名單（含申請中）
    const memberRows = members.map((m) => ['會員', m.name, DAY_LABEL[m.day], `${m.court}號場`, m.plan, '', m.key])
      .concat(apps.map((a) => ['申請中', a.name, DAY_LABEL[a.day], `${a.court}號場`, a.plan, tsDate(a.ts), a.key]))
      .sort((a, b) => (a[2] + a[3] + a[0]).localeCompare(b[2] + b[3] + b[0]));
    writeTable(SHEETS.members, ['狀態', '姓名', '時段', '場地', '方案', '申請時間', 'LINE ID（系統用）'], memberRows, stamp);

    // 2. 報名明細 + 3. 每場統計
    const list = Object.keys(chains).map((id) => Object.assign({ id }, chains[id]))
      .filter((c) => c && 'price' in c)
      .map((c) => Object.assign(c, { iso: chainIso(c) }))
      .sort((a, b) => (a.iso + chainDay(a)).localeCompare(b.iso + chainDay(b)));
    const entryRows = [];
    const statRows = [];
    list.forEach((c) => {
      const day = chainDay(c);
      const price = typeof c.price === 'number' ? c.price : 0;
      const checkins = c.checkins || {};
      chainCourts(c).forEach((court) => {
        const cd = courtData(c, court.no, members, sizes[day]);
        const base = [c.iso, DAY_LABEL[day], c.title, `${court.no}號場 ${court.name}（${court.level}）`];
        const add = (e, status) => {
          const friends = listOf(e.friends).join('、');
          const fd = Array.from({ length: e.guests || 0 }, (_, i) => (e.friendDupr && e.friendDupr[i]) || '').join('、').replace(/^、+$/, '');
          entryRows.push(base.concat([
            e.name, e.self === false ? '否（代報）' : '是', e.guests || 0, friends, e.dupr || '', fd, headsOf(e),
            e.pay === 'linepay' ? 'LINE Pay' : '現金', payText(e), status, checkins[e.uid] ? '✓' : '', tsDate(e.ts), c.id,
          ]));
        };
        cd.confirmed.forEach((e) => add(e, '正取'));
        cd.waitlist.forEach((e) => add(e, '候補'));

        const singleHeads = cd.used;
        const attending = cd.members.filter((m) => !m.leave);
        const checked = attending.filter((m) => checkins[m.key]).length + cd.confirmed.filter((e) => checkins[e.uid]).length;
        const paidHeads = cd.confirmed.filter((e) => e.paid).reduce((s, e) => s + headsOf(e), 0);
        const reportedHeads = cd.confirmed.filter((e) => !e.paid && e.payReported).reduce((s, e) => s + headsOf(e), 0);
        statRows.push(base.concat([
          cd.size, cd.members.length, cd.members.length - cd.active, singleHeads, cd.waitlist.length,
          cd.active + singleHeads, checked, price, singleHeads * price, paidHeads * price, reportedHeads * price, c.id,
        ]));
      });
    });
    writeTable(SHEETS.entries, ['日期', '時段', '活動', '場地', '報名人', '本人上場', '同行人數', '朋友', '本人DUPR', '朋友DUPR',
      '佔名額', '付款方式', '付款狀態', '名單', '簽到', '報名時間', '接龍ID'], entryRows, stamp);
    writeTable(SHEETS.stats, ['日期', '時段', '活動', '場地', '每面上限', '會員數', '會員請假', '單次正取人數', '候補組數',
      '出席合計', '已簽到', '單次單價', '單次應收', '已收款', 'LINE Pay 待確認', '接龍ID'], statRows, stamp);

    toast(`同步完成：會員 ${members.length}、申請 ${apps.length}、接龍 ${list.length} 場`);
  } finally {
    lock.releaseLock();
  }
}
