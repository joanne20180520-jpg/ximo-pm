const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const APP_TOKEN = process.env.LARK_APP_TOKEN;
const BASE_URL = process.env.LARK_BASE_URL || 'https://open.larksuite.com/open-apis';
 
// 取得 tenant_access_token
async function getToken() {
  if (!APP_ID || !APP_SECRET) {
    throw new Error('缺少 LARK_APP_ID 或 LARK_APP_SECRET');
  }
  const res = await fetch(BASE_URL + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error('Token error: ' + data.msg + ' (code ' + data.code + ')');
  }
  return data.tenant_access_token;
}
 
// 讀取表格資料
async function getRecords(token, tableId) {
  const url = BASE_URL + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tableId + '/records?page_size=100';
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('Records error: ' + data.msg + ' code:' + data.code);
  return data.data ? data.data.items || [] : [];
}
 
// 新增記錄
async function createRecord(token, tableId, fields) {
  const url = BASE_URL + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tableId + '/records';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: fields })
  });
  return await res.json();
}
 
// 更新記錄
async function updateRecord(token, tableId, recordId, fields) {
  const url = BASE_URL + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tableId + '/records/' + recordId;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: fields })
  });
  return await res.json();
}
 
const TABLES = {
  projects:  'tbl8ldUZKRcteYFu',
  workitems: 'tblc5QbFf04I3DFl',
  tasks:     'tbl7mC8KaVVXQOVG',
  expenses:  'tblsUdkQN56T6Jnk',
  payments:  'tblv9SmBvbhxNftU',
  designs:   'tblc3a8IofsGlbKu',
  journal:   'tblVs9L5WAJcE2a3',
  members:   'tblIHdb6u6S2xdJH'
};
 
async function sendWebhook(text) {
  const url = process.env.LARK_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: 'LARK_WEBHOOK_URL not set' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } })
  });
  return await res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { table, recordId, action } = req.query;

  try {
    if (action === 'ping' && req.method === 'GET') {
      let lark = null;
      let tokenOk = false;
      try {
        await getToken();
        tokenOk = true;
      } catch (e) {
        lark = e.message;
      }
      return res.status(200).json({
        ok: tokenOk,
        baseUrl: BASE_URL,
        env: {
          hasAppId: !!APP_ID,
          hasAppSecret: !!APP_SECRET,
          hasAppToken: !!APP_TOKEN,
          appIdLen: APP_ID ? APP_ID.length : 0,
          appSecretLen: APP_SECRET ? APP_SECRET.length : 0,
          appTokenLen: APP_TOKEN ? APP_TOKEN.length : 0
        },
        tokenError: lark
      });
    }

    if (req.method === 'GET') {
      if (!TABLES[table]) return res.status(400).json({ error: 'Invalid table: ' + table });
      try {
        const token = await getToken();
        const records = await getRecords(token, TABLES[table]);
        return res.status(200).json({ records: records });
      } catch (err) {
        console.error('GET ' + table, err);
        // 讀取失敗時回空陣列，前台照常顯示（與舊版行為一致）
        return res.status(200).json({ records: [], error: err.message });
      }
    }

    const token = await getToken();

    if (action === 'notify' && req.method === 'POST') {
      const b = req.body || {};
      const site = process.env.SITE_URL || 'https://ximo-pm.vercel.app';
      const printUrl = b.printPath
        ? site + '/' + b.printPath
        : (b.printUrl || site);
      const text = [
        '您有一筆付款申請單待列印 🖨️',
        '請點以下連結確認後列印：',
        '申請部門：' + (b.dept || ''),
        '事由：' + (b.reason || ''),
        '金額：' + (b.amount || ''),
        printUrl,
        '請點連結確認資料後列印送會計 👇'
      ].join('\n');
      const result = await sendWebhook(text);
      return res.status(200).json({ ok: true, notify: result });
    }

    if (req.method === 'POST') {
      if (!TABLES[table]) return res.status(400).json({ error: 'Invalid table' });
      const result = await createRecord(token, TABLES[table], req.body);
      return res.status(200).json(result);
    }

    if (req.method === 'PUT') {
      if (!TABLES[table] || !recordId) return res.status(400).json({ error: 'Invalid params' });
      const result = await updateRecord(token, TABLES[table], recordId, req.body);
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
 
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
 
