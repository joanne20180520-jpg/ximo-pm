/**
 * api/lark.js — Vercel Serverless Function
 * 作為前端與 Lark API 之間的 Proxy，解決 CORS 問題
 *
 * 環境變數（在 Vercel Dashboard > Settings > Environment Variables 設定）：
 *   LARK_PAT  →  你的 Personal Access Token (u-xxxxxxxx)
 *
 * 使用方式：
 *   GET  /api/lark?path=/bitable/v1/apps/.../tables/.../records
 *   PATCH /api/lark?path=/bitable/v1/apps/.../tables/.../records/:id
 *        body: { fields: { ... } }
 */
 
const LARK_BASE = 'https://open.larksuite.com/open-apis';
 
export default async function handler(req, res) {
  // ── CORS headers ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  // ── Get PAT ──
  // 優先使用環境變數；開發時也可從 Header 傳入（x-lark-pat）
  const pat = process.env.LARK_PAT || req.headers['x-lark-pat'];
  if (!pat) {
    return res.status(401).json({ error: '未設定 LARK_PAT 環境變數或 x-lark-pat Header' });
  }
 
  // ── Build Lark URL ──
  const larkPath = req.query.path;
  if (!larkPath) {
    return res.status(400).json({ error: '缺少 ?path= 參數' });
  }
 
  // 把其他 query params 轉成 Lark API 的 query string（除了 path 本身）
  const forwardParams = { ...req.query };
  delete forwardParams.path;
  const qs = new URLSearchParams(forwardParams).toString();
  const url = `${LARK_BASE}${larkPath}${qs ? '?' + qs : ''}`;
 
  // ── Forward request ──
  try {
    const options = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
    };
 
    if (['PATCH', 'POST', 'PUT'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }
 
    const larkRes = await fetch(url, options);
    const data = await larkRes.json();
 
    return res.status(larkRes.status).json(data);
  } catch (err) {
    console.error('[lark proxy error]', err);
    return res.status(500).json({ error: err.message });
  }
}
 
