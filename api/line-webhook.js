// LINE Messaging API Webhook：有新成員加入群組時，自動回覆歡迎訊息（含報名連結與文案）
// 部署在 Vercel（檔案放在 /api 下即自動變成一個 Serverless Function）
//
// 需要的環境變數（Vercel 專案 → Settings → Environment Variables）：
//   LINE_CHANNEL_SECRET        LINE Developers Console → Messaging API → Channel secret
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Developers Console → Messaging API → Channel access token（長期）
//
// 設定完成後，Webhook URL 要填：https://<你的網域>/api/line-webhook
// 並在 LINE Developers Console 開啟「Use webhook」，且機器人本身要先被邀請加入該群組才收得到事件。

const crypto = require('crypto');

// 歡迎文字：連結記得換成你實際要用的報名／團資訊網址
const WELCOME_TEXT = `🏓 歡迎加入進擊的匹克團！

🔥 2027 雙場包場計畫
1～2 月體驗期：單次 160 元／人
3 月起正式推出會員方案（季繳 1,920／月繳 170／單次 180）

👉 報名／團資訊：https://liff.line.me/2012621364-BTCqnFfK`;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature, channelSecret) {
  const hash = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return signature === hash;
}

async function replyMessage(replyToken, text, accessToken) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) console.error('LINE reply 失敗', res.status, await res.text().catch(() => ''));
}

async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).send('ok'); return; }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !accessToken) {
    console.error('缺少 LINE_CHANNEL_SECRET 或 LINE_CHANNEL_ACCESS_TOKEN 環境變數');
    res.status(500).send('missing env');
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];
  if (!signature || !verifySignature(rawBody, signature, channelSecret)) {
    res.status(401).send('invalid signature');
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).send('bad json');
    return;
  }

  const events = body.events || [];
  await Promise.all(events.map(async (ev) => {
    // memberJoined：群組／多人聊天室有新成員加入；members 陣列可能一次多人
    if (ev.type === 'memberJoined' && ev.replyToken) {
      await replyMessage(ev.replyToken, WELCOME_TEXT, accessToken);
    }
  }));

  res.status(200).send('ok');
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
