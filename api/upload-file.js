const APP_ID = (process.env.LARK_APP_ID || '').trim();
const APP_SECRET = (process.env.LARK_APP_SECRET || '').trim();
const APP_TOKEN = (process.env.LARK_APP_TOKEN || '').trim();
const APP_TOKEN_BACKEND = (process.env.LARK_APP_TOKEN_BACKEND || '').trim();
const BASE_URL = 'https://open.larksuite.com/open-apis';
const MAX_BYTES = 4.2 * 1024 * 1024;

let _tenantTokenCache = null;

export const config = {
  api: {
    bodyParser: false
  },
  maxDuration: 60
};

function appTokenForTable(tableKey) {
  if (tableKey === 'payments') {
    return (process.env.LARK_APP_TOKEN_PAYMENTS_FRONTEND || APP_TOKEN).trim();
  }
  return (APP_TOKEN_BACKEND || APP_TOKEN).trim();
}

async function getToken() {
  const now = Date.now();
  if (_tenantTokenCache && _tenantTokenCache.expiresAt > now + 60000) {
    return _tenantTokenCache.token;
  }
  if (!APP_ID || !APP_SECRET) throw new Error('缺少 LARK_APP_ID 或 LARK_APP_SECRET');
  const res = await fetch(BASE_URL + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('Token error: ' + data.msg);
  _tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, (data.expire || 7200)) * 1000
  };
  return _tenantTokenCache.token;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function uploadBitableMedia(token, appToken, fileName, buffer) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', appToken);
  form.append('size', String(buffer.length));
  form.append('file', new Blob([buffer]), fileName);
  const res = await fetch(BASE_URL + '/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'upload failed');
  return {
    file_token: data.data && data.data.file_token,
    name: fileName,
    size: buffer.length
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Access-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const tableKey = String(req.query.table || 'tasks').trim();
    const fileName = String(req.query.fileName || req.query.file_name || 'file').trim() || 'file';
    const buffer = await readRawBody(req);
    if (!buffer.length) return res.status(400).json({ error: 'empty file' });
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'file too large (max 4MB)' });
    }
    const appToken = appTokenForTable(tableKey);
    if (!appToken) return res.status(400).json({ error: 'missing app token for table' });
    const token = await getToken();
    const uploaded = await uploadBitableMedia(token, appToken, fileName, buffer);
    return res.status(200).json(uploaded);
  } catch (err) {
    console.error('upload-file', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
