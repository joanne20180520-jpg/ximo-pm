import { createWorker } from 'tesseract.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb'
    }
  },
  maxDuration: 60
};

async function ocrBuffer(buf) {
  const worker = await createWorker('chi_tra', 1, {
    logger: function() {}
  });
  try {
    const result = await worker.recognize(buf);
    return result.data.text || '';
  } finally {
    await worker.terminate();
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const b64 = body.imageBase64 || '';
    if (!b64) return res.status(400).json({ error: '缺少 imageBase64' });
    const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: '圖片資料無效' });
    const text = await ocrBuffer(buf);
    return res.status(200).json({ text: text });
  } catch (err) {
    console.error('parse-budget OCR error', err);
    return res.status(500).json({ error: err.message || 'OCR 失敗' });
  }
}
