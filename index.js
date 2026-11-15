// LINE Flex Message 發送邏輯（LIFF 版，可直接跑在 GitHub Pages 這種純前端網站）
// 到 LINE Developers → LINE Login channel → LIFF 建立 App 後，把 LIFF ID 填在這裡
const LIFF_ID = 'YOUR_LIFF_ID';

const statusEl = () => document.getElementById('status');
function setStatus(msg) {
  statusEl().textContent = msg;
}

// 組出一張 Flex 卡片。data 欄位可依實際需求替換
function buildFlexMessage(data) {
  return {
    type: 'flex',
    altText: `${data.title}｜${data.date} ${data.time}`, // 通知列與不支援 Flex 的裝置會顯示這段，最多 400 字
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: data.imageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: data.title, weight: 'bold', size: 'xl', wrap: true },
          infoRow('日期', data.date),
          infoRow('時間', data.time),
          infoRow('地點', data.place),
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
            action: { type: 'uri', label: '查看詳情', uri: data.linkUrl },
          },
        ],
      },
    },
  };
}

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

// 範例資料
function getCardData() {
  return {
    title: '匹克球進攻練習團',
    date: '2026/11/22（日）',
    time: '09:00 - 12:00',
    place: '六甲頂匹克球場',
    imageUrl: 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?w=1024',
    linkUrl: 'https://charliersa.github.io/pickleball-attack/',
  };
}

// 方式一：發到「目前開啟 LIFF 的那個聊天室」
// 只有從 LINE 聊天室內打開 LIFF 才能用，且 LIFF 需勾選 chat_message.write scope
async function sendToCurrentChat() {
  if (!liff.isInClient()) {
    setStatus('請從 LINE 聊天室內開啟此頁面才能直接發送');
    return;
  }
  const ctx = liff.getContext();
  if (!ctx || !['utou', 'room', 'group'].includes(ctx.type)) {
    setStatus('目前不在聊天室中，請改用「分享給好友」');
    return;
  }
  try {
    await liff.sendMessages([buildFlexMessage(getCardData())]);
    setStatus('已發送到聊天室 ✅');
    liff.closeWindow();
  } catch (err) {
    console.error(err);
    setStatus(`發送失敗：${err.message}`);
  }
}

// 方式二：跳出好友/群組選擇器分享（LINE 內外都可用）
// 需在 LIFF 設定頁開啟 shareTargetPicker
async function shareToFriends() {
  if (!liff.isApiAvailable('shareTargetPicker')) {
    setStatus('此環境不支援分享，請確認 LIFF 已開啟 shareTargetPicker');
    return;
  }
  try {
    const res = await liff.shareTargetPicker([buildFlexMessage(getCardData())]);
    // res 為 undefined 代表使用者取消；res.status === 'success' 代表已送出
    setStatus(res ? '已分享 ✅' : '已取消分享');
  } catch (err) {
    console.error(err);
    setStatus(`分享失敗：${err.message}`);
  }
}

async function main() {
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (err) {
    setStatus(`LIFF 初始化失敗：${err.message}`);
    return;
  }
  // 在外部瀏覽器開啟時，需要先登入 LINE 才能分享
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return;
  }
  document.getElementById('sendBtn').addEventListener('click', sendToCurrentChat);
  document.getElementById('shareBtn').addEventListener('click', shareToFriends);
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('shareBtn').disabled = false;
  setStatus('準備好了');
}

main();
