import { createHash } from 'crypto';

const APP_ID = (process.env.LARK_APP_ID || '').trim();
const APP_SECRET = (process.env.LARK_APP_SECRET || '').trim();
const APP_TOKEN = (process.env.LARK_APP_TOKEN || '').trim();
const BASE_URL = 'https://open.larksuite.com/open-apis';

/** OAuth 重定向 URL — 須與 Lark 開發者後台「安全設定 > 重定向 URL」完全一致 */
function getCanonicalRedirectUri() {
  const raw = (process.env.LARK_REDIRECT_URI || process.env.SITE_URL || 'https://ximo-pm.vercel.app').trim();
  try {
    const u = new URL(raw);
    if (!u.pathname || u.pathname === '/') return u.origin;
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}
 
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
 
// 讀取表格資料（自動翻頁取回全部記錄）
async function getRecords(token, tableId) {
  var items = [];
  var pageToken = '';
  do {
    var url = BASE_URL + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tableId + '/records?page_size=500';
    if (pageToken) url += '&page_token=' + encodeURIComponent(pageToken);
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error('Records error: ' + data.msg + ' code:' + data.code);
    if (data.data && data.data.items) items = items.concat(data.data.items);
    pageToken = data.data && data.data.has_more ? (data.data.page_token || '') : '';
  } while (pageToken);
  return items;
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

async function updateBitableRecord(token, appToken, tableId, recordId, fields) {
  const url = BASE_URL + '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId + '?user_id_type=open_id';
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: fields })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'update failed');
  return data;
}
 
// 刪除記錄
async function deleteRecord(token, tableId, recordId) {
  const url = BASE_URL + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tableId + '/records/' + recordId;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return await res.json();
}

// 各表 table_id：換公司 Lark 時在 Vercel 改環境變數即可，不必改程式
// LARK_APP_TOKEN = 多維表格 base 的 app_token
// LARK_TABLE_PROJECTS / WORKITEMS / TASKS / … 見 TABLE_DEFAULTS 的 key
const TABLE_DEFAULTS = {
  projects:  'tbl8ldUZKRcteYFu',
  workitems: 'tblc5QbFf04I3DFl',
  tasks:     'tbl7mC8KaVVXQOVG',
  expenses:  'tblsUdkQN56T6Jnk',
  payments:  'tblv9SmBvbhxNftU',
  designs:   'tblc3a8IofsGlbKu',
  journal:   'tblVs9L5WAJcE2a3',
  members:   'tblIHdb6u6S2xdJH'
};

function buildTables() {
  const out = {};
  Object.keys(TABLE_DEFAULTS).forEach(function(key) {
    const envKey = 'LARK_TABLE_' + key.toUpperCase();
    out[key] = (process.env[envKey] || TABLE_DEFAULTS[key] || '').trim();
  });
  return out;
}

const TABLES = buildTables();
const WIKI_ARCHIVE_TEMPLATE = (process.env.LARK_ARCHIVE_TEMPLATE || process.env.LARK_WIKI_ARCHIVE_TEMPLATE || '').trim();

const ARCHIVE_TABLE_KEYWORDS = {
  projects: ['標案', '專案', 'project'],
  workitems: ['工作項目', 'workitem'],
  tasks: ['任務', 'task'],
  expenses: ['支出', 'expense', '費用'],
  designs: ['設計', 'design']
};

function formatArchiveCopyError(msg) {
  const s = String(msg || '').trim();
  if (!s) return s;
  if (/wiki:wiki|wiki:node:read|wiki:wiki:readonly/i.test(s)) {
    return s + '。請至 Lark 開發者後台 → 權限管理，開通 wiki:wiki、wiki:node:read、bitable:app 並發布應用後再封存。';
  }
  if (/not found/i.test(s)) {
    return '找不到指定的知識庫頁面或多維表格範本。請確認：① Wiki 封存位置為知識庫首頁/目錄頁完整連結；② Vercel 的 LARK_ARCHIVE_TEMPLATE 為同一租戶內可開啟的 /base/ 範本連結。';
  }
  if (/FieldNameNotFound/i.test(s)) {
    return '知識庫範本多維表格欄位與後台不一致（已自動略過不存在的欄位仍失敗）。請確認 LARK_ARCHIVE_TEMPLATE 是從同一套後台多維表格複製的完整範本，或重新複製最新版範本後更新環境變數。';
  }
  if (/Duplex Link/i.test(s)) {
    return '雙向關聯欄位格式錯誤（已修正程式，請重新封存）。若仍失敗，請確認範本與後台結構一致。';
  }
  if (/UserFieldConvFail/i.test(s)) {
    return '人員欄位格式錯誤（已修正程式，請重新封存）。';
  }
  if (/WrongRequestBody|Field types do not match|ConvFail/i.test(s)) {
    return '寫入知識庫時欄位資料格式不符（已自動轉換常見欄位，請再試一次）。';
  }
  return s;
}

async function larkApiGet(accessToken, apiPath) {
  const res = await fetch(BASE_URL + apiPath, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'Lark API error');
  return data.data;
}

async function larkApiPost(accessToken, apiPath, body) {
  const res = await fetch(BASE_URL + apiPath, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'Lark API error');
  return data.data;
}

function buildWikiNodeUrl(baseUrl, nodeToken) {
  try {
    const u = new URL(String(baseUrl || '').trim());
    return u.origin + '/wiki/' + nodeToken;
  } catch (e) {
    return 'https://www.larksuite.com/wiki/' + nodeToken;
  }
}

function getWikiTokenFromUrl(url) {
  const parsed = extractLarkUrlToken(url);
  return parsed && parsed.token ? parsed.token : '';
}

async function copyWikiNode(accessToken, spaceId, nodeToken, opts) {
  const path = '/wiki/v2/spaces/' + encodeURIComponent(spaceId) + '/nodes/' + encodeURIComponent(nodeToken) + '/copy';
  const body = {};
  if (opts && opts.targetParentToken) body.target_parent_token = opts.targetParentToken;
  if (opts && opts.targetSpaceId) body.target_space_id = opts.targetSpaceId;
  if (opts && opts.title) body.title = opts.title;
  const data = await larkApiPost(accessToken, path, body);
  return data.node;
}

function isBitableCopyingError(err) {
  const msg = (err && err.message) || String(err || '');
  return msg.indexOf('copying') >= 0 || msg.indexOf('1254036') >= 0;
}

async function ensureBitableReady(accessToken, appToken, maxRetries) {
  const tries = maxRetries || 12;
  for (let i = 0; i < tries; i++) {
    try {
      await listBitableTables(accessToken, appToken);
      return;
    } catch (err) {
      if (isBitableCopyingError(err) && i < tries - 1) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        continue;
      }
      throw err;
    }
  }
}

async function resolveBitableFromWikiNode(accessToken, node, baseUrl) {
  if (!node) throw new Error('找不到知識庫節點');
  let appToken = '';
  if (node.obj_type === 'bitable' && node.obj_token) appToken = node.obj_token;
  if (!appToken && node.obj_type === 'docx' && node.obj_token) {
    appToken = await findBitableAppTokenInDocx(accessToken, node.obj_token);
  }
  if (!appToken) {
    appToken = await findBitableAppTokenInWikiSubtree(accessToken, node.space_id, node.node_token);
  }
  if (!appToken) throw new Error('此知識庫頁面找不到多維表格');
  await ensureBitableReady(accessToken, appToken);
  const tableMap = await resolveArchiveTableMap(accessToken, appToken);
  return {
    appToken: appToken,
    tableMap: tableMap,
    wikiUrl: buildWikiNodeUrl(baseUrl, node.node_token)
  };
}

function buildBaseAppUrl(templateUrl, appToken) {
  try {
    const u = new URL(String(templateUrl || '').trim());
    return u.origin + '/base/' + appToken;
  } catch (e) {
    return 'https://www.larksuite.com/base/' + appToken;
  }
}

async function copyBitableApp(accessToken, appToken, name) {
  const token = String(appToken || '').trim();
  if (!token) throw new Error('封存範本 app_token 無效');
  try {
    const data = await larkApiPost(accessToken, '/bitable/v1/apps/' + encodeURIComponent(token) + '/copy', {
      name: name || '封存標案'
    });
    const newToken = data && data.app && data.app.app_token;
    if (!newToken) throw new Error('複製雲端多維表格失敗');
    await ensureBitableReady(accessToken, newToken);
    return newToken;
  } catch (err) {
    const msg = err.message || '';
    if (/not found/i.test(msg)) {
      throw new Error('找不到封存範本多維表格（app: ' + token + '）。請確認 Vercel 環境變數 LARK_ARCHIVE_TEMPLATE 的 /base/ 連結正確，且範本仍存在於同一 Lark 租戶。');
    }
    throw err;
  }
}

async function createWikiBitableNode(accessToken, spaceId, parentNodeToken, appToken, title) {
  const body = {
    obj_type: 'bitable',
    obj_token: appToken,
    node_type: 'origin',
    title: title || '封存標案'
  };
  const parent = String(parentNodeToken || '').trim();
  if (parent) body.parent_node_token = parent;
  const data = await larkApiPost(accessToken, '/wiki/v2/spaces/' + encodeURIComponent(spaceId) + '/nodes', body);
  return data.node;
}

async function resolveWikiParentTarget(accessToken, wikiUrl) {
  const parsed = extractLarkUrlToken(wikiUrl);
  if (!parsed || !parsed.token) throw new Error('知識庫存放位置連結無效');

  if (parsed.kind === 'wiki_space') {
    return { space_id: parsed.token, node_token: '', wikiUrl: wikiUrl };
  }

  if (parsed.kind === 'wiki') {
    const node = await getWikiNode(accessToken, parsed.token, 'Wiki 封存位置');
    if (!node) throw new Error('找不到知識庫存放位置');
    return { space_id: node.space_id, node_token: node.node_token, node: node, wikiUrl: wikiUrl };
  }

  throw new Error('Wiki 封存位置須為 wiki/space/… 或 wiki/節點ID 連結');
}

async function copyArchiveTemplateToParent(accessToken, parentWikiUrl, projectName) {
  const templateUrl = WIKI_ARCHIVE_TEMPLATE;
  if (!templateUrl) {
    throw new Error('尚未設定封存範本（LARK_ARCHIVE_TEMPLATE）');
  }

  const parent = await resolveWikiParentTarget(accessToken, parentWikiUrl);

  const templateParsed = extractLarkUrlToken(templateUrl);
  const title = projectName || '封存標案';

  if (templateParsed && templateParsed.kind === 'base') {
    const newAppToken = await copyBitableApp(accessToken, templateParsed.token, title);
    const tableMap = await resolveArchiveTableMap(accessToken, newAppToken);
    let wikiUrl = '';
    try {
      const node = await createWikiBitableNode(accessToken, parent.space_id, parent.node_token, newAppToken, title);
      wikiUrl = buildWikiNodeUrl(parent.wikiUrl, node.node_token);
    } catch (e) {
      wikiUrl = buildBaseAppUrl(templateUrl, newAppToken);
    }
    return { appToken: newAppToken, tableMap: tableMap, wikiUrl: wikiUrl };
  }

  const templateToken = templateParsed ? templateParsed.token : '';
  if (!templateToken) throw new Error('封存範本連結無效');
  const templateNode = await getWikiNode(accessToken, templateToken, '封存範本');
  if (!templateNode) throw new Error('找不到封存範本');

  const copyOpts = { targetSpaceId: parent.space_id, title: title };
  if (parent.node_token) copyOpts.targetParentToken = parent.node_token;
  const copied = await copyWikiNode(accessToken, templateNode.space_id, templateNode.node_token, copyOpts);
  if (!copied) throw new Error('複製封存範本失敗');

  return resolveBitableFromWikiNode(accessToken, copied, parentWikiUrl);
}

async function resolveOrCreateWikiBitableTarget(accessToken, wikiUrl, projectName) {
  try {
    const appToken = await resolveBitableAppTokenFromUrl(accessToken, wikiUrl);
    await ensureBitableReady(accessToken, appToken);
    const tableMap = await resolveArchiveTableMap(accessToken, appToken);
    return {
      appToken: appToken,
      tableMap: tableMap,
      wikiUrl: wikiUrl,
      createdCopy: false
    };
  } catch (directErr) {
    if (!WIKI_ARCHIVE_TEMPLATE) throw directErr;
    const created = await copyArchiveTemplateToParent(accessToken, wikiUrl, projectName);
    return {
      appToken: created.appToken,
      tableMap: created.tableMap,
      wikiUrl: created.wikiUrl,
      createdCopy: true
    };
  }
}

function extractLarkUrlToken(url) {
  try {
    const u = new URL(String(url || '').trim());
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'wiki' && parts[i + 1] === 'space' && parts[i + 2]) {
        return { kind: 'wiki_space', token: parts[i + 2] };
      }
      if (parts[i] === 'wiki' || parts[i] === 'base' || parts[i] === 'docx') {
        const next = parts[i + 1] || '';
        if (parts[i] === 'wiki' && next === 'space') continue;
        return { kind: parts[i], token: next };
      }
    }
    const last = parts[parts.length - 1];
    if (last && last.length > 10) return { kind: 'unknown', token: last };
  } catch (e) { /* ignore */ }
  return null;
}

function parseBitableAppTokenFromBlockToken(blockToken) {
  if (!blockToken) return '';
  const idx = blockToken.indexOf('_');
  return idx > 0 ? blockToken.slice(0, idx) : blockToken;
}

async function getWikiNode(accessToken, nodeToken, label) {
  const token = String(nodeToken || '').trim();
  if (!token || token.length < 6) {
    throw new Error((label || '知識庫連結') + '無效，請貼上完整的 wiki 或 base 連結');
  }
  try {
    const data = await larkApiGet(accessToken, '/wiki/v2/spaces/get_node?token=' + encodeURIComponent(token));
    return data.node;
  } catch (err) {
    const msg = err.message || '';
    if (/not found/i.test(msg)) {
      throw new Error('找不到' + (label || '知識庫頁面') + '（token: ' + token + '）。請在 Lark 開啟該知識庫頁面，從瀏覽器複製完整網址（須含 wiki/ 後面的節點 ID）。');
    }
    throw err;
  }
}

async function listWikiChildNodes(accessToken, spaceId, parentNodeToken) {
  const items = [];
  let pageToken = '';
  do {
    let path = '/wiki/v2/spaces/' + encodeURIComponent(spaceId) + '/nodes?page_size=50';
    if (parentNodeToken) path += '&parent_node_token=' + encodeURIComponent(parentNodeToken);
    if (pageToken) path += '&page_token=' + encodeURIComponent(pageToken);
    const data = await larkApiGet(accessToken, path);
    if (data.items) items.push.apply(items, data.items);
    pageToken = data.has_more ? (data.page_token || '') : '';
  } while (pageToken);
  return items;
}

async function findBitableAppTokenInDocx(accessToken, docToken) {
  const apps = [];
  let pageToken = '';
  do {
    let path = '/docx/v1/documents/' + encodeURIComponent(docToken) + '/blocks?page_size=500';
    if (pageToken) path += '&page_token=' + encodeURIComponent(pageToken);
    const data = await larkApiGet(accessToken, path);
    (data.items || []).forEach(function(block) {
      const bitable = block.bitable || (block.block && block.block.bitable);
      const raw = bitable && (bitable.token || (bitable.view && bitable.view.token));
      const app = parseBitableAppTokenFromBlockToken(raw);
      if (app && apps.indexOf(app) < 0) apps.push(app);
    });
    pageToken = data.has_more ? (data.page_token || '') : '';
  } while (pageToken);
  return apps[0] || '';
}

async function findBitableAppTokenInWikiSubtree(accessToken, spaceId, nodeToken) {
  const node = await getWikiNode(accessToken, nodeToken, '知識庫頁面');
  if (!node) return '';

  if (node.obj_type === 'bitable') return node.obj_token || '';

  if (node.obj_type === 'docx') {
    const fromDocx = await findBitableAppTokenInDocx(accessToken, node.obj_token);
    if (fromDocx) return fromDocx;
  }

  if (!node.has_child) return '';

  const children = await listWikiChildNodes(accessToken, spaceId, node.node_token);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.obj_type === 'bitable' && child.obj_token) return child.obj_token;
    if (child.obj_type === 'docx') {
      const fromDocx = await findBitableAppTokenInDocx(accessToken, child.obj_token);
      if (fromDocx) return fromDocx;
    }
    if (child.has_child) {
      const deep = await findBitableAppTokenInWikiSubtree(accessToken, spaceId, child.node_token);
      if (deep) return deep;
    }
  }
  return '';
}

async function resolveBitableAppTokenFromUrl(accessToken, url) {
  const parsed = extractLarkUrlToken(url);
  if (!parsed || !parsed.token) throw new Error('無法從連結解析 token');

  if (parsed.kind === 'base') return parsed.token;

  if (parsed.kind === 'wiki_space') {
    throw new Error('知識庫空間連結尚無表格，將從範本複製');
  }

  if (parsed.kind === 'docx') {
    const app = await findBitableAppTokenInDocx(accessToken, parsed.token);
    if (!app) throw new Error('文件中找不到嵌入的多維表格');
    return app;
  }

  const wikiToken = parsed.token;
  const node = await getWikiNode(accessToken, wikiToken, '知識庫連結');
  if (!node) throw new Error('找不到知識庫節點');

  if (node.obj_type === 'bitable' && node.obj_token) return node.obj_token;

  if (node.obj_type === 'docx') {
    const fromDocx = await findBitableAppTokenInDocx(accessToken, node.obj_token);
    if (fromDocx) return fromDocx;
  }

  const fromSubtree = await findBitableAppTokenInWikiSubtree(accessToken, node.space_id, node.node_token);
  if (fromSubtree) return fromSubtree;

  throw new Error('此知識庫頁面找不到多維表格，請貼上該標案專用的知識庫頁面連結');
}

async function listBitableTables(accessToken, appToken) {
  const items = [];
  let pageToken = '';
  do {
    let path = '/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables?page_size=100';
    if (pageToken) path += '&page_token=' + encodeURIComponent(pageToken);
    const data = await larkApiGet(accessToken, path);
    if (data.items) items.push.apply(items, data.items);
    pageToken = data.has_more ? (data.page_token || '') : '';
  } while (pageToken);
  return items;
}

async function listBitableFields(accessToken, appToken, tableId) {
  const items = [];
  let pageToken = '';
  do {
    let path = '/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables/' + encodeURIComponent(tableId) + '/fields?page_size=100';
    if (pageToken) path += '&page_token=' + encodeURIComponent(pageToken);
    const data = await larkApiGet(accessToken, path);
    if (data.items) items.push.apply(items, data.items);
    pageToken = data.has_more ? (data.page_token || '') : '';
  } while (pageToken);
  return items;
}

const ARCHIVE_FIELD_ALIASES = {
  '所數標案': ['所屬標案'],
  '所屬標案': ['所數標案'],
  'Wiki存放位置': ['Wiki連結', '知識庫連結', '封存連結'],
  'Wiki連結': ['Wiki存放位置', '知識庫連結', '封存連結'],
  '知識庫連結': ['Wiki連結', 'Wiki存放位置', '封存連結'],
  '封存連結': ['Wiki連結', 'Wiki存放位置', '知識庫連結']
};

const BITABLE_LINK_FIELD_TYPES = { 18: 1, 21: 1 };
const BITABLE_SKIP_FIELD_TYPES = { 22: 1, 23: 1, 1001: 1, 1002: 1, 1003: 1, 1004: 1 };

async function getTableFieldSchemas(accessToken, appToken, tableId, cache) {
  const setKey = appToken + ':' + tableId;
  const metaKey = appToken + ':' + tableId + ':meta';
  if (cache[setKey] && cache[metaKey]) {
    return { allowedSet: cache[setKey], fieldMeta: cache[metaKey] };
  }
  const fields = await listBitableFields(accessToken, appToken, tableId);
  const set = {};
  const meta = {};
  fields.forEach(function(f) {
    if (f.field_name) {
      set[f.field_name] = 1;
      meta[f.field_name] = { type: f.type };
    }
  });
  cache[setKey] = set;
  cache[metaKey] = meta;
  return { allowedSet: set, fieldMeta: meta };
}

async function getTableFieldNameSet(accessToken, appToken, tableId, cache) {
  const schemas = await getTableFieldSchemas(accessToken, appToken, tableId, cache);
  return schemas.allowedSet;
}

function normalizeLinkFieldValue(val) {
  return getLinkIds(val).map(function(id) { return String(id); });
}

function normalizePersonFieldValue(val) {
  if (!val) return null;
  const items = Array.isArray(val) ? val : [val];
  const out = [];
  items.forEach(function(x) {
    if (!x) return;
    if (typeof x === 'string' && x) out.push({ id: String(x) });
    else if (x && x.id) out.push({ id: String(x.id) });
    else if (x && x.open_id) out.push({ id: String(x.open_id) });
    else if (x && x.user_id) out.push({ id: String(x.user_id) });
  });
  return out.length ? out : null;
}

function normalizeArchiveUrlValue(val) {
  if (!val) return null;
  if (typeof val === 'string' && val.trim()) {
    const url = val.trim();
    const text = url.replace(/^https?:\/\//, '');
    return { link: url, text: text.length > 48 ? text.slice(0, 48) + '…' : text };
  }
  if (val && typeof val === 'object' && val.link) {
    return { link: String(val.link), text: String(val.text || val.link).slice(0, 48) };
  }
  return null;
}

function normalizeArchiveDateValue(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number' && isFinite(val)) return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val, 10);
  return null;
}

function normalizeArchiveNumberValue(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number' && isFinite(val)) return val;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

function normalizeArchiveSelectValue(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val) && val.length) {
    const first = val[0];
    if (typeof first === 'string') return first;
    if (first && first.text) return String(first.text);
    if (first && first.name) return String(first.name);
  }
  if (val && typeof val === 'object') {
    if (val.text) return String(val.text);
    if (val.name) return String(val.name);
  }
  return null;
}

function normalizeArchiveMultiSelectValue(val) {
  if (!val) return null;
  const raw = Array.isArray(val) ? val : [val];
  const out = [];
  raw.forEach(function(x) {
    if (!x) return;
    if (typeof x === 'string' && x) out.push(x);
    else if (x && x.text) out.push(String(x.text));
    else if (x && x.name) out.push(String(x.name));
  });
  return out.length ? out : null;
}

function normalizeArchiveFieldValue(meta, val) {
  if (val === undefined || val === null || val === '') return null;
  if (!meta) return null;
  const t = meta.type;

  if (BITABLE_SKIP_FIELD_TYPES[t] || t === 17) return null;
  if (BITABLE_LINK_FIELD_TYPES[t]) return null;

  if (t === 11) return normalizePersonFieldValue(val);
  if (t === 15) return normalizeArchiveUrlValue(val);
  if (t === 5) return normalizeArchiveDateValue(val);
  if (t === 2) return normalizeArchiveNumberValue(val);
  if (t === 3) return normalizeArchiveSelectValue(val);
  if (t === 4) return normalizeArchiveMultiSelectValue(val);
  if (t === 7) return typeof val === 'boolean' ? val : null;
  if (t === 13) {
    if (typeof val === 'string') return val;
    return null;
  }
  if (t === 1) {
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (val && typeof val === 'object' && val.text) return String(val.text);
    return null;
  }

  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  return null;
}

function applyWikiUrlOverrides(overrides, allowedSet, fieldMeta, url) {
  if (!url) return;
  ['知識庫連結', '封存連結', 'Wiki存放位置', 'Wiki連結'].forEach(function(name) {
    if (!allowedSet[name]) return;
    const meta = fieldMeta[name];
    if (!meta) return;
    if (meta.type === 15) overrides[name] = makeWikiLink(url);
    else if (meta.type === 1 || meta.type === 13) overrides[name] = url;
  });
}

function buildArchiveRecordFields(rawFields, allowedSet, fieldMeta, overrides) {
  overrides = overrides || {};
  const remapped = remapFieldsForTarget(rawFields, allowedSet);
  const out = {};
  Object.keys(remapped).forEach(function(name) {
    if (overrides[name] !== undefined) return;
    const meta = fieldMeta[name];
    if (!meta) return;
    const normalized = normalizeArchiveFieldValue(meta, remapped[name]);
    if (normalized !== null && normalized !== undefined) out[name] = normalized;
  });
  Object.keys(overrides).forEach(function(name) {
    if (!allowedSet[name]) return;
    const meta = fieldMeta[name];
    const val = overrides[name];
    if (meta && BITABLE_LINK_FIELD_TYPES[meta.type]) {
      const ids = normalizeLinkFieldValue(val);
      if (ids.length) out[name] = ids;
      return;
    }
    if (meta && meta.type === 11) {
      const normalized = normalizePersonFieldValue(val);
      if (normalized) out[name] = normalized;
      return;
    }
    if (meta) {
      const normalized = normalizeArchiveFieldValue(meta, val);
      if (normalized !== null && normalized !== undefined) out[name] = normalized;
      return;
    }
    out[name] = val;
  });
  return out;
}

function remapFieldsForTarget(fields, allowedSet) {
  const out = {};
  Object.keys(fields || {}).forEach(function(name) {
    let targetName = name;
    if (!allowedSet[targetName]) {
      const aliases = ARCHIVE_FIELD_ALIASES[name];
      if (aliases) {
        for (let i = 0; i < aliases.length; i++) {
          if (allowedSet[aliases[i]]) {
            targetName = aliases[i];
            break;
          }
        }
      }
    }
    if (allowedSet[targetName]) out[targetName] = fields[name];
  });
  return out;
}

function pickProjectLinkFieldName(allowedSet) {
  if (allowedSet['所屬標案']) return '所屬標案';
  if (allowedSet['所數標案']) return '所數標案';
  return '';
}

function pickWikiUrlFieldNames(allowedSet) {
  const names = [];
  ['知識庫連結', '封存連結', 'Wiki存放位置', 'Wiki連結'].forEach(function(name) {
    if (allowedSet[name]) names.push(name);
  });
  return names;
}

async function filterFieldsForArchiveTable(accessToken, appToken, tableId, fields, cache) {
  const allowedSet = await getTableFieldNameSet(accessToken, appToken, tableId, cache);
  return remapFieldsForTarget(fields, allowedSet);
}

function matchArchiveTableByKeywords(tables, keywords) {
  return tables.find(function(t) {
    const name = (t.name || '').toLowerCase();
    return keywords.some(function(kw) { return name.indexOf(kw.toLowerCase()) >= 0; });
  });
}

async function resolveArchiveTableMap(accessToken, appToken) {
  const tables = await listBitableTables(accessToken, appToken);
  const map = {};
  const missing = [];
  Object.keys(ARCHIVE_TABLE_KEYWORDS).forEach(function(key) {
    const matched = matchArchiveTableByKeywords(tables, ARCHIVE_TABLE_KEYWORDS[key]);
    if (matched) map[key] = matched.table_id;
    else missing.push(key);
  });
  if (missing.length) {
    const avail = tables.map(function(t) { return t.name; }).join('、');
    throw new Error('目標多維表格缺少資料表（' + missing.join('、') + '）。現有：' + avail);
  }
  return map;
}

async function inspectWikiBitableTarget(accessToken, wikiUrl, projectName) {
  try {
    const appToken = await resolveBitableAppTokenFromUrl(accessToken, wikiUrl);
    await ensureBitableReady(accessToken, appToken);
    const tables = await listBitableTables(accessToken, appToken);
    const tableMap = await resolveArchiveTableMap(accessToken, appToken);
    const tableNames = {};
    Object.keys(tableMap).forEach(function(key) {
      const found = tables.find(function(t) { return t.table_id === tableMap[key]; });
      tableNames[key] = found ? found.name : tableMap[key];
    });
    return { mode: 'direct', appToken: appToken, tableNames: tableNames };
  } catch (err) {
    if (!WIKI_ARCHIVE_TEMPLATE) throw err;
    return {
      mode: 'template_copy',
      templateConfigured: true,
      note: '此位置尚無多維表格，封存時將自動從範本複製新頁面（標題：' + (projectName || '封存標案') + '）並寫入資料'
    };
  }
}

function getLinkIds(linkField) {
  if (!linkField) return [];
  if (linkField.record_ids) return linkField.record_ids.slice();
  if (linkField.link_record_ids) return linkField.link_record_ids.slice();
  if (typeof linkField === 'string') return [linkField];
  if (Array.isArray(linkField)) {
    var ids = [];
    linkField.forEach(function(item) {
      if (!item) return;
      if (typeof item === 'string') ids.push(item);
      else if (item.record_ids) ids = ids.concat(item.record_ids);
      else if (item.link_record_ids) ids = ids.concat(item.link_record_ids);
      else if (item.record_id) ids.push(item.record_id);
      else if (item.id) ids.push(item.id);
    });
    return ids;
  }
  return [];
}

function getLinkText(linkField) {
  if (!linkField) return '';
  if (linkField.text_arr && linkField.text_arr[0]) return linkField.text_arr[0];
  if (Array.isArray(linkField) && linkField[0]) {
    if (linkField[0].text_arr && linkField[0].text_arr[0]) return linkField[0].text_arr[0];
    if (linkField[0].text) return linkField[0].text;
  }
  return '';
}

function getProjectWiIds(proj) {
  return getLinkIds((proj.fields || {})['工作項目']);
}

function getProjectNameFromWiFields(wiFields, projects) {
  if (!wiFields) return '';
  var text = getLinkText(wiFields['所屬標案']);
  if (text) return text;
  var ids = getLinkIds(wiFields['所屬標案']);
  if (ids[0]) {
    var proj = projects.find(function(p) { return p.record_id === ids[0]; });
    if (proj) return (proj.fields && proj.fields['標案名稱']) || '';
  }
  return '';
}

function gatherWorkitemsForProject(proj, allWorkitems, allProjects) {
  var f = proj.fields || {};
  var pname = f['標案名稱'] || '';
  var projId = proj.record_id;
  var result = [];
  var seen = {};
  getProjectWiIds(proj).forEach(function(id) {
    var wi = allWorkitems.find(function(w) { return w.record_id === id; });
    if (wi) { seen[wi.record_id] = 1; result.push(wi); }
  });
  allWorkitems.forEach(function(wi) {
    if (seen[wi.record_id]) return;
    var linkedIds = getLinkIds(wi.fields['所屬標案']);
    if (linkedIds.indexOf(projId) >= 0) {
      seen[wi.record_id] = 1;
      result.push(wi);
      return;
    }
    if (pname && getProjectNameFromWiFields(wi.fields, allProjects) === pname) {
      seen[wi.record_id] = 1;
      result.push(wi);
    }
  });
  return result;
}

function getExpenseProjIds(f) {
  return getLinkIds(f['所數標案'] || f['所屬標案']);
}

function cloneFields(fields) {
  return JSON.parse(JSON.stringify(fields || {}));
}

function makeWikiLink(url) {
  const text = url.replace(/^https?:\/\//, '');
  return { link: url, text: text.length > 48 ? text.slice(0, 48) + '…' : text };
}

async function gatherProjectRelated(token, projectId) {
  const projects = await getRecords(token, TABLES.projects);
  const proj = projects.find(function(p) { return p.record_id === projectId; });
  if (!proj) throw new Error('找不到標案');

  const workitems = await getRecords(token, TABLES.workitems);
  const tasks = await getRecords(token, TABLES.tasks);
  const expenses = await getRecords(token, TABLES.expenses);
  const designs = await getRecords(token, TABLES.designs);

  const workitemsRel = gatherWorkitemsForProject(proj, workitems, projects);
  const wiIdSet = {};
  workitemsRel.forEach(function(w) { wiIdSet[w.record_id] = 1; });

  const tasksRel = tasks.filter(function(t) {
    return getLinkIds(t.fields['所屬工作項目']).some(function(id) { return wiIdSet[id]; });
  });
  const expensesRel = expenses.filter(function(e) {
    var wiIds = getLinkIds(e.fields['所屬工作項目']);
    if (wiIds.some(function(id) { return wiIdSet[id]; })) return true;
    return getExpenseProjIds(e.fields).indexOf(projectId) >= 0;
  });
  const designsRel = designs.filter(function(d) {
    return getLinkIds(d.fields['所屬工作項目']).some(function(id) { return wiIdSet[id]; });
  });

  return {
    project: proj,
    workitems: workitemsRel,
    tasks: tasksRel,
    expenses: expensesRel,
    designs: designsRel
  };
}

async function batchCreateRecords(token, appToken, tableId, fieldsList, tableLabel) {
  if (!fieldsList.length) return [];
  const created = [];
  const chunkSize = 100;
  const label = tableLabel || tableId;
  for (let i = 0; i < fieldsList.length; i += chunkSize) {
    const chunk = fieldsList.slice(i, i + chunkSize);
    const url = BASE_URL + '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/batch_create?user_id_type=open_id';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: chunk.map(function(fields) { return { fields: fields }; }) })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(label + '：' + (data.msg || 'batch_create failed'));
    if (data.data && data.data.records) created.push.apply(created, data.data.records);
  }
  return created;
}

async function copyProjectBundleToWikiBase(token, bundle, wikiUrl) {
  const projectName = bundle.project.fields['標案名稱'] || '封存標案';
  const target = await resolveOrCreateWikiBitableTarget(token, wikiUrl, projectName);
  const targetApp = target.appToken;
  const tableMap = target.tableMap;
  const finalWikiUrl = target.wikiUrl || wikiUrl;
  const fieldCache = {};

  const projSchemas = await getTableFieldSchemas(token, targetApp, tableMap.projects, fieldCache);
  const projAllowed = projSchemas.allowedSet;
  const projMeta = projSchemas.fieldMeta;
  const projOverrides = { '狀態': '封存' };
  if (finalWikiUrl) applyWikiUrlOverrides(projOverrides, projAllowed, projMeta, finalWikiUrl);
  const projFields = buildArchiveRecordFields(cloneFields(bundle.project.fields), projAllowed, projMeta, projOverrides);
  const projCreated = await batchCreateRecords(token, targetApp, tableMap.projects, [projFields], '標案');
  const newProjId = projCreated[0] && projCreated[0].record_id;
  if (!newProjId) throw new Error('複製標案至知識庫失敗');

  const wiSchemas = await getTableFieldSchemas(token, targetApp, tableMap.workitems, fieldCache);
  const wiAllowed = wiSchemas.allowedSet;
  const wiMeta = wiSchemas.fieldMeta;
  const wiLinkField = pickProjectLinkFieldName(wiAllowed) || '所屬標案';
  const wiMap = {};
  const wiFieldsList = bundle.workitems.map(function(wi) {
    const overrides = {};
    if (wiAllowed[wiLinkField]) overrides[wiLinkField] = [newProjId];
    return buildArchiveRecordFields(cloneFields(wi.fields), wiAllowed, wiMeta, overrides);
  });
  const wiCreated = await batchCreateRecords(token, targetApp, tableMap.workitems, wiFieldsList, '工作項目');
  bundle.workitems.forEach(function(wi, i) {
    if (wiCreated[i]) wiMap[wi.record_id] = wiCreated[i].record_id;
  });

  if (projAllowed['工作項目'] && wiCreated.length) {
    const newWiIds = wiCreated.map(function(r) { return r.record_id; }).filter(Boolean);
    if (newWiIds.length) {
      await updateBitableRecord(token, targetApp, tableMap.projects, newProjId, {
        '工作項目': newWiIds.map(String)
      });
    }
  }

  const taskSchemas = await getTableFieldSchemas(token, targetApp, tableMap.tasks, fieldCache);
  const taskAllowed = taskSchemas.allowedSet;
  const taskMeta = taskSchemas.fieldMeta;
  const taskFieldsList = bundle.tasks.map(function(t) {
    const overrides = {};
    const oldWi = getLinkIds(t.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && taskAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    return buildArchiveRecordFields(cloneFields(t.fields), taskAllowed, taskMeta, overrides);
  });
  await batchCreateRecords(token, targetApp, tableMap.tasks, taskFieldsList, '任務');

  const expSchemas = await getTableFieldSchemas(token, targetApp, tableMap.expenses, fieldCache);
  const expAllowed = expSchemas.allowedSet;
  const expMeta = expSchemas.fieldMeta;
  const expProjField = pickProjectLinkFieldName(expAllowed);
  const expFieldsList = bundle.expenses.map(function(e) {
    const overrides = {};
    const oldWi = getLinkIds(e.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && expAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    if (expProjField) overrides[expProjField] = [newProjId];
    return buildArchiveRecordFields(cloneFields(e.fields), expAllowed, expMeta, overrides);
  });
  await batchCreateRecords(token, targetApp, tableMap.expenses, expFieldsList, '支出');

  const desSchemas = await getTableFieldSchemas(token, targetApp, tableMap.designs, fieldCache);
  const desAllowed = desSchemas.allowedSet;
  const desMeta = desSchemas.fieldMeta;
  const desFieldsList = bundle.designs.map(function(d) {
    const overrides = {};
    const oldWi = getLinkIds(d.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && desAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    return buildArchiveRecordFields(cloneFields(d.fields), desAllowed, desMeta, overrides);
  });
  await batchCreateRecords(token, targetApp, tableMap.designs, desFieldsList, '設計');

  return { copied: true, newProjectId: newProjId, targetAppToken: targetApp, wikiUrl: finalWikiUrl, createdCopy: !!target.createdCopy };
}

async function archiveProject(token, projectId, wikiUrl) {
  const bundle = await gatherProjectRelated(token, projectId);
  const name = bundle.project.fields['標案名稱'] || '';
  const summary = '工作項目 ' + bundle.workitems.length + ' 筆、任務 ' + bundle.tasks.length + ' 筆、支出 ' + bundle.expenses.length + ' 筆、設計 ' + bundle.designs.length + ' 筆';

  let copiedToWikiBase = false;
  let copyError = '';
  let finalWikiUrl = wikiUrl;
  let createdCopy = false;
  try {
    const copyResult = await copyProjectBundleToWikiBase(token, bundle, wikiUrl);
    copiedToWikiBase = true;
    if (copyResult.wikiUrl) finalWikiUrl = copyResult.wikiUrl;
    createdCopy = !!copyResult.createdCopy;
  } catch (err) {
    copyError = formatArchiveCopyError(err.message || String(err));
  }

  if (copiedToWikiBase) {
    const srcFieldCache = {};
    const srcAllowed = await getTableFieldNameSet(token, APP_TOKEN, TABLES.projects, srcFieldCache);
    const safeUpdate = { '狀態': '封存', '封存摘要': summary };
    if (finalWikiUrl) {
      const wikiNames = pickWikiUrlFieldNames(srcAllowed);
      if (wikiNames.indexOf('知識庫連結') >= 0) safeUpdate['知識庫連結'] = makeWikiLink(finalWikiUrl);
      if (wikiNames.indexOf('封存連結') >= 0) safeUpdate['封存連結'] = finalWikiUrl;
      if (wikiNames.indexOf('Wiki存放位置') >= 0) safeUpdate['Wiki存放位置'] = finalWikiUrl;
      if (wikiNames.indexOf('Wiki連結') >= 0) safeUpdate['Wiki連結'] = finalWikiUrl;
    }
    await updateRecord(token, TABLES.projects, projectId, safeUpdate);
  }

  return {
    ok: copiedToWikiBase,
    projectName: name,
    summary: summary,
    counts: {
      workitems: bundle.workitems.length,
      tasks: bundle.tasks.length,
      expenses: bundle.expenses.length,
      designs: bundle.designs.length
    },
    copiedToWikiBase: copiedToWikiBase,
    createdCopy: createdCopy,
    wikiUrl: finalWikiUrl,
    copyError: copyError,
    wikiNote: copiedToWikiBase
      ? (createdCopy
        ? '已從範本複製新知識庫頁面，並寫入此標案相關資料'
        : '已將此標案相關資料複製至您貼上的知識庫多維表格（結構與後台相同）')
      : (copyError
        ? '標案已封存，但複製至多維表格失敗：' + copyError
        : '標案已封存')
  };
}
 
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

let jsapiTicketCache = { ticket: '', expiresAt: 0 };

async function getJsapiTicket(token) {
  const now = Date.now();
  if (jsapiTicketCache.ticket && jsapiTicketCache.expiresAt > now) {
    return jsapiTicketCache.ticket;
  }
  const res = await fetch(BASE_URL + '/jssdk/ticket/get', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  const data = await res.json();
  if (data.code !== 0 || !data.data || !data.data.ticket) {
    throw new Error(data.msg || '無法取得 jsapi_ticket');
  }
  jsapiTicketCache.ticket = data.data.ticket;
  jsapiTicketCache.expiresAt = now + ((data.data.expire_in || 7000) * 1000) - 60000;
  return jsapiTicketCache.ticket;
}

async function buildJssdkConfig(token, pageUrl) {
  const ticket = await getJsapiTicket(token);
  const nonceStr = Math.random().toString(36).slice(2, 14);
  const timestamp = Math.floor(Date.now() / 1000);
  const url = String(pageUrl || '').split('#')[0];
  const raw = 'jsapi_ticket=' + ticket + '&noncestr=' + nonceStr + '&timestamp=' + timestamp + '&url=' + url;
  const signature = createHash('sha1').update(raw).digest('hex');
  return { ok: true, appId: APP_ID, timestamp: timestamp, nonceStr: nonceStr, signature: signature };
}

async function getAppAccessToken() {
  const res = await fetch(BASE_URL + '/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const data = await res.json();
  const token = data.app_access_token || (data.data && data.data.app_access_token);
  if (!token) throw new Error(data.msg || '無法取得 app_access_token');
  return token;
}

async function loginWithOAuthCode(code, redirectUri) {
  let accessToken = null;
  let lastErr = '';

  try {
    const appToken = await getAppAccessToken();
    const v1Res = await fetch(BASE_URL + '/authen/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + appToken
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code: code })
    });
    const tokenData = await v1Res.json();
    if (tokenData.code === 0 && tokenData.data && tokenData.data.access_token) {
      accessToken = tokenData.data.access_token;
    } else {
      lastErr = tokenData.msg || tokenData.message || JSON.stringify(tokenData);
    }
  } catch (e) {
    lastErr = e.message || lastErr;
  }

  if (!accessToken) {
    throw new Error(lastErr || '無法取得 user_access_token');
  }

  const infoRes = await fetch(BASE_URL + '/authen/v1/user_info', {
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  const info = await infoRes.json();
  if (info.code !== 0) throw new Error(info.msg || '無法取得使用者資訊');

  const u = info.data || {};
  return {
    name: u.name || u.en_name || '',
    enName: u.en_name || '',
    openId: u.open_id || '',
    userId: u.user_id || ''
  };
}

function buildAuthUrl(redirectUri) {
  const q = new URLSearchParams({
    app_id: APP_ID,
    redirect_uri: redirectUri,
    state: 'ximo_pm'
  });
  return BASE_URL + '/authen/v1/index?' + q.toString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { table, recordId, action } = req.query;

  try {
    if (action === 'appid' && req.method === 'GET') {
      const redirectUri = getCanonicalRedirectUri();
      return res.status(200).json({ appId: APP_ID, redirectUri: redirectUri });
    }

    if (action === 'jssdk-config' && req.method === 'GET') {
      const pageUrl = (req.query.url || '').trim();
      if (!pageUrl) return res.status(400).json({ error: 'missing url' });
      const token = await getToken();
      const cfg = await buildJssdkConfig(token, pageUrl);
      return res.status(200).json(cfg);
    }

    if (action === 'auth-url' && req.method === 'GET') {
      const redirect = getCanonicalRedirectUri();
      return res.status(200).json({
        url: buildAuthUrl(redirect),
        appId: APP_ID,
        redirectUri: redirect
      });
    }

    if (action === 'login' && req.method === 'POST') {
      const code = req.body && req.body.code;
      if (!code) return res.status(400).json({ ok: false, error: 'missing code' });
      const redirectUri = (req.body.redirect_uri || '').trim();
      try {
        const user = await loginWithOAuthCode(code, redirectUri);
        return res.status(200).json({ ok: true, user });
      } catch (loginErr) {
        return res.status(400).json({ ok: false, error: loginErr.message || '登入失敗' });
      }
    }

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
          appTokenLen: APP_TOKEN ? APP_TOKEN.length : 0,
          tables: TABLES
        },
        tokenError: lark
      });
    }

    if (action === 'project-bundle' && req.method === 'GET') {
      const pid = req.query.projectId;
      if (!pid) return res.status(400).json({ error: 'missing projectId' });
      const token = await getToken();
      const bundle = await gatherProjectRelated(token, pid);
      const wikiUrl = (req.query.wikiUrl || '').trim();
      let wikiTarget = null;
      let wikiTargetError = '';
      if (wikiUrl) {
        try {
          wikiTarget = await inspectWikiBitableTarget(token, wikiUrl, bundle.project.fields['標案名稱'] || '');
        } catch (err) {
          wikiTargetError = err.message || String(err);
        }
      }
      return res.status(200).json({
        projectName: bundle.project.fields['標案名稱'] || '',
        counts: {
          workitems: bundle.workitems.length,
          tasks: bundle.tasks.length,
          expenses: bundle.expenses.length,
          designs: bundle.designs.length
        },
        wikiTarget: wikiTarget,
        wikiTargetError: wikiTargetError,
        archiveTemplateConfigured: !!WIKI_ARCHIVE_TEMPLATE
      });
    }

    if (action === 'resolve-wiki-bitable' && req.method === 'GET') {
      const wikiUrl = (req.query.url || '').trim();
      if (!wikiUrl) return res.status(400).json({ error: 'missing url' });
      const token = await getToken();
      const wikiTarget = await inspectWikiBitableTarget(token, wikiUrl);
      return res.status(200).json({ ok: true, wikiTarget: wikiTarget });
    }

    if (action === 'archive-project' && req.method === 'POST') {
      const projectId = req.body && req.body.projectId;
      const wikiUrl = (req.body && req.body.wikiUrl || '').trim();
      if (!projectId) return res.status(400).json({ error: 'missing projectId' });
      if (!wikiUrl) return res.status(400).json({ error: 'missing wikiUrl' });
      const token = await getToken();
      const result = await archiveProject(token, projectId, wikiUrl);
      return res.status(200).json(result);
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
      const notifyTo = b.notifyTo || process.env.PAYMENT_NOTIFY_TARGET || '會計';
      const text = [
        '【付款申請待處理】',
        '通知對象：' + notifyTo,
        '申請人：' + (b.applicant || ''),
        '申請部門：' + (b.dept || ''),
        '支付對象：' + (b.payee || ''),
        '事由：' + (b.reason || ''),
        '金額：' + (b.amount || ''),
        printUrl,
        '請點連結確認資料後列印送會計 👇'
      ].join('\n');
      const result = await sendWebhook(text);
      return res.status(200).json({ ok: true, notify: result, notifyTo: notifyTo });
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

    if (req.method === 'DELETE') {
      if (!TABLES[table] || !recordId) return res.status(400).json({ error: 'Invalid params' });
      const result = await deleteRecord(token, TABLES[table], recordId);
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
 
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
 
