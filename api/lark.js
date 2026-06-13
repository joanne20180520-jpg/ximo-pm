const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const APP_TOKEN = process.env.LARK_APP_TOKEN;
const BASE_URL = 'https://open.larksuite.com/open-apis';

// 取得 Access Token
async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

// 讀取表格資料
async function getTableRecords(token, tableId) {
  const res = await fetch(
    `${BASE_URL}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.data?.items || [];
}

// 新增記錄
async function createRecord(token, tableId, fields) {
  const res = await fetch(
    `${BASE_URL}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    }
  );
  return await res.json();
}

// 更新記錄
async function updateRecord(token, tableId, recordId, fields) {
  const res = await fetch(
    `${BASE_URL}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    }
  );
  return await res.json();
}

// 表格 ID 對照
const TABLES = {
  projects:    'tbl8ldUZKRcteYFu',
  workitems:   'tblc5QbFf04I3DFl',
  tasks:       'tbl7mC8KaVVXQOVG',
  expenses:    'tblsUdkQN56T6Jnk',
  payments:    'tblv9SmBvbhxNftU',
  designs:     'tblc3a8IofsGlbKu',
  journal:     'tblVs9L5WAJcE2a3',
  members:     'tblIHdb6u6S2xdJH'
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await getToken();
    const { action, table, recordId } = req.query;

    // GET - 讀取資料
    if (req.method === 'GET') {
      if (!TABLES[table]) return res.status(400).json({ error: 'Invalid table' });
      const records = await getTableRecords(token, TABLES[table]);
      return res.status(200).json({ records });
    }

    // POST - 新增記錄
    if (req.method === 'POST') {
      if (!TABLES[table]) return res.status(400).json({ error: 'Invalid table' });
      const result = await createRecord(token, TABLES[table], req.body);
      return res.status(200).json(result);
    }

    // PUT - 更新記錄
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
