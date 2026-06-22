const APP_ID = (process.env.LARK_APP_ID || '').trim();
const APP_SECRET = (process.env.LARK_APP_SECRET || '').trim();
const APP_TOKEN = (process.env.LARK_APP_TOKEN || '').trim();
const BASE_URL = 'https://open.larksuite.com/open-apis';
 
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

const ARCHIVE_TABLE_KEYWORDS = {
  projects: ['標案', '專案', 'project'],
  workitems: ['工作項目', 'workitem'],
  tasks: ['任務', 'task'],
  expenses: ['支出', 'expense', '費用'],
  designs: ['設計', 'design']
};

async function larkApiGet(accessToken, apiPath) {
  const res = await fetch(BASE_URL + apiPath, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'Lark API error');
  return data.data;
}

function extractLarkUrlToken(url) {
  try {
    const u = new URL(String(url || '').trim());
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'wiki' || parts[i] === 'base' || parts[i] === 'docx') {
        return { kind: parts[i], token: parts[i + 1] || '' };
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

async function getWikiNode(accessToken, nodeToken) {
  const data = await larkApiGet(accessToken, '/wiki/v2/spaces/get_node?token=' + encodeURIComponent(nodeToken));
  return data.node;
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
  const node = await getWikiNode(accessToken, nodeToken);
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

  if (parsed.kind === 'docx') {
    const app = await findBitableAppTokenInDocx(accessToken, parsed.token);
    if (!app) throw new Error('文件中找不到嵌入的多維表格');
    return app;
  }

  const wikiToken = parsed.token;
  const node = await getWikiNode(accessToken, wikiToken);
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

async function inspectWikiBitableTarget(accessToken, wikiUrl) {
  const appToken = await resolveBitableAppTokenFromUrl(accessToken, wikiUrl);
  const tables = await listBitableTables(accessToken, appToken);
  const tableMap = await resolveArchiveTableMap(accessToken, appToken);
  const tableNames = {};
  Object.keys(tableMap).forEach(function(key) {
    const found = tables.find(function(t) { return t.table_id === tableMap[key]; });
    tableNames[key] = found ? found.name : tableMap[key];
  });
  return { appToken: appToken, tableNames: tableNames };
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

async function batchCreateRecords(token, appToken, tableId, fieldsList) {
  if (!fieldsList.length) return [];
  const created = [];
  const chunkSize = 100;
  for (let i = 0; i < fieldsList.length; i += chunkSize) {
    const chunk = fieldsList.slice(i, i + chunkSize);
    const url = BASE_URL + '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/batch_create';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: chunk.map(function(fields) { return { fields: fields }; }) })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg || 'batch_create failed');
    if (data.data && data.data.records) created.push.apply(created, data.data.records);
  }
  return created;
}

async function copyProjectBundleToWikiBase(token, bundle, wikiUrl) {
  const targetApp = await resolveBitableAppTokenFromUrl(token, wikiUrl);
  const tableMap = await resolveArchiveTableMap(token, targetApp);
  const projFields = cloneFields(bundle.project.fields);
  projFields['狀態'] = '封存';
  if (wikiUrl) {
    projFields['知識庫連結'] = makeWikiLink(wikiUrl);
    projFields['封存連結'] = wikiUrl;
  }
  const projCreated = await batchCreateRecords(token, targetApp, tableMap.projects, [projFields]);
  const newProjId = projCreated[0] && projCreated[0].record_id;
  if (!newProjId) throw new Error('複製標案至知識庫失敗');

  const wiMap = {};
  const wiFieldsList = bundle.workitems.map(function(wi) {
    const f = cloneFields(wi.fields);
    f['所屬標案'] = [newProjId];
    return f;
  });
  const wiCreated = await batchCreateRecords(token, targetApp, tableMap.workitems, wiFieldsList);
  bundle.workitems.forEach(function(wi, i) {
    if (wiCreated[i]) wiMap[wi.record_id] = wiCreated[i].record_id;
  });

  const taskFieldsList = bundle.tasks.map(function(t) {
    const f = cloneFields(t.fields);
    const oldWi = getLinkIds(t.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi]) f['所屬工作項目'] = [wiMap[oldWi]];
    return f;
  });
  await batchCreateRecords(token, targetApp, tableMap.tasks, taskFieldsList);

  const expFieldsList = bundle.expenses.map(function(e) {
    const f = cloneFields(e.fields);
    const oldWi = getLinkIds(e.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi]) f['所屬工作項目'] = [wiMap[oldWi]];
    f['所數標案'] = [newProjId];
    return f;
  });
  await batchCreateRecords(token, targetApp, tableMap.expenses, expFieldsList);

  const desFieldsList = bundle.designs.map(function(d) {
    const f = cloneFields(d.fields);
    const oldWi = getLinkIds(d.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi]) f['所屬工作項目'] = [wiMap[oldWi]];
    return f;
  });
  await batchCreateRecords(token, targetApp, tableMap.designs, desFieldsList);

  return { copied: true, newProjectId: newProjId, targetAppToken: targetApp };
}

async function archiveProject(token, projectId, wikiUrl) {
  const bundle = await gatherProjectRelated(token, projectId);
  const name = bundle.project.fields['標案名稱'] || '';
  const summary = '工作項目 ' + bundle.workitems.length + ' 筆、任務 ' + bundle.tasks.length + ' 筆、支出 ' + bundle.expenses.length + ' 筆、設計 ' + bundle.designs.length + ' 筆';

  let copiedToWikiBase = false;
  let copyError = '';
  try {
    await copyProjectBundleToWikiBase(token, bundle, wikiUrl);
    copiedToWikiBase = true;
  } catch (err) {
    copyError = err.message || String(err);
  }

  const updateFields = {
    '狀態': '封存',
    '封存摘要': summary
  };
  if (wikiUrl) {
    updateFields['知識庫連結'] = makeWikiLink(wikiUrl);
    updateFields['封存連結'] = wikiUrl;
  }
  await updateRecord(token, TABLES.projects, projectId, updateFields);

  return {
    ok: true,
    projectName: name,
    summary: summary,
    counts: {
      workitems: bundle.workitems.length,
      tasks: bundle.tasks.length,
      expenses: bundle.expenses.length,
      designs: bundle.designs.length
    },
    copiedToWikiBase: copiedToWikiBase,
    copyError: copyError,
    wikiNote: copiedToWikiBase
      ? '已將此標案相關資料複製至您貼上的知識庫多維表格（結構與後台相同）'
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

async function loginWithOAuthCode(code, redirectUri) {
  const baseBody = {
    grant_type: 'authorization_code',
    client_id: APP_ID,
    client_secret: APP_SECRET,
    code: code
  };
  const bodies = [];
  if (redirectUri) bodies.push(Object.assign({}, baseBody, { redirect_uri: redirectUri }));
  bodies.push(baseBody);

  let accessToken = null;
  let lastErr = '';
  for (let i = 0; i < bodies.length; i++) {
    const v2Res = await fetch(BASE_URL + '/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(bodies[i])
    });
    const tokenData = await v2Res.json();
    if (tokenData.code === 0 && tokenData.data && tokenData.data.access_token) {
      accessToken = tokenData.data.access_token;
      break;
    }
    lastErr = tokenData.msg || tokenData.message || '';
  }

  if (!accessToken) {
    const tenant = await getToken();
    const v1Res = await fetch(BASE_URL + '/authen/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tenant
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code: code })
    });
    const tokenData = await v1Res.json();
    accessToken = tokenData.data && tokenData.data.access_token;
    if (!accessToken) lastErr = tokenData.msg || tokenData.message || lastErr;
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
    client_id: APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: 'ximo_pm'
  });
  return 'https://passport.larksuite.com/suite/passport/oauth/authorize?' + q.toString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { table, recordId, action } = req.query;

  try {
    if (action === 'appid' && req.method === 'GET') {
      return res.status(200).json({ appId: APP_ID });
    }

    if (action === 'auth-url' && req.method === 'GET') {
      const redirect = (req.query.redirect_uri || process.env.SITE_URL || '').trim();
      if (!redirect) return res.status(400).json({ error: 'missing redirect_uri' });
      return res.status(200).json({ url: buildAuthUrl(redirect), appId: APP_ID });
    }

    if (action === 'login' && req.method === 'POST') {
      const code = req.body && req.body.code;
      if (!code) return res.status(400).json({ error: 'missing code' });
      const redirectUri = (req.body.redirect_uri || '').trim();
      const user = await loginWithOAuthCode(code, redirectUri);
      return res.status(200).json({ ok: true, user });
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
          wikiTarget = await inspectWikiBitableTarget(token, wikiUrl);
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
        wikiTargetError: wikiTargetError
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
 
