import { createHash } from 'crypto';

const APP_ID = (process.env.LARK_APP_ID || '').trim();
const APP_SECRET = (process.env.LARK_APP_SECRET || '').trim();
const APP_TOKEN = (process.env.LARK_APP_TOKEN || '').trim();
// 付款申請單獨立 Base（會計用），其餘 7 張表仍用上面的 APP_TOKEN
const APP_TOKEN_PAYMENTS = (process.env.LARK_APP_TOKEN_PAYMENTS || '').trim();
const ACC_APP_ID = (process.env.ACC_LARK_APP_ID || 'cli_aa09098841211e17').trim();
const ACC_APP_SECRET = (process.env.ACC_LARK_APP_SECRET || '').trim();
const ACC_APP_TOKEN = (process.env.ACC_LARK_APP_TOKEN || 'EdCtb1I9laEhI9s9DFlj7gkDphe').trim();
const ACC_TABLE_EXPENSES = (process.env.ACC_LARK_EXPENSES_TABLE_ID || 'tbliSHhFiXOPTbL0').trim();
const ACC_TABLE_PROJECTS = (process.env.ACC_LARK_PROJECTS_TABLE_ID || 'tblQ6D2B6PrUNvXn').trim();
const ACC_TABLE_WORKITEMS = (process.env.ACC_LARK_WORKITEMS_TABLE_ID || 'tbl9XgSrDZWqQ74I').trim();
const BASE_URL = 'https://open.larksuite.com/open-apis';

/** OAuth 重定向 URL — 須與 Lark 開發者後台「安全設定 > 重定向 URL」完全一致 */
function normalizeRedirectUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    let path = u.pathname || '/';
    if (path === '/' || path === '/index.html') return u.origin + '/';
    return u.origin + path.replace(/\/$/, '');
  } catch {
    const trimmed = s.replace(/\/$/, '');
    return trimmed ? trimmed + '/' : '';
  }
}

function redirectUriVariants(raw) {
  const list = [];
  const add = function(v) {
    const n = String(v || '').trim();
    if (n && list.indexOf(n) < 0) list.push(n);
  };
  const canonical = normalizeRedirectUri(raw);
  add(canonical);
  if (canonical) {
    add(canonical.replace(/\/$/, ''));
    add(canonical.replace(/\/$/, '') + '/');
  }
  return list;
}

function getCanonicalRedirectUri() {
  const raw = (process.env.LARK_REDIRECT_URI || process.env.SITE_URL || 'https://ximo-pm.vercel.app').trim();
  return normalizeRedirectUri(raw);
}

function getRedirectAllowlist() {
  const list = [];
  redirectUriVariants(getCanonicalRedirectUri()).forEach(function(v) {
    if (list.indexOf(v) < 0) list.push(v);
  });
  const extra = (process.env.LARK_REDIRECT_URI_ALLOWLIST || '').split(',');
  extra.forEach(function(item) {
    redirectUriVariants(item.trim()).forEach(function(v) {
      if (list.indexOf(v) < 0) list.push(v);
    });
  });
  return list;
}

function getRedirectUriForRequest(req) {
  const canonical = getCanonicalRedirectUri();
  const fromQuery = req && req.query && req.query.origin ? String(req.query.origin).trim() : '';
  if (fromQuery) {
    const normalized = normalizeRedirectUri(fromQuery);
    if (getRedirectAllowlist().indexOf(normalized) >= 0) return normalized;
  }
  return canonical;
}
 
// 取得 tenant_access_token（模組內快取，避免同次請求重複換 token）
let _tenantTokenCache = null;
let _membersRecordsCache = null;
const MEMBERS_CACHE_TTL_MS = 3 * 60 * 1000;

async function getToken() {
  const now = Date.now();
  if (_tenantTokenCache && _tenantTokenCache.expiresAt > now + 60000) {
    return _tenantTokenCache.token;
  }
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
  _tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, (data.expire || 7200)) * 1000
  };
  return _tenantTokenCache.token;
}

// 各資料表所屬的 app_token：有 LARK_APP_TOKEN_BACKEND 時，讀寫皆以後台 Base 為準（與 Lark 手動編輯同源）
function getOperationalBitableConfig() {
  const backend = getBackendBitableConfig();
  if (backend && backend.appToken) return backend;
  return getFrontBitableConfig();
}

function tableIdFor(tableKey) {
  const cfg = getOperationalBitableConfig();
  return cfg.tables[tableKey] || TABLES[tableKey] || '';
}

function appTokenForTable(tableKey) {
  return getOperationalBitableConfig().appToken;
}
 
// 讀取表格資料（自動翻頁取回全部記錄）
async function getRecords(token, tableId, appToken, opts) {
  const targetAppToken = appToken || APP_TOKEN;
  var items = [];
  var pageToken = '';
  do {
    var url = BASE_URL + '/bitable/v1/apps/' + targetAppToken + '/tables/' + tableId + '/records?page_size=500';
    if (opts && opts.userIdType) url += '&user_id_type=' + encodeURIComponent(opts.userIdType);
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

async function getRecordById(token, tableId, recordId, appToken, opts) {
  const targetAppToken = appToken || APP_TOKEN;
  let url = BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(targetAppToken)
    + '/tables/' + encodeURIComponent(tableId) + '/records/' + encodeURIComponent(recordId);
  if (opts && opts.userIdType) url += '?user_id_type=' + encodeURIComponent(opts.userIdType);
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  const data = await res.json();
  if (data.code !== 0) throw new Error('Record error: ' + data.msg + ' code:' + data.code);
  return data.data && data.data.record;
}

async function batchGetRecords(token, tableId, recordIds, appToken, opts) {
  const ids = (recordIds || []).filter(Boolean);
  if (!ids.length) return [];
  const targetAppToken = appToken || APP_TOKEN;
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let url = BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(targetAppToken)
      + '/tables/' + encodeURIComponent(tableId) + '/records/batch_get?'
      + chunk.map(function(id) { return 'record_ids=' + encodeURIComponent(id); }).join('&');
    if (opts && opts.userIdType) url += '&user_id_type=' + encodeURIComponent(opts.userIdType);
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.code !== 0) throw new Error('Batch get error: ' + data.msg + ' code:' + data.code);
    if (data.data && data.data.records) out.push.apply(out, data.data.records);
  }
  return out;
}

async function searchRecords(token, tableId, appToken, filter, opts) {
  const targetAppToken = appToken || APP_TOKEN;
  var items = [];
  var pageToken = '';
  do {
    var url = BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(targetAppToken)
      + '/tables/' + encodeURIComponent(tableId) + '/records/search?page_size=500';
    if (opts && opts.userIdType) url += '&user_id_type=' + encodeURIComponent(opts.userIdType);
    if (pageToken) url += '&page_token=' + encodeURIComponent(pageToken);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filter: filter })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error('Search error: ' + data.msg + ' code:' + data.code);
    if (data.data && data.data.items) items = items.concat(data.data.items);
    pageToken = data.data && data.data.has_more ? (data.data.page_token || '') : '';
  } while (pageToken);
  return items;
}

function mergeRecordsById() {
  const seen = {};
  const out = [];
  for (let a = 0; a < arguments.length; a++) {
    (arguments[a] || []).forEach(function(r) {
      if (!r || !r.record_id || seen[r.record_id]) return;
      seen[r.record_id] = 1;
      out.push(r);
    });
  }
  return out;
}

async function searchRecordsByLinkFieldsAny(token, tableId, fieldName, recordIds, appToken, opts) {
  const ids = (recordIds || []).filter(Boolean);
  if (!ids.length) return [];
  const chunkSize = 20;
  let merged = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const filter = {
      conjunction: 'or',
      conditions: chunk.map(function(id) {
        return { field_name: fieldName, operator: 'contains', value: [id] };
      })
    };
    const rows = await searchRecords(token, tableId, appToken, filter, opts);
    merged = mergeRecordsById(merged, rows);
  }
  return merged;
}
 
// 新增記錄
function buildMainRecordUrl(tableId, recordId, appToken, asUser) {
  const targetAppToken = appToken || APP_TOKEN;
  let path = '/bitable/v1/apps/' + encodeURIComponent(targetAppToken) + '/tables/' + encodeURIComponent(tableId) + '/records';
  if (recordId) path += '/' + encodeURIComponent(recordId);
  if (asUser) path += '?user_id_type=open_id';
  return BASE_URL + path;
}

function formatLarkWriteError(action, data) {
  const msg = (data && data.msg) || action + ' failed';
  const code = data && data.code;
  if (/forbidden/i.test(msg)) {
    return 'Forbidden（Lark 拒絕寫入）。請確認：① 多維表格已「添加文件應用」且為可管理；② 若開啟「高级权限／進階權限」，需允許應用或你的帳號新增記錄；③ 開發者後台 bitable:app 已發布。' + (code ? ' code:' + code : '');
  }
  return msg + (code ? ' (code:' + code + ')' : '');
}

async function createRecord(token, tableId, fields, appToken, asUser) {
  const url = buildMainRecordUrl(tableId, null, appToken, asUser);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: fields })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(formatLarkWriteError('create', data));
  return data;
}

// 更新記錄
async function updateRecord(token, tableId, recordId, fields, appToken, asUser) {
  const url = buildMainRecordUrl(tableId, recordId, appToken, asUser);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: fields })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(formatLarkWriteError('update', data));
  return data;
}

// 刪除記錄
async function deleteRecord(token, tableId, recordId, appToken, asUser) {
  const url = buildMainRecordUrl(tableId, recordId, appToken, asUser);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || 'delete failed');
  return data;
}

// 多維表格寫入：優先用應用 tenant token（已添加文件應用），失敗再試登入者 user token
async function writeWithUserFallback(tenantToken, userToken, writeFn) {
  const errors = [];
  try {
    return await writeFn(tenantToken, false);
  } catch (tenantErr) {
    errors.push('應用：' + (tenantErr.message || String(tenantErr)));
  }
  if (userToken) {
    try {
      return await writeFn(userToken, true);
    } catch (userErr) {
      errors.push('使用者：' + (userErr.message || String(userErr)));
    }
  }
  throw new Error(errors.join('；') || '寫入失敗');
}

// AI 分析等需記「觸發人」的寫入：優先用登入者 user token，避免紀錄變成應用機器人
async function writePreferUserFirst(tenantToken, userToken, writeFn) {
  const errors = [];
  if (userToken) {
    try {
      return await writeFn(userToken, true);
    } catch (userErr) {
      errors.push('使用者：' + (userErr.message || String(userErr)));
    }
  }
  try {
    return await writeFn(tenantToken, false);
  } catch (tenantErr) {
    errors.push('應用：' + (tenantErr.message || String(tenantErr)));
  }
  throw new Error(errors.join('；') || '寫入失敗');
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

// 各表 table_id：兩套獨立 Lark Base 用 LARK_TABLE_PROFILE 切換（joanne | yd），或單表用 LARK_TABLE_* 覆寫
// LARK_APP_TOKEN = 主要多維表格 base 的 app_token
const TABLE_PROFILES = {
  joanne: {
    projects:  'tbl8ldUZKRcteYFu',
    workitems: 'tblc5QbFf04I3DFl',
    tasks:     'tbl7mC8KaVVXQOVG',
    expenses:  'tblsUdkQN56T6Jnk',
    payments:  'tblv9SmBvbhxNftU',
    designs:   'tbluS9ppqTwA72vd',
    design_versions: 'tblAL5SlqdzByAPg',
    journal:   'tblVs9L5WAJcE2a3',
    members:   'tblIHdb6u6S2xdJH',
    milestones: 'tblhESKN2KGGx9zx'
  },
  yd: {
    projects:  'tblM49Vzl0ZgKGDa',
    workitems: 'tbl9wBZj2UXXmuQv',
    tasks:     'tblqmQCM0N5KFtBH',
    expenses:  'tbl72u0sONmWjZn2',
    payments:  'tblxn7BG7bllcpk0',
    designs:   'tblgtz8A3sqbaj6C',
    design_versions: 'tblmOSQnOUlh0xTW',
    journal:   'tbl4Q2bKqkfGm0t6',
    members:   'tblrXjQ5GOLfzWrQ',
    milestones: 'tblhESKN2KGGx9zx'
  }
};

function resolveTableProfileKey() {
  const raw = (process.env.LARK_TABLE_PROFILE || 'joanne').trim().toLowerCase();
  if (TABLE_PROFILES[raw]) return raw;
  return 'joanne';
}

function buildTables() {
  const profileKey = resolveTableProfileKey();
  const base = TABLE_PROFILES[profileKey];
  const out = {};
  Object.keys(base).forEach(function(key) {
    const envKey = 'LARK_TABLE_' + key.toUpperCase();
    out[key] = (process.env[envKey] || base[key] || '').trim();
  });
  return out;
}

const TABLES = buildTables();
// AI 分析表——不放進 TABLE_PROFILES，因為只有這個 Base 有這張表
TABLES.ai_analysis = (process.env.LARK_TABLE_AI_ANALYSIS || 'tblzMPq8qJ0SiPnN').trim();
// 履約里程碑獨立表（可用 LARK_TABLE_MILESTONES 覆寫）
TABLES.milestones = (process.env.LARK_TABLE_MILESTONES || TABLES.milestones || 'tblhESKN2KGGx9zx').trim();
const PAYMENTS_TABLE_MAIN = (process.env.LARK_TABLE_PAYMENTS_MAIN || '').trim();
const PAYMENTS_TABLE_ACCOUNTING = (process.env.LARK_TABLE_PAYMENTS_ACCOUNTING || '').trim();

function getFrontBitableConfig() {
  return { appToken: APP_TOKEN, tables: TABLES };
}

function getBackendBitableConfig() {
  const appToken = (process.env.LARK_APP_TOKEN_BACKEND || '').trim();
  if (!appToken) return null;
  const profileKey = (process.env.LARK_TABLE_PROFILE_BACKEND || resolveTableProfileKey()).trim().toLowerCase();
  const profile = TABLE_PROFILES[profileKey] || TABLE_PROFILES.joanne;
  const tables = {};
  Object.keys(profile).forEach(function(key) {
    const envKey = 'LARK_TABLE_BACKEND_' + key.toUpperCase();
    tables[key] = (process.env[envKey] || profile[key] || '').trim();
  });
  tables.milestones = (process.env.LARK_TABLE_BACKEND_MILESTONES || process.env.LARK_TABLE_MILESTONES || tables.milestones || TABLES.milestones || '').trim();
  return { appToken: appToken, tables: tables };
}

/** 寫入目標：primary = 前台讀取來源；mirrors = 另一套 Base（需設 LARK_APP_TOKEN_BACKEND） */
function getBitableWriteTargets() {
  const primary = getOperationalBitableConfig();
  const front = getFrontBitableConfig();
  const backend = getBackendBitableConfig();
  const mirrors = [];
  const seen = {};
  if (primary && primary.appToken) seen[primary.appToken] = true;
  if (front.appToken && !seen[front.appToken]) {
    mirrors.push(front);
    seen[front.appToken] = true;
  }
  if (backend && backend.appToken && !seen[backend.appToken]) {
    mirrors.push(backend);
    seen[backend.appToken] = true;
  }
  return { primary: primary, mirrors: mirrors };
}

function cfgDataLabel(cfg) {
  const backend = getBackendBitableConfig();
  const front = getFrontBitableConfig();
  if (backend && cfg.appToken === backend.appToken) return '後台';
  if (cfg.appToken === front.appToken) return '前台';
  return '資料庫';
}

const TABLE_NAME_KEYWORDS = {
  projects: ['標案', '專案', 'project'],
  workitems: ['工作項目', 'workitem'],
  tasks: ['任務', 'task'],
  expenses: ['支出', 'expense', '費用'],
  designs: ['設計需求', '設計', 'design'],
  design_versions: ['設計版本', '版本紀錄'],
  members: ['人員', '成員', 'member'],
  journal: ['日誌', 'journal', '工作日誌'],
  payments: ['付款', '金費'],
  milestones: ['履約', '里程碑', 'milestone']
};

function formatBitableWriteError(cfg, err) {
  const label = cfgDataLabel(cfg);
  const msg = (err && err.message) || String(err || '');
  const envName = label === '後台' ? 'LARK_APP_TOKEN_BACKEND' : 'LARK_APP_TOKEN';
  if (msg.indexOf('NOTEXIST') >= 0) {
    return label + '資料庫：找不到 Base 或無權限（NOTEXIST）。請確認 ' + envName + ' 是多維表格網址 /base/ 後面那段 app_token（不是 table_id），且 Lark 應用已加入該 Base。';
  }
  if (msg.indexOf('TableIdNotFound') >= 0 || msg.indexOf('1254041') >= 0) {
    return label + '資料庫：表格 ID 不符（TableIdNotFound）。請設 LARK_TABLE_PROFILE' + (label === '後台' ? '_BACKEND' : '') + '。';
  }
  return label + '資料庫：' + msg;
}

function extractRecordId(res) {
  if (!res || !res.data) return null;
  const d = res.data;
  if (d.record && d.record.record_id) return d.record.record_id;
  if (d.record_id) return d.record_id;
  if (d.records && d.records[0] && d.records[0].record_id) return d.records[0].record_id;
  return null;
}

function isValidPersonOpenId(id) {
  const s = String(id || '').trim();
  return /^ou_/i.test(s) || /^on_/i.test(s);
}

function stripPersonTypeFields(body, fieldMeta) {
  const out = Object.assign({}, body || {});
  Object.keys(out).forEach(function(name) {
    const meta = fieldMeta[name];
    if (meta && meta.type === 11) delete out[name];
  });
  return out;
}

function isRetryableWriteError(err) {
  const msg = (err && err.message) || String(err || '');
  return /forbidden/i.test(msg)
    || /UserFieldConvFail/i.test(msg)
    || /1254066/i.test(msg)
    || /91403/i.test(msg)
    || /Field types do not match|ConvFail/i.test(msg);
}

async function enrichPersonFieldsForWrite(tenantToken, cfg, rawFields) {
  const out = Object.assign({}, rawFields || {});
  const personKeys = ['主PM', '負責PM', '負責夥伴', '執行夥伴', '負責人', '設計師', '申請人'];
  let members = null;

  async function loadMembers() {
    if (members) return members;
    const membersTableId = cfg.tables.members;
    if (!membersTableId) return [];
    try {
      members = await getRecords(tenantToken, membersTableId, cfg.appToken);
    } catch (e) {
      members = [];
    }
    return members;
  }

  for (let i = 0; i < personKeys.length; i++) {
    const key = personKeys[i];
    if (out[key] === undefined || out[key] === null || out[key] === '') continue;
    const norm = normalizePersonFieldValue(out[key]);
    if (norm && norm[0] && isValidPersonOpenId(norm[0].id)) {
      out[key] = norm;
      continue;
    }
    let nameHint = personDisplayName(out[key]);
    if (!nameHint && typeof out[key] === 'string') nameHint = out[key].trim();
    if (nameHint) {
      const list = await loadMembers();
      for (let j = 0; j < list.length; j++) {
        const mf = list[j].fields || {};
        const mn = getMemberName(mf);
        if (mn && namesMatch(mn, nameHint)) {
          const openId = getMemberPersonOpenId(mf);
          if (isValidPersonOpenId(openId)) {
            out[key] = [{ id: openId }];
            break;
          }
        }
      }
    }
    const again = normalizePersonFieldValue(out[key]);
    if (!again || !again[0] || !isValidPersonOpenId(again[0].id)) delete out[key];
  }
  return out;
}

async function createNormalizedRecord(tenantToken, userToken, cfg, tableKey, rawFields) {
  const tableId = cfg.tables[tableKey];
  if (!tableId) throw new Error('找不到資料表：' + tableKey);
  const enriched = await enrichPersonFieldsForWrite(tenantToken, cfg, rawFields);
  const schemaCache = {};
  const schemas = await getTableFieldSchemas(tenantToken, cfg.appToken, tableId, schemaCache);
  const body = await normalizeWriteFields(tenantToken, tableId, enriched, cfg.appToken);
  const bodyNoPerson = stripPersonTypeFields(body, schemas.fieldMeta);

  const attempts = [];
  if (Object.keys(body).length) {
    attempts.push({ token: tenantToken, asUser: false, fields: body, label: '應用' });
  }
  if (Object.keys(bodyNoPerson).length && JSON.stringify(bodyNoPerson) !== JSON.stringify(body)) {
    attempts.push({ token: tenantToken, asUser: false, fields: bodyNoPerson, label: '應用(略過人員欄位)' });
  }
  if (userToken) {
    if (Object.keys(body).length) {
      attempts.push({ token: userToken, asUser: true, fields: body, label: '使用者' });
    }
    if (Object.keys(bodyNoPerson).length) {
      attempts.push({ token: userToken, asUser: true, fields: bodyNoPerson, label: '使用者(略過人員欄位)' });
    }
  }

  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    try {
      const result = await createRecord(att.token, tableId, att.fields, cfg.appToken, att.asUser);
      const id = extractRecordId(result);
      if (!id) throw new Error('建立記錄失敗：' + tableKey);
      return { id: id, result: result, personOmitted: att.fields !== body };
    } catch (err) {
      if (!isRetryableWriteError(err)) throw err;
      errors.push(att.label + '：' + (err.message || String(err)));
    }
  }
  throw new Error(errors.join('；') || '寫入失敗');
}

async function updateNormalizedRecord(tenantToken, userToken, cfg, tableKey, recordId, rawFields) {
  const tableId = cfg.tables[tableKey];
  if (!tableId) throw new Error('找不到資料表：' + tableKey);
  const body = await normalizeWriteFields(tenantToken, tableId, rawFields, cfg.appToken);
  return writeWithUserFallback(tenantToken, userToken, function(tok, asUser) {
    return updateRecord(tok, tableId, recordId, body, cfg.appToken, asUser);
  });
}

async function findProjectIdByName(token, cfg, name) {
  const trim = String(name || '').trim();
  if (!trim) return null;
  const tableId = cfg.tables.projects;
  if (!tableId) return null;
  const records = await getRecords(token, tableId, cfg.appToken);
  const hit = records.find(function(r) {
    return String((r.fields || {})['標案名稱'] || '').trim() === trim;
  });
  return hit ? hit.record_id : null;
}

async function appendWorkItemsToProject(tenantToken, userToken, cfg, projId, workItemFieldsList) {
  const projRecords = await getRecords(tenantToken, cfg.tables.projects, cfg.appToken);
  const projRec = projRecords.find(function(r) { return r.record_id === projId; });
  if (!projRec) throw new Error('找不到標案');

  const wiIds = [];
  for (let i = 0; i < workItemFieldsList.length; i++) {
    const linked = Object.assign({}, workItemFieldsList[i]);
    linked['所屬標案'] = [projId];
    const wi = await createNormalizedRecord(tenantToken, userToken, cfg, 'workitems', linked);
    wiIds.push(wi.id);
  }
  if (wiIds.length) {
    const existingIds = getLinkIds((projRec.fields || {})['工作項目']);
    const merged = existingIds.slice();
    wiIds.forEach(function(id) { if (merged.indexOf(id) < 0) merged.push(id); });
    await updateNormalizedRecord(tenantToken, userToken, cfg, 'projects', projId, { '工作項目': merged });
  }
  return wiIds;
}

async function mirrorProjectBundleToCfg(tenantToken, userToken, cfg, projectFields, workItemFieldsList) {
  const proj = await createNormalizedRecord(tenantToken, userToken, cfg, 'projects', projectFields);
  const wiIds = [];
  for (let i = 0; i < workItemFieldsList.length; i++) {
    const linked = Object.assign({}, workItemFieldsList[i]);
    linked['所屬標案'] = [proj.id];
    const wi = await createNormalizedRecord(tenantToken, userToken, cfg, 'workitems', linked);
    wiIds.push(wi.id);
  }
  if (wiIds.length) {
    await updateNormalizedRecord(tenantToken, userToken, cfg, 'projects', proj.id, { '工作項目': wiIds });
  }
  return { id: proj.id, result: proj.result, workItemIds: wiIds };
}

async function createProjectImportBundle(tenantToken, userToken, projectFields, workItemFieldsList) {
  const targets = getBitableWriteTargets();
  const mirrorErrors = [];

  const primary = await resolveBitableConfig(tenantToken, targets.primary);
  const primaryBundle = await mirrorProjectBundleToCfg(
    tenantToken, userToken, primary, projectFields, workItemFieldsList
  );

  for (let i = 0; i < targets.mirrors.length; i++) {
    let cfg = targets.mirrors[i];
    try {
      cfg = await resolveBitableConfig(tenantToken, cfg);
      await mirrorProjectBundleToCfg(tenantToken, userToken, cfg, projectFields, workItemFieldsList);
    } catch (err) {
      mirrorErrors.push(formatBitableWriteError(cfg, err));
    }
  }

  const out = Object.assign({}, primaryBundle.result || {});
  out.projectId = primaryBundle.id;
  out.workItemIds = primaryBundle.workItemIds;
  if (mirrorErrors.length) out.partialErrors = mirrorErrors;
  return out;
}

async function createWorkItemsBundle(tenantToken, userToken, primaryProjId, workItemFieldsList) {
  const targets = getBitableWriteTargets();
  const mirrorErrors = [];

  const primary = await resolveBitableConfig(tenantToken, targets.primary);
  const projRecords = await getRecords(tenantToken, primary.tables.projects, primary.appToken);
  const projRec = projRecords.find(function(r) { return r.record_id === primaryProjId; });
  if (!projRec) throw new Error('找不到標案');
  const projName = String((projRec.fields || {})['標案名稱'] || '').trim();

  const wiIds = await appendWorkItemsToProject(
    tenantToken, userToken, primary, primaryProjId, workItemFieldsList
  );

  for (let i = 0; i < targets.mirrors.length; i++) {
    let cfg = targets.mirrors[i];
    try {
      cfg = await resolveBitableConfig(tenantToken, cfg);
      let mirrorProjId = primaryProjId;
      if (cfg.appToken !== primary.appToken) {
        mirrorProjId = await findProjectIdByName(tenantToken, cfg, projName);
        if (!mirrorProjId) throw new Error('找不到標案「' + projName + '」');
      }
      await appendWorkItemsToProject(tenantToken, userToken, cfg, mirrorProjId, workItemFieldsList);
    } catch (err) {
      mirrorErrors.push(formatBitableWriteError(cfg, err));
    }
  }

  const out = { code: 0, workItemIds: wiIds };
  if (mirrorErrors.length) out.partialErrors = mirrorErrors;
  return out;
}

function parseBitableShareUrl(url) {
  const out = { appToken: '', tableId: '' };
  if (!url) return out;
  const s = String(url).trim();
  const baseMatch = s.match(/\/base\/([A-Za-z0-9]+)/);
  if (baseMatch) out.appToken = baseMatch[1];
  const tableMatch = s.match(/[?&]table=([A-Za-z0-9]+)/);
  if (tableMatch) out.tableId = tableMatch[1];
  return out;
}

function paymentsFrontConfig() {
  const fromUrl = parseBitableShareUrl(process.env.LARK_PAYMENTS_FRONTEND_URL || '');
  return {
    appToken: (process.env.LARK_APP_TOKEN_PAYMENTS_FRONTEND || fromUrl.appToken || APP_TOKEN).trim(),
    tableId: (PAYMENTS_TABLE_MAIN || fromUrl.tableId || TABLES.payments).trim()
  };
}

function paymentsAccountingConfig() {
  const fromUrl = parseBitableShareUrl(process.env.LARK_PAYMENTS_ACCOUNTING_URL || '');
  return {
    appToken: (APP_TOKEN_PAYMENTS || fromUrl.appToken || '').trim(),
    tableId: (PAYMENTS_TABLE_ACCOUNTING || fromUrl.tableId || TABLES.payments).trim()
  };
}
const ARCHIVE_OAUTH_SCOPES = 'wiki:wiki wiki:node:read bitable:app';

const ARCHIVE_TABLE_KEYWORDS = {
  projects: ['標案', '專案', 'project'],
  workitems: ['工作項目', 'workitem'],
  tasks: ['任務', 'task'],
  expenses: ['支出', 'expense', '費用'],
  designs: ['設計需求', '設計', 'design'],
  design_versions: ['設計版本', '版本紀錄'],
  milestones: ['履約', '里程碑', 'milestone']
};

const OPERATIONAL_TABLE_KEYWORDS = Object.assign({}, ARCHIVE_TABLE_KEYWORDS, {
  members: ['人員', '成員', 'member', '用戶', '員工'],
  journal: ['日誌', 'journal', '工作日誌'],
  payments: ['付款', '金費'],
  milestones: ['履約', '里程碑', 'milestone'],
  design_versions: ['設計版本', '版本紀錄']
});

const bitableConfigResolveCache = {};

async function resolveTableMapForApp(token, appToken, configuredTables) {
  let listed;
  try {
    listed = await listBitableTables(token, appToken);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.indexOf('NOTEXIST') >= 0) {
      throw new Error('找不到 Base 或 Lark 應用無權限（NOTEXIST）。請確認 app_token 正確且應用已加入該多維表格');
    }
    throw err;
  }
  const idSet = {};
  listed.forEach(function(t) {
    const id = t.table_id || t.id || '';
    if (id) idSet[id] = true;
  });
  const out = {};
  const keys = Object.keys(configuredTables || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const configuredId = String(configuredTables[key] || '').trim();
    if (configuredId && idSet[configuredId]) {
      out[key] = configuredId;
      continue;
    }
    const profileKeys = Object.keys(TABLE_PROFILES);
    for (let p = 0; p < profileKeys.length; p++) {
      const altId = (TABLE_PROFILES[profileKeys[p]][key] || '').trim();
      if (altId && idSet[altId]) {
        out[key] = altId;
        break;
      }
    }
    if (out[key]) continue;
    const keywords = OPERATIONAL_TABLE_KEYWORDS[key];
    if (keywords) {
      const matched = matchArchiveTableByKeywords(listed, keywords);
      if (matched) {
        out[key] = matched.table_id || matched.id || '';
        continue;
      }
    }
    if (configuredId) out[key] = configuredId;
  }
  return out;
}

async function resolveBitableConfig(token, cfg) {
  if (!cfg || !cfg.appToken) return cfg;
  const tables = await resolveTableMapForApp(token, cfg.appToken, cfg.tables);
  return { appToken: cfg.appToken, tables: tables };
}

async function resolveBitableConfigCached(token, cfg) {
  if (!cfg || !cfg.appToken) return cfg;
  const key = cfg.appToken;
  if (bitableConfigResolveCache[key]) return bitableConfigResolveCache[key];
  const resolved = await resolveBitableConfig(token, cfg);
  bitableConfigResolveCache[key] = resolved;
  return resolved;
}

function requireWikiUserToken(userAccessToken) {
  const t = String(userAccessToken || '').trim();
  if (!t) {
    throw new Error('請先 Lark 登入以取得知識庫授權（知識庫操作無法使用應用身分，否則會出現 tenant needs read permission）');
  }
  return t;
}

function formatArchiveCopyError(msg) {
  const s = String(msg || '').trim();
  if (!s) return s;
  if (/LARK_WIKI_ARCHIVE_TEMPLATE|知識庫內範本/i.test(s)) return s;
  if (/wiki:wiki|wiki:node|Access denied/i.test(s)) {
    return s + '。請確認：① 開發者後台已發布 wiki:wiki、bitable:app；② 已設定 LARK_WIKI_ARCHIVE_TEMPLATE（wiki 範本連結）；③ 重新 Lark 登入。';
  }
  if (/not found/i.test(s)) {
    return '找不到知識庫頁面或範本。請確認封存位置與 LARK_WIKI_ARCHIVE_TEMPLATE 連結正確。';
  }
  if (/FieldNameNotFound/i.test(s)) {
    if (/標案|projects|狀態|封存摘要/i.test(s)) {
      return '後台標案表缺少部分欄位（如「封存摘要」或連結欄位），資料可能已寫入知識庫。請在後台將標案狀態改為「封存」。';
    }
    return '範本欄位與後台不一致。請從現行後台複製最新範本至知識庫並更新 LARK_WIKI_ARCHIVE_TEMPLATE。';
  }
  if (/Duplex Link|UserFieldConvFail|WrongRequestBody|Field types do not match|ConvFail/i.test(s)) {
    return s + '（欄位格式問題，請確認範本與後台結構一致後再封存）';
  }
  return s;
}

async function parseLarkJsonResponse(res, apiPath) {
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error('Lark API 空回應（' + apiPath + ', HTTP ' + res.status + '）');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Lark API 回應非 JSON（' + apiPath + ', HTTP ' + res.status + '）：' + text.slice(0, 160));
  }
}

async function larkApiGet(accessToken, apiPath) {
  const res = await fetch(BASE_URL + apiPath, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await parseLarkJsonResponse(res, apiPath);
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
  const data = await parseLarkJsonResponse(res, apiPath);
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

function buildWikiAccessTokens(userToken, tenantToken) {
  const tokens = [];
  const userTok = String(userToken || '').trim();
  const tenantTok = String(tenantToken || '').trim();
  if (userTok) tokens.push(userTok);
  if (tenantTok && tenantTok !== userTok) tokens.push(tenantTok);
  return tokens;
}

function resolveWikiParentTargetFromUrl(wikiUrl) {
  const normalized = normalizeWikiInputUrl(wikiUrl);
  const parsed = extractLarkUrlToken(normalized);
  if (!parsed || !parsed.token) return null;
  if (parsed.kind === 'wiki_space') {
    return { space_id: parsed.token, node_token: '', wikiUrl: normalized };
  }
  return null;
}

async function resolveWikiParentTarget(accessToken, wikiUrl) {
  const normalized = normalizeWikiInputUrl(wikiUrl);
  const parsed = extractLarkUrlToken(normalized);
  if (!parsed || !parsed.token) {
    throw new Error('知識庫存放位置連結無效。請貼完整網址，例如：https://…/wiki/space/7650032628065668632');
  }

  if (parsed.kind === 'wiki_space') {
    return { space_id: parsed.token, node_token: '', wikiUrl: normalized };
  }

  if (parsed.kind === 'wiki') {
    const node = await getWikiNode(accessToken, parsed.token, 'Wiki 封存位置');
    if (!node) throw new Error('找不到知識庫存放位置');
    return { space_id: node.space_id, node_token: node.node_token, node: node, wikiUrl: normalized };
  }

  if (parsed.kind === 'base') {
    throw new Error('這是 /base/ 多維表格連結，不是知識庫連結。請改貼 wiki/space/… 或 wiki/節點ID');
  }

  if (parsed.token) {
    try {
      const node = await getWikiNode(accessToken, parsed.token, 'Wiki 封存位置');
      if (node) {
        return { space_id: node.space_id, node_token: node.node_token, node: node, wikiUrl: normalized };
      }
    } catch (e) { /* try next */ }
  }

  throw new Error('Wiki 封存位置須為 wiki/space/… 或 wiki/節點ID 連結（不能是 /base/ 連結）');
}

async function copyArchiveViaWikiTemplate(tenantToken, parent, title, wikiTemplateUrl, wikiTok, parentWikiUrl) {
  const templateParsed = extractLarkUrlToken(wikiTemplateUrl);
  if (!templateParsed || !templateParsed.token) throw new Error('知識庫封存範本連結無效');

  const wikiTokens = buildWikiAccessTokens(wikiTok, tenantToken);
  let templateNode = null;
  const nodeErrors = [];
  for (let i = 0; i < wikiTokens.length; i++) {
    try {
      templateNode = await getWikiNode(wikiTokens[i], templateParsed.token, '封存範本');
      if (templateNode) break;
    } catch (e) {
      nodeErrors.push((i === 0 ? 'user' : 'app') + ':' + (e.message || String(e)));
    }
  }
  if (!templateNode) {
    throw new Error('找不到知識庫封存範本。請確認範本頁面 wiki 連結正確。' + (nodeErrors.length ? ' ' + nodeErrors.join(' | ') : ''));
  }

  const copyOpts = { targetSpaceId: parent.space_id, title: title };
  if (parent.node_token) copyOpts.targetParentToken = parent.node_token;

  const copyErrors = [];
  let copied = null;
  for (let j = 0; j < wikiTokens.length; j++) {
    try {
      copied = await copyWikiNode(wikiTokens[j], templateNode.space_id, templateNode.node_token, copyOpts);
      if (copied) break;
    } catch (e) {
      copyErrors.push((j === 0 ? 'user' : 'app') + ':' + (e.message || String(e)));
    }
  }
  if (!copied || !copied.node_token) {
    throw new Error(
      '無法在知識庫內複製封存範本（需要 wiki:wiki 或 wiki:node:copy）。'
      + (copyErrors.length ? ' ' + copyErrors.join(' | ') : '')
      + ' 請確認：① 開發者後台已開通 wiki:wiki 並發布；② 重新 Lark 登入；③ 您對目標知識庫有編輯權限。'
    );
  }

  let appToken = '';
  let tableMap = null;
  let wikiUrlOut = buildWikiNodeUrl(parent.wikiUrl || parentWikiUrl, copied.node_token);
  const resolveErrors = [];
  for (let k = 0; k < wikiTokens.length; k++) {
    try {
      const resolved = await resolveBitableFromWikiNode(wikiTokens[k], copied, parentWikiUrl);
      appToken = resolved.appToken;
      tableMap = await resolveArchiveTableMap(tenantToken, appToken);
      wikiUrlOut = resolved.wikiUrl || wikiUrlOut;
      break;
    } catch (e) {
      resolveErrors.push((k === 0 ? 'user' : 'app') + ':' + (e.message || String(e)));
    }
  }
  if (!appToken || !tableMap) {
    throw new Error('範本已複製到知識庫，但無法讀取其中的多維表格。' + (resolveErrors.length ? ' ' + resolveErrors.join(' | ') : ''));
  }

  return {
    appToken: appToken,
    tableMap: tableMap,
    wikiUrl: wikiUrlOut,
    wikiFolderUrl: parentWikiUrl
  };
}

async function copyArchiveTemplateToParent(tenantToken, parentWikiUrl, projectName, wikiToken) {
  const wikiTemplateUrl = resolveWikiArchiveTemplateUrl();
  if (!wikiTemplateUrl) {
    throw new Error('請在 Vercel 設定 LARK_WIKI_ARCHIVE_TEMPLATE（已遷入知識庫的範本 wiki 連結）。/base/ 範本無法自動封存。');
  }

  const normalizedFolder = normalizeWikiInputUrl(parentWikiUrl);
  let parent = resolveWikiParentTargetFromUrl(normalizedFolder);
  const wikiTok = String(wikiToken || '').trim();
  if (!parent) {
    if (!wikiTok) throw new Error('請先 Lark 登入（或貼 wiki/space/… 連結）');
    parent = await resolveWikiParentTarget(wikiTok, parentWikiUrl);
  }
  if (!wikiTok) throw new Error('封存至知識庫必須先 Lark 登入');

  const title = projectName || '封存標案';
  return await copyArchiveViaWikiTemplate(tenantToken, parent, title, wikiTemplateUrl, wikiTok, parentWikiUrl);
}

async function resolveOrCreateWikiBitableTarget(tenantToken, wikiUrl, projectName, wikiToken) {
  const wikiTok = requireWikiUserToken(wikiToken);
  const spaceParent = resolveWikiParentTargetFromUrl(wikiUrl);
  if (!spaceParent) {
    try {
      const appToken = await resolveBitableAppTokenFromUrl(wikiTok, wikiUrl);
      await ensureBitableReady(tenantToken, appToken);
      const tableMap = await resolveArchiveTableMap(tenantToken, appToken);
      return { appToken: appToken, tableMap: tableMap, wikiUrl: wikiUrl, wikiFolderUrl: wikiUrl };
    } catch (directErr) {
      if (!isArchiveTemplateConfigured()) throw directErr;
    }
  }
  if (!isArchiveTemplateConfigured()) {
    throw new Error('尚未設定 LARK_WIKI_ARCHIVE_TEMPLATE');
  }
  return await copyArchiveTemplateToParent(tenantToken, wikiUrl, projectName, wikiTok);
}

function normalizeWikiInputUrl(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.charAt(0) === '{') {
    try {
      var o = JSON.parse(s);
      if (o && o.link) s = String(o.link).trim();
    } catch (e) {}
  }
  if (!/^https?:\/\//i.test(s)) {
    if (/wiki\//i.test(s) || /larksuite\.com/i.test(s) || /feishu\.cn/i.test(s)) {
      s = 'https://' + s.replace(/^\/+/, '');
    }
  }
  return s;
}

function isWikiArchiveUrl(url) {
  var s = normalizeWikiInputUrl(url);
  if (!s) return false;
  if (/\/base\//i.test(s)) return false;
  return /\/wiki\/space\/[^/?#]+/i.test(s) || /\/wiki\/(?!space)[^/?#]+/i.test(s);
}

function extractLarkUrlToken(url) {
  const normalized = normalizeWikiInputUrl(url);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'wiki' && parts[i + 1] === 'space' && parts[i + 2]) {
        return { kind: 'wiki_space', token: parts[i + 2] };
      }
      if (parts[i] === 'wiki' || parts[i] === 'base' || parts[i] === 'docx') {
        const next = parts[i + 1] || '';
        if (parts[i] === 'wiki' && next === 'space') continue;
        if (next) return { kind: parts[i], token: next };
      }
    }
    const last = parts[parts.length - 1];
    if (last && last.length >= 8) return { kind: 'unknown', token: last };
  } catch (e) { /* ignore */ }
  return null;
}

function resolveWikiArchiveTemplateUrl() {
  const wikiEnv = normalizeWikiInputUrl(process.env.LARK_WIKI_ARCHIVE_TEMPLATE || '');
  const mainEnv = normalizeWikiInputUrl(process.env.LARK_ARCHIVE_TEMPLATE || '');
  if (wikiEnv) {
    const p = extractLarkUrlToken(wikiEnv);
    if (p && p.kind !== 'base') return wikiEnv;
  }
  if (mainEnv) {
    const p = extractLarkUrlToken(mainEnv);
    if (p && p.kind !== 'base') return mainEnv;
  }
  return '';
}

function isArchiveTemplateConfigured() {
  return !!resolveWikiArchiveTemplateUrl();
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
  '主PM': ['負責PM', 'PM'],
  '負責PM': ['主PM', 'PM'],
  '負責夥伴': ['負責人'],
  '負責人': ['負責夥伴'],
  '設計師': ['Designer'],
  'Wiki存放位置': ['Wiki連結', '知識庫連結', '封存連結'],
  'Wiki連結': ['Wiki存放位置', '知識庫連結', '封存連結'],
  '知識庫連結': ['Wiki連結', 'Wiki存放位置', '封存連結'],
  '封存連結': ['Wiki連結', 'Wiki存放位置', '知識庫連結']
};

const ARCHIVE_PERSON_KEYS = ['主PM', '負責PM', '負責夥伴', '執行夥伴', '負責人', '設計師', '申請人'];

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

function normalizeLinkFieldValue(val) {
  return getLinkIds(val).map(function(id) { return String(id); });
}

function normalizePersonFieldValue(val) {
  if (!val) return null;
  const items = Array.isArray(val) ? val : [val];
  const out = [];
  items.forEach(function(x) {
    if (!x) return;
    if (typeof x === 'string' && x) {
      if (isValidPersonOpenId(x)) out.push({ id: String(x) });
      return;
    }
    if (x && x.id && isValidPersonOpenId(x.id)) out.push({ id: String(x.id) });
    else if (x && x.open_id && isValidPersonOpenId(x.open_id)) out.push({ id: String(x.open_id) });
  });
  return out.length ? out : null;
}

function normalizeArchiveUrlValue(val) {
  if (!val) return null;
  if (typeof val === 'string' && val.trim()) {
    let url = val.trim();
    // NAS／本機路徑不要硬加 https://
    if (/^(\\\\|\/|[A-Za-z]:[\\/])/.test(url) || url.indexOf('\\\\') === 0) {
      return { link: url, text: url.length > 48 ? url.slice(0, 48) + '…' : url };
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const text = url.replace(/^https?:\/\//, '');
    return { link: url, text: text.length > 48 ? text.slice(0, 48) + '…' : text };
  }
  if (val && typeof val === 'object' && val.link) {
    return { link: String(val.link), text: String(val.text || val.link).slice(0, 48) };
  }
  return null;
}

/** NAS 路徑欄：文字欄直接存；超連結欄用可還原的 https 包裝（Lark URL 欄不接受純路徑） */
var NAS_PATH_FIELD_NAMES = {
  'NAS路徑位置': 1,
  '路徑位置': 1
};
var NAS_PATH_URL_PREFIX = 'https://ximo-nas.local/?p=';

function isNasPathFieldName(name) {
  return !!(name && NAS_PATH_FIELD_NAMES[name]);
}

function encodeNasPathForUrlField(path) {
  const s = String(path || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) && s.indexOf('ximo-nas.local') < 0) {
    return { link: s, text: s.length > 80 ? s.slice(0, 80) + '…' : s };
  }
  return {
    link: NAS_PATH_URL_PREFIX + encodeURIComponent(s),
    text: s.length > 80 ? s.slice(0, 80) + '…' : s
  };
}

function normalizeNasPathWriteValue(meta, val) {
  const raw = val == null ? '' : String(val).trim();
  const t = meta && meta.type;
  if (t === 15) {
    if (!raw) return null;
    return encodeNasPathForUrlField(raw);
  }
  // 文字／條碼等
  if (t === 1 || t === 13 || !t) return raw;
  if (typeof val === 'string') return val;
  return raw;
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
  if (typeof val === 'string') {
    const parts = val.split(/[、,，/|]/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (parts.length) return parts;
  }
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

function normalizeAttachmentFieldValue(val) {
  if (!val) return null;
  if (!Array.isArray(val)) return null;
  const out = [];
  val.forEach(function(item) {
    if (!item) return;
    if (typeof item === 'string' && item.trim()) out.push({ file_token: item.trim() });
    else if (item.file_token) out.push({ file_token: String(item.file_token).trim() });
  });
  return out.length ? out : null;
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
    headers: { 'Authorization': 'Bearer ' + token },
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

async function getMediaDownloadUrl(token, fileToken) {
  const res = await fetch(BASE_URL + '/drive/v1/medias/' + encodeURIComponent(fileToken) + '/download', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token },
    redirect: 'manual'
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) return loc;
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (data && data.code === 0 && data.data) {
    return data.data.download_url || data.data.tmp_download_url || '';
  }
  const tmpRes = await fetch(BASE_URL + '/drive/v1/medias/batch_get_tmp_download_url?file_tokens=' + encodeURIComponent(fileToken), {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const tmpData = await tmpRes.json();
  if (tmpData.code === 0 && tmpData.data && tmpData.data.tmp_download_urls && tmpData.data.tmp_download_urls[0]) {
    return tmpData.data.tmp_download_urls[0].tmp_download_url || '';
  }
  throw new Error((data && data.msg) || 'download failed');
}

function normalizeArchiveFieldValue(meta, val) {
  if (val === undefined || val === null) return null;
  if (val === '' && (!meta || meta.type !== 1)) return null;
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
  if (t === 7) {
    if (typeof val === 'boolean') return val;
    if (val === 1 || val === '1' || val === 'true' || val === '是' || val === '已簽核' || val === '已檢核') return true;
    if (val === 0 || val === '0' || val === 'false' || val === '否' || val === '未簽核' || val === '待檢核' || val === '未檢核') return false;
    return null;
  }
  if (t === 13) {
    if (typeof val === 'string') return val;
    return null;
  }
  if (t === 1) {
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (val && typeof val === 'object') {
      if (val.text != null && String(val.text).trim()) return String(val.text);
      if (val.link != null && String(val.link).trim()) {
        let link = String(val.link).trim();
        if (/^https?:\/\/(\\\\|\/|[A-Za-z]:[\\/])/i.test(link)) {
          link = link.replace(/^https?:\/\//i, '');
        }
        return link;
      }
      if (val.url != null && String(val.url).trim()) return String(val.url);
    }
    return null;
  }

  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  return null;
}

function applyWikiUrlOverrides(overrides, allowedSet, fieldMeta, url, onlyNames) {
  if (!url) return;
  const names = onlyNames || ['知識庫連結', '封存連結', 'Wiki存放位置', 'Wiki連結'];
  names.forEach(function(name) {
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
    // Select options differ between PM and wiki tables; person fields need valid open_id.
    if (meta.type === 3 || meta.type === 4) return;
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

function personDisplayName(field) {
  if (!field) return '';
  if (typeof field === 'string') return field.trim();
  const items = Array.isArray(field) ? field : [field];
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x) continue;
    if (typeof x === 'string' && x.trim()) return x.trim();
    if (x.name) return String(x.name).trim();
    if (x.en_name) return String(x.en_name).trim();
    if (x.enName) return String(x.enName).trim();
    if (x.text) return String(x.text).trim();
  }
  return fieldTextValue(field);
}

async function resolvePersonOpenIdFromMembers(tenantToken, rawName) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  const cfg = getOperationalBitableConfig();
  const membersTableId = cfg.tables.members;
  if (!membersTableId) return '';
  let members = [];
  try {
    members = await getRecords(tenantToken, membersTableId, cfg.appToken, { userIdType: 'open_id' });
  } catch (e) {
    return '';
  }
  for (let i = 0; i < members.length; i++) {
    const mf = members[i].fields || {};
    const mn = getMemberName(mf);
    if (mn && namesMatch(mn, name)) {
      const openId = getMemberPersonOpenId(mf);
      if (isValidPersonOpenId(openId)) return openId;
    }
  }
  return '';
}

async function enrichArchivePersonFields(tenantToken, rawFields) {
  const cfg = getOperationalBitableConfig();
  const source = cloneFields(rawFields);
  let out = await enrichPersonFieldsForWrite(tenantToken, cfg, source);
  for (let i = 0; i < ARCHIVE_PERSON_KEYS.length; i++) {
    const key = ARCHIVE_PERSON_KEYS[i];
    const norm = normalizePersonFieldValue(out[key]);
    if (norm && norm[0] && isValidPersonOpenId(norm[0].id)) continue;
    const nameHint = personDisplayName(source[key]);
    if (!nameHint) continue;
    const openId = await resolvePersonOpenIdFromMembers(tenantToken, nameHint);
    if (openId) out[key] = [{ id: openId }];
    else delete out[key];
  }
  return out;
}

async function buildEnrichedArchiveFields(tenantToken, rawFields, allowedSet, fieldMeta, overrides) {
  const enriched = await enrichArchivePersonFields(tenantToken, rawFields);
  const fields = buildArchiveRecordFields(enriched, allowedSet, fieldMeta, overrides || {});
  const personPatch = extractArchivePersonPatch(enriched, allowedSet, fieldMeta);
  return { fields: fields, personPatch: personPatch };
}

function extractArchivePersonPatch(enriched, allowedSet, fieldMeta) {
  const remapped = remapFieldsForTarget(enriched, allowedSet);
  const out = {};
  Object.keys(remapped).forEach(function(name) {
    const meta = fieldMeta[name];
    if (!meta || meta.type !== 11) return;
    const norm = normalizePersonFieldValue(remapped[name]);
    if (norm) out[name] = norm;
  });
  return out;
}

async function patchArchivePersonFields(token, appToken, tableId, recordId, personPatch) {
  if (!personPatch || !Object.keys(personPatch).length || !recordId) return false;
  try {
    await updateBitableRecord(token, appToken, tableId, recordId, personPatch);
    return true;
  } catch (err) {
    if (!isRetryableWriteError(err)) return false;
    let any = false;
    const names = Object.keys(personPatch);
    for (let i = 0; i < names.length; i++) {
      try {
        await updateBitableRecord(token, appToken, tableId, recordId, { [names[i]]: personPatch[names[i]] });
        any = true;
      } catch (e) {}
    }
    return any;
  }
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
  // 履約里程碑為選配：範本尚未建表時不阻擋封存（會改從標案欄位帶出）
  const requiredKeys = Object.keys(ARCHIVE_TABLE_KEYWORDS).filter(function(k) { return k !== 'milestones'; });
  requiredKeys.forEach(function(key) {
    const matched = matchArchiveTableByKeywords(tables, ARCHIVE_TABLE_KEYWORDS[key]);
    if (matched) map[key] = matched.table_id;
    else missing.push(key);
  });
  const msMatched = matchArchiveTableByKeywords(tables, ARCHIVE_TABLE_KEYWORDS.milestones || []);
  if (msMatched) map.milestones = msMatched.table_id;
  if (missing.length) {
    const avail = tables.map(function(t) { return t.name; }).join('、');
    throw new Error('目標多維表格缺少資料表（' + missing.join('、') + '）。現有：' + avail);
  }
  return map;
}

async function normalizeWriteFields(token, tableId, fields, appToken) {
  if (!fields || !tableId) return fields;
  const targetAppToken = appToken || APP_TOKEN;
  const cache = {};
  const schemas = await getTableFieldSchemas(token, targetAppToken, tableId, cache);
  const meta = schemas.fieldMeta;
  const allowed = schemas.allowedSet;
  const out = {};
  const paymentAliases = {
    '申請人': ['申請人員', 'Applicant', '申请人'],
    '所屬標案': ['所數標案', '標案', '所屬專案'],
    '所數標案': ['所屬標案', '標案'],
    '所屬工作項目': ['工作項目'],
    '附件': ['檔案', '上傳附件'],
    '狀態': ['審核狀態'],
    '審批編號': ['審批實例', '審批單號', 'instance_code'],
    '待簽核人': ['待签核人', 'Pending Approver'],
    '會計狀態': ['會計進度', 'Accounting Status'],
    '會計待簽核人': ['會計簽核人'],
    '會計審批編號': ['會計審批實例'],
    '支出明細': ['關聯支出', '支出紀錄']
  };
  // yd 工作項目表欄位為「可用成本未稅」；前端仍寫「可用成本」
  // 設計需求：審核／檢核、路徑欄位名稱在不同 Base 可能不一致
  const fieldAliases = Object.assign({
    '可用成本': ['可用成本未稅'],
    '可用成本未稅': ['可用成本'],
    'PM主管內容審核': ['PM主管內容檢核'],
    'PM主管內容檢核': ['PM主管內容審核'],
    '設計主管圖面檢核': ['設計主管圖面審核'],
    '設計主管圖面審核': ['設計主管圖面檢核'],
    'NAS路徑位置': ['路徑位置'],
    '路徑位置': ['NAS路徑位置'],
    '價格(含稅)': ['含稅價格', '價格含稅'],
    '含稅價格': ['價格(含稅)', '價格含稅'],
    '備註': ['備註（工作細項說明）'],
    '備註（工作細項說明）': ['備註'],
    '設計師備註時間': ['設計師備註更新時間'],
    'PM 回饋時間': ['PM回饋時間', 'PM 回饋更新時間']
  }, paymentAliases);
  const src = Object.assign({}, fields);
  Object.keys(fieldAliases).forEach(function(canonical) {
    if (allowed[canonical]) return;
    fieldAliases[canonical].forEach(function(alt) {
      if (allowed[alt] && src[canonical] !== undefined && src[alt] === undefined) {
        src[alt] = src[canonical];
        delete src[canonical];
      }
    });
  });
  Object.keys(src).forEach(function(name) {
    if (!allowed[name]) return;
    const m = meta[name];
    const val = src[name];
    if (!m) {
      out[name] = val;
      return;
    }
    if (m.type === 5 && val === null) {
      out[name] = null;
      return;
    }
    if (isNasPathFieldName(name)) {
      const nasVal = normalizeNasPathWriteValue(m, val);
      if (nasVal !== undefined && nasVal !== null) out[name] = nasVal;
      else if (val === '' || val === null) {
        // 文字欄可清空；超連結清空略過（Lark 對 URL null 支援不一）
        if (m.type === 1 || m.type === 13) out[name] = '';
      }
      return;
    }
    if (BITABLE_LINK_FIELD_TYPES[m.type]) {
      out[name] = normalizeLinkFieldValue(val);
      return;
    }
    if (m.type === 11) {
      const normalized = normalizePersonFieldValue(val);
      if (normalized) out[name] = normalized;
      return;
    }
    if (m.type === 17) {
      const normalized = normalizeAttachmentFieldValue(val);
      if (normalized) out[name] = normalized;
      return;
    }
    const normalized = normalizeArchiveFieldValue(m, val);
    if (normalized !== null && normalized !== undefined) out[name] = normalized;
  });
  return out;
}

async function enrichPaymentApplicant(tenantToken, userToken, fields, hintOpenId) {
  const raw = fields['申請人'];
  let rawName = typeof raw === 'string' ? raw.trim() : paymentApplicantText(fields);
  if (!rawName && fields._applicantDisplayName) rawName = String(fields._applicantDisplayName).trim();

  let openId = String(hintOpenId || '').trim();
  if (openId && !/^ou_/i.test(openId) && !/^on_/i.test(openId)) openId = '';

  if (!openId && Array.isArray(raw) && raw[0]) {
    const rid = String(raw[0].id || raw[0].open_id || '').trim();
    if (rid && (/^ou_/i.test(rid) || /^on_/i.test(rid))) openId = rid;
    if (!rawName && raw[0].name) rawName = String(raw[0].name).trim();
  }

  if (!openId) {
    openId = await resolveApplicantOpenId(tenantToken, userToken, rawName, hintOpenId);
  }

  if (openId) {
    fields['申請人'] = [{ id: openId }];
    if (!rawName && userToken) {
      try {
        const loginUser = await getUserInfoFromToken(userToken);
        rawName = String(loginUser.name || loginUser.en_name || '').trim();
      } catch (e) {}
    }
    if (rawName) fields._applicantDisplayName = rawName;
  } else if (rawName) {
    fields._applicantDisplayName = rawName;
    delete fields['申請人'];
  }
  return fields;
}

async function resolvePaymentsTableId(token, appToken, preferredId) {
  const preferred = (preferredId || '').trim();
  if (preferred) {
    try {
      const fields = await listBitableFields(token, appToken, preferred);
      if (fields && fields.length) return preferred;
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.indexOf('TableIdNotFound') < 0 && msg.indexOf('NOTEXIST') < 0) throw err;
    }
  }
  const tables = await listBitableTables(token, appToken);
  const exactNames = ['付款金費單', '付款申請單', '付款申請'];
  for (let i = 0; i < exactNames.length; i++) {
    const hit = tables.find(function(t) { return t.name === exactNames[i]; });
    if (hit && hit.table_id) return hit.table_id;
  }
  const fuzzy = tables.find(function(t) {
    return t.name && (t.name.indexOf('付款') >= 0 || t.name.indexOf('金費') >= 0);
  });
  if (fuzzy && fuzzy.table_id) return fuzzy.table_id;
  return preferred;
}

function paymentApprovalCode() {
  return (process.env.LARK_PAYMENT_APPROVAL_CODE || '6FA791B1-2767-4621-86B4-98E22D2E86E4').trim();
}

function paymentCashApprovalCode() {
  return (process.env.LARK_PAYMENT_CASH_APPROVAL_CODE || '').trim();
}

function paymentFieldText(fields, names) {
  const f = fields || {};
  for (let i = 0; i < names.length; i++) {
    const raw = f[names[i]];
    if (raw == null || raw === '') continue;
    if (Array.isArray(raw)) {
      const parts = raw.map(function(item) {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        if (item.text) return String(item.text);
        if (item.name) return String(item.name);
        return '';
      }).filter(Boolean);
      if (parts.length) return parts.join('、');
      continue;
    }
    if (typeof raw === 'object') {
      if (raw.text) return String(raw.text);
      if (raw.name) return String(raw.name);
    }
    return String(raw);
  }
  return '';
}

function paymentAmountNumber(fields) {
  const n = parseFloat(String((fields && fields['付款總金額']) || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function paymentDateRfc3339(fields) {
  const raw = fields && fields['申請日期'];
  let d = null;
  if (typeof raw === 'number') d = new Date(raw);
  else if (typeof raw === 'string' && raw.trim()) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) d = new Date(raw.trim() + 'T00:00:00+08:00');
    else d = new Date(raw);
  }
  if (!d || isNaN(d.getTime())) d = new Date();
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T00:00:00+08:00';
}

function paymentApplicantOpenId(fields, hint) {
  if (isValidPersonOpenId(hint)) return String(hint).trim();
  const raw = fields && fields['申請人'];
  if (!raw) return '';
  if (Array.isArray(raw) && raw[0]) {
    const id = raw[0].id || raw[0].open_id || '';
    if (isValidPersonOpenId(id)) return String(id);
  }
  if (raw.id && isValidPersonOpenId(raw.id)) return String(raw.id);
  return '';
}

function parseApprovalFormWidgets(formRaw) {
  let parsed = formRaw;
  if (typeof formRaw === 'string') {
    try { parsed = JSON.parse(formRaw); } catch (e) { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(function(w) {
    const option = w.option || w.options || null;
    return {
      id: w.id || w.custom_id || '',
      type: w.type || 'input',
      name: String(w.name || w.custom_id || '').trim(),
      option: option,
      currency: (option && option.currencyRange && option.currencyRange[0]) || w.currency || w.value || 'TWD'
    };
  }).filter(function(w) { return w.id; });
}

function matchApprovalWidgetOption(widget, label) {
  const want = String(label || '').trim();
  const opts = widget && widget.option;
  if (!want || !Array.isArray(opts) || !opts.length) return '';
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i] || {};
    const text = String(opt.text || opt.name || opt.value || '').trim();
    if (text === want || text.indexOf(want) >= 0 || want.indexOf(text) >= 0) {
      return String(opt.value != null ? opt.value : opt.text || '');
    }
  }
  return String(opts[0].value != null ? opts[0].value : '');
}

function approvalWidgetShouldSkip(name) {
  const n = String(name || '').replace(/\s+/g, '');
  const skip = {
    '所屬標案': 1,
    '所屬專案': 1,
    '所屬個案': 1,
    '所數標案': 1,
    '所屬工作項目': 1,
    '工作項目': 1,
    '工作項目名稱': 1,
    '標案名稱': 1
  };
  return !!skip[n];
}

function paymentFieldsForApproval(fields) {
  const f = Object.assign({}, fields || {});
  delete f['所屬標案'];
  delete f['所數標案'];
  delete f['所屬工作項目'];
  return f;
}

function pickAmountCurrency(widget) {
  const range = widget && widget.option && widget.option.currencyRange;
  if (Array.isArray(range) && range.length) {
    if (range.indexOf('TWD') >= 0) return 'TWD';
    return range[0];
  }
  const def = widget && widget.currency;
  if (def && def !== 'USD') return def;
  return 'TWD';
}

function approvalWidgetAliases(name) {
  const n = String(name || '').replace(/\s+/g, '');
  const map = {
    '所屬專案': ['所屬標案', '標案名稱', '所屬個案'],
    '所屬標案': ['所屬專案', '標案名稱', '所屬個案'],
    '所屬個案': ['所屬專案', '所屬標案', '標案名稱'],
    '所屬工作項目': ['工作項目', '工作項目名稱'],
    '支付對象': ['收款人'],
    '廠商名稱': ['廠商'],
    '支付性質': ['付款性質'],
    '支付方式': ['付款方式'],
    '事由': ['付款事由'],
    '備註': ['說明'],
    '付款總金額': ['金額', '總金額'],
    '附件': ['檔案'],
    '申請部門': ['部門'],
    '申請人': ['發起人'],
    '申請日期': ['日期']
  };
  return [n].concat(map[n] || []);
}

async function getPaymentApprovalDefinition(token) {
  const code = paymentApprovalCode();
  if (!code) throw new Error('缺少 LARK_PAYMENT_APPROVAL_CODE');
  const url = BASE_URL + '/approval/v4/approvals/' + encodeURIComponent(code) + '?locale=zh-TW';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (data.code !== 0 || !data.data) {
    throw new Error(data.msg || '無法讀取付款審批定義（請確認應用已開審批權限）');
  }
  return data.data;
}

function buildPaymentApprovalForm(widgets, fields, openId) {
  const form = [];
  const approvalFields = paymentFieldsForApproval(fields);
  (widgets || []).forEach(function(w) {
    if (approvalWidgetShouldSkip(w.name)) return;
    const names = approvalWidgetAliases(w.name);
    const type = String(w.type || 'input');
    let item = null;
    if (type === 'amount') {
      item = { id: w.id, type: 'amount', value: paymentAmountNumber(approvalFields), currency: pickAmountCurrency(w) };
    } else if (type === 'number') {
      item = { id: w.id, type: 'number', value: paymentAmountNumber(approvalFields) };
    } else if (type === 'radio' || type === 'radioV2') {
      const label = paymentFieldText(approvalFields, names);
      const opt = matchApprovalWidgetOption(w, label);
      if (opt) item = { id: w.id, type: 'radioV2', value: opt };
    } else if (type === 'date') {
      item = { id: w.id, type: 'date', value: paymentDateRfc3339(approvalFields) };
    } else if (type === 'contact') {
      if (openId) item = { id: w.id, type: 'contact', value: [], open_ids: [openId] };
    } else if (type === 'textarea') {
      const text = paymentFieldText(approvalFields, names);
      if (text) item = { id: w.id, type: 'textarea', value: text };
    } else if (type === 'attachment' || type === 'attachmentV2') {
      return;
    } else {
      const text = paymentFieldText(approvalFields, names);
      if (text) item = { id: w.id, type: type.indexOf('input') >= 0 ? 'input' : type, value: text };
    }
    if (item) form.push(item);
  });
  return form;
}

async function createPaymentApprovalInstance(token, fields, openIdHint) {
  const approvalCode = paymentApprovalCode();
  if (!approvalCode) return { ok: false, skipped: true, error: '未設定審批代碼' };
  const openId = paymentApplicantOpenId(fields, openIdHint);
  if (!openId) return { ok: false, error: '找不到申請人 open_id，無法送審（請用 Lark 登入）' };
  const def = await getPaymentApprovalDefinition(token);
  const widgets = parseApprovalFormWidgets(def.form);
  const form = buildPaymentApprovalForm(widgets, fields, openId);
  const body = {
    approval_code: approvalCode,
    open_id: openId,
    form: JSON.stringify(form)
  };
  const res = await fetch(BASE_URL + '/approval/v4/instances', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(data.msg || ('建立審批失敗 code:' + data.code));
  }
  const instanceCode = (data.data && data.data.instance_code) || '';
  return {
    ok: true,
    approvalCode: approvalCode,
    instanceCode: instanceCode,
    url: instanceCode ? ('https://www.larksuite.com/approval/detail/' + instanceCode) : ''
  };
}

async function writePaymentApprovalCode(tenantToken, userToken, recordId, instanceCode) {
  if (!recordId || !instanceCode) return;
  const frontCfg = paymentsFrontConfig();
  const tableId = await resolvePaymentsTableId(tenantToken, frontCfg.appToken, frontCfg.tableId);
  if (!tableId) return;
  const fields = {
    '審批編號': instanceCode,
    '審批實例': instanceCode,
    '審批單號': instanceCode
  };
  const body = await normalizeWriteFields(tenantToken, tableId, fields, frontCfg.appToken);
  if (!body || !Object.keys(body).length) return;
  try {
    await writeWithUserFallback(tenantToken, userToken, function(tok, asUser) {
      return updateRecord(tok, tableId, recordId, body, frontCfg.appToken, asUser);
    });
  } catch (err) {
    await updateRecord(tenantToken, tableId, recordId, body, frontCfg.appToken, false);
  }
}

async function writePaymentPendingApprover(tenantToken, recordId, approverName) {
  if (!recordId) return false;
  const frontCfg = paymentsFrontConfig();
  const tableId = await resolvePaymentsTableId(tenantToken, frontCfg.appToken, frontCfg.tableId);
  if (!tableId) return false;
  const fields = { '待簽核人': approverName || '' };
  const body = await normalizeWriteFields(tenantToken, tableId, fields, frontCfg.appToken);
  if (!body || !Object.keys(body).length) return false;
  await updateRecord(tenantToken, tableId, recordId, body, frontCfg.appToken, false);
  return true;
}

const ACCOUNTING_NAME_ALIASES = {
  irisa: ['詹佳瑜', 'Irisa'],
  su: ['蘇芳玉', '艾莉'],
  lu: ['盧存莉', 'NINO', 'Nino']
};

function paymentMethodKind(fields) {
  const raw = String((fields && (fields['支付方式'] || fields['付款方式'])) || '').trim();
  if (raw.indexOf('現金') >= 0) return 'cash';
  return 'wire';
}

function paymentAccountingStatus(fields) {
  return String((fields && (fields['會計狀態'] || fields['會計進度'])) || '').trim();
}

function isAccountingDelivered(fields) {
  return paymentAccountingStatus(fields) === '已送達詹佳瑜';
}

function isXimoSignerName(name) {
  return /蔡宜君|顏楨祐|蔡清德|謝政易|董事長/.test(String(name || ''));
}

function matchAccountingAlias(name, aliases) {
  const n = String(name || '').replace(/\s+/g, '');
  if (!n) return false;
  for (let i = 0; i < aliases.length; i++) {
    const a = String(aliases[i] || '').replace(/\s+/g, '');
    if (!a) continue;
    if (n === a || n.indexOf(a) >= 0 || a.indexOf(n) >= 0) return true;
  }
  return false;
}

function accountingPersonKeyFromName(name) {
  if (matchAccountingAlias(name, ACCOUNTING_NAME_ALIASES.su)) return 'su';
  if (matchAccountingAlias(name, ACCOUNTING_NAME_ALIASES.lu)) return 'lu';
  if (matchAccountingAlias(name, ACCOUNTING_NAME_ALIASES.irisa)) return 'irisa';
  return '';
}

function isXimoStageCompleteForAccounting(approvalStatus, pendingName) {
  const st = String(approvalStatus || '').toUpperCase();
  if (st === 'APPROVED') return true;
  if (st !== 'PENDING') return false;
  const key = accountingPersonKeyFromName(pendingName);
  return key === 'su' || key === 'lu' || key === 'irisa';
}

async function findAccountingPerson(tenantToken, key) {
  const aliases = ACCOUNTING_NAME_ALIASES[key] || [];
  if (!aliases.length) return { name: aliases[0] || '', openId: '' };
  try {
    const members = await getRecords(
      tenantToken,
      tableIdFor('members'),
      appTokenForTable('members'),
      { userIdType: 'open_id' }
    );
    for (let i = 0; i < members.length; i++) {
      const mf = members[i].fields || {};
      const name = getMemberName(mf) || personDisplayName(mf['姓名'] || mf['帳號']);
      if (!matchAccountingAlias(name, aliases)) continue;
      return { name: cleanApproverDisplayName(name) || aliases[0], openId: getMemberPersonOpenId(mf) };
    }
  } catch (e) {}
  return { name: aliases[0] || '', openId: '' };
}

async function writePaymentAccountingRoute(tenantToken, recordId, patch) {
  if (!recordId || !patch) return false;
  const frontCfg = paymentsFrontConfig();
  const tableId = await resolvePaymentsTableId(tenantToken, frontCfg.appToken, frontCfg.tableId);
  if (!tableId) return false;
  const fields = {
    '會計狀態': patch.status || '',
    '會計待簽核人': patch.approver || '',
    '待簽核人': patch.approver || ''
  };
  if (patch.acctInstanceCode) fields['會計審批編號'] = patch.acctInstanceCode;
  const body = await normalizeWriteFields(tenantToken, tableId, fields, frontCfg.appToken);
  if (!body || !Object.keys(body).length) return false;
  await updateRecord(tenantToken, tableId, recordId, body, frontCfg.appToken, false);
  return true;
}

async function notifyAccountingPerson(tenantToken, person, text) {
  if (!person || !person.openId) return { ok: false, skipped: true };
  return sendImTextToOpenId(tenantToken, person.openId, text);
}

function buildAccountingNotifyText(title, fields, extra) {
  const amount = paymentAmountNumber(fields);
  const lines = [
    title,
    '申請人：' + paymentApplicantText(fields),
    '支付對象：' + String((fields && fields['支付對象']) || ''),
    '支付方式：' + String((fields && (fields['支付方式'] || fields['付款方式'])) || ''),
    '事由：' + String((fields && fields['事由']) || ''),
    '金額：NT$' + (amount ? amount.toLocaleString() : '0')
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}

async function routeApprovedPaymentToAccounting(tenantToken, paymentRec, opts) {
  const rec = paymentRec || {};
  const fields = rec.fields || {};
  if (isAccountingDelivered(fields)) return { skipped: true, status: '已送達詹佳瑜' };
  const kind = paymentMethodKind(fields);
  const pendingName = String((opts && opts.pendingApprover) || '').trim();
  const approvalStatus = String((opts && opts.approvalStatus) || '').toUpperCase();
  const personKey = accountingPersonKeyFromName(pendingName);
  const current = paymentAccountingStatus(fields);

  let nextStatus = '已送達詹佳瑜';
  let nextApprover = '詹佳瑜';
  let notifyKey = 'irisa';
  if (kind === 'cash') {
    if (personKey === 'su') {
      nextStatus = '待蘇芳玉簽核';
      nextApprover = '蘇芳玉';
      notifyKey = 'su';
    } else if (personKey === 'lu') {
      nextStatus = '待盧存莉簽核';
      nextApprover = '盧存莉';
      notifyKey = 'lu';
    } else if (current === '待盧存莉簽核' || personKey === 'irisa') {
      nextStatus = '已送達詹佳瑜';
      nextApprover = '詹佳瑜';
      notifyKey = 'irisa';
    } else {
      nextStatus = current === '待盧存莉簽核' ? '待盧存莉簽核' : '待蘇芳玉簽核';
      nextApprover = nextStatus === '待盧存莉簽核' ? '盧存莉' : '蘇芳玉';
      notifyKey = nextStatus === '待盧存莉簽核' ? 'lu' : 'su';
    }
  }

  if (current === nextStatus) return { skipped: true, status: nextStatus };

  const person = await findAccountingPerson(tenantToken, notifyKey);
  const display = person.name || nextApprover;
  await writePaymentAccountingRoute(tenantToken, rec.record_id, {
    status: nextStatus,
    approver: nextStatus === '已送達詹佳瑜' ? '詹佳瑜' : display
  });
  rec.fields = rec.fields || {};
  rec.fields['會計狀態'] = nextStatus;
  rec.fields['會計待簽核人'] = nextStatus === '已送達詹佳瑜' ? '詹佳瑜' : display;
  rec.fields['待簽核人'] = rec.fields['會計待簽核人'];

  let extra = '';
  if (nextStatus === '已送達詹佳瑜') extra = '請自行列印付款申請單與附件給夏桂英。';
  else extra = '請在 Lark 審批蓋章。蓋完後會送到詹佳瑜。';
  const title = nextStatus === '已送達詹佳瑜'
    ? '【付款申請·已送到詹佳瑜】'
    : ('【付款申請·現金待蓋章】' + nextStatus);
  const notified = await notifyAccountingPerson(
    tenantToken,
    person,
    buildAccountingNotifyText(title, fields, extra)
  );
  return { status: nextStatus, notified: !!(notified && notified.ok), person: display };
}

function paymentRecordStatus(fields) {
  return String((fields && (fields['狀態'] || fields['審核狀態'])) || '').trim();
}

function paymentApprovalInstanceCode(fields) {
  return String((fields && (fields['審批編號'] || fields['審批實例'] || fields['審批單號'])) || '').trim();
}

function isPaymentApprovedStatus(status) {
  return status === '已核銷' || status === '已審核' || status === '已合銷';
}

function isPaymentPendingStatus(status) {
  return !status || status === '審批中' || status === '未審核' || status === '待審核';
}

function parsePaymentTs(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    const n = val < 1e11 ? val * 1000 : val;
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function getApprovalInstanceDetail(token, instanceCode) {
  if (!instanceCode) throw new Error('missing instance code');
  const url = BASE_URL + '/approval/v4/instances/' + encodeURIComponent(instanceCode) + '?locale=zh-TW';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || ('讀取審批失敗 code:' + data.code));
  return data.data || {};
}

function cleanApproverDisplayName(raw) {
  if (!raw) return '';
  return String(raw).split('_')[0].trim();
}

async function buildMembersOpenIdLookup(tenantToken) {
  const lookup = {};
  try {
    const members = await getRecords(
      tenantToken,
      tableIdFor('members'),
      appTokenForTable('members'),
      { userIdType: 'open_id' }
    );
    for (let i = 0; i < members.length; i++) {
      const mf = members[i].fields || {};
      const openId = getMemberPersonOpenId(mf);
      if (!openId) continue;
      const name = cleanApproverDisplayName(getMemberName(mf) || personDisplayName(mf['姓名'] || mf['帳號']));
      if (name) lookup[openId] = name;
      const altIds = [
        mf['Lark User ID'], mf['User ID'], mf['user_id'], mf['Open ID'], mf['open_id']
      ];
      altIds.forEach(function(raw) {
        const id = fieldTextValue(raw);
        if (id) lookup[id] = name || lookup[id] || '';
      });
    }
  } catch (e) {}
  return lookup;
}

const larkUserNameCache = {};

async function fetchLarkUserDisplayName(token, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  if (larkUserNameCache[uid]) return larkUserNameCache[uid];
  const idTypes = /^ou_/i.test(uid) ? ['open_id'] : ['user_id', 'open_id'];
  for (let i = 0; i < idTypes.length; i++) {
    try {
      const url = BASE_URL + '/contact/v3/users/' + encodeURIComponent(uid) + '?user_id_type=' + idTypes[i];
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (data.code === 0 && data.data && data.data.user) {
        const u = data.data.user;
        const name = cleanApproverDisplayName(String(u.name || u.en_name || u.nickname || '').trim());
        if (name) {
          larkUserNameCache[uid] = name;
          return name;
        }
      }
    } catch (e) {}
  }
  return '';
}

async function pendingApproverFromApprovalDetail(token, detail, peopleLookup) {
  const tasks = (detail && detail.task_list) || [];
  const pendingTasks = tasks.filter(function(task) {
    const st = String(task.status || '').toUpperCase();
    return st === 'PENDING' || st === 'IN_PROGRESS' || st === 'PROCESSING';
  });
  const ordered = pendingTasks.length ? pendingTasks : tasks.filter(function(task) {
    const st = String(task.status || '').toUpperCase();
    return st !== 'APPROVED' && st !== 'REJECTED' && st !== 'DONE' && st !== 'CANCELED';
  });
  for (let i = 0; i < ordered.length; i++) {
    const task = ordered[i];
    if (task.user_name) return cleanApproverDisplayName(String(task.user_name));
    const uid = String(task.open_id || task.user_id || '').trim();
    if (uid && peopleLookup[uid]) return peopleLookup[uid];
    const fromApi = await fetchLarkUserDisplayName(token, uid);
    if (fromApi) return fromApi;
  }
  return '';
}

async function listApprovalInstanceCodes(token, approvalCode, startMs, endMs) {
  const codes = [];
  let pageToken = '';
  let guard = 0;
  while (guard < 20) {
    guard++;
    const params = new URLSearchParams({
      approval_code: approvalCode,
      start_time: String(startMs),
      end_time: String(endMs),
      page_size: '100'
    });
    if (pageToken) params.set('page_token', pageToken);
    const url = BASE_URL + '/approval/v4/instances?' + params.toString();
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg || ('列出審批失敗 code:' + data.code));
    const list = (data.data && data.data.instance_code_list) || [];
    list.forEach(function(code) { if (code) codes.push(code); });
    if (!(data.data && data.data.has_more) || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return codes;
}

function parseApprovalInstanceForm(detail, widgets) {
  const widgetMap = {};
  (widgets || []).forEach(function(w) { widgetMap[w.id] = w.name; });
  let items = [];
  try {
    items = typeof detail.form === 'string' ? JSON.parse(detail.form) : (detail.form || []);
  } catch (e) { items = []; }
  const out = {};
  items.forEach(function(item) {
    const name = String(widgetMap[item.id] || item.name || '').trim();
    if (!name) return;
    if (item.type === 'amount' || item.type === 'number') {
      out[name] = parseFloat(String(item.value != null ? item.value : '').replace(/[^0-9.]/g, '')) || 0;
    } else {
      out[name] = String(item.value != null ? item.value : item.ext || '').trim();
    }
  });
  return out;
}

function paymentMatchesApprovalForm(fields, formValues) {
  const amount = paymentAmountNumber(fields);
  const payee = String(fields['支付對象'] || '').trim();
  const reason = String(fields['事由'] || '').trim();
  const formAmount = parseFloat(String(
    formValues['付款總金額'] || formValues['金額'] || formValues['總金額'] || 0
  ).replace(/[^0-9.]/g, '')) || 0;
  if (Math.abs(formAmount - amount) > 0.009) return false;
  const formPayee = String(formValues['支付對象'] || formValues['收款人'] || '').trim();
  const formReason = String(formValues['事由'] || formValues['付款事由'] || '').trim();
  if (payee && formPayee && payee !== formPayee && formPayee.indexOf(payee) < 0 && payee.indexOf(formPayee) < 0) return false;
  if (reason && formReason && reason !== formReason && formReason.indexOf(reason) < 0 && reason.indexOf(formReason) < 0) return false;
  return true;
}

function extractApprovalFormAmount(formValues, detail) {
  const fromMap = parseFloat(String(
    formValues['付款總金額'] || formValues['金額'] || formValues['總金額'] || 0
  ).replace(/[^0-9.]/g, '')) || 0;
  if (fromMap) return fromMap;
  let items = [];
  try {
    items = typeof detail.form === 'string' ? JSON.parse(detail.form) : (detail.form || []);
  } catch (e) { items = []; }
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    if (item.type !== 'amount' && item.type !== 'number') continue;
    const n = parseFloat(String(item.value != null ? item.value : '').replace(/[^0-9.]/g, '')) || 0;
    if (n) return n;
  }
  return 0;
}

function paymentDetailStartMs(detail) {
  const t = Number((detail && detail.start_time) || 0);
  if (!t) return 0;
  return t < 1e12 ? t * 1000 : t;
}

function paymentMatchesApprovalDetail(fields, detail, widgets) {
  const formValues = parseApprovalInstanceForm(detail, widgets);
  if (paymentMatchesApprovalForm(fields, formValues)) return true;
  const amount = paymentAmountNumber(fields);
  const formAmount = extractApprovalFormAmount(formValues, detail);
  if (!amount || !formAmount || Math.abs(formAmount - amount) > 0.009) return false;
  const payee = String(fields['支付對象'] || '').trim();
  const reason = String(fields['事由'] || '').trim();
  const formPayee = String(formValues['支付對象'] || formValues['收款人'] || '').trim();
  const formReason = String(formValues['事由'] || formValues['付款事由'] || '').trim();
  if (payee && formPayee && (payee === formPayee || formPayee.indexOf(payee) >= 0 || payee.indexOf(formPayee) >= 0)) return true;
  if (reason && formReason && (reason === formReason || formReason.indexOf(reason) >= 0 || reason.indexOf(formReason) >= 0)) return true;
  const appDate = parsePaymentTs(fields['申請日期']);
  const startMs = paymentDetailStartMs(detail);
  if (appDate && startMs && Math.abs(appDate.getTime() - startMs) < 3 * 86400000) return true;
  return false;
}

async function resolvePaymentInstanceCode(token, paymentRec, widgets, detailCache) {
  const fields = paymentRec.fields || {};
  let code = paymentApprovalInstanceCode(fields);
  if (code) return code;

  function tryMatch(ic, detail) {
    return detail && paymentMatchesApprovalDetail(fields, detail, widgets);
  }

  const cachedCodes = Object.keys(detailCache || {});
  for (let i = 0; i < cachedCodes.length; i++) {
    const ic = cachedCodes[i];
    if (tryMatch(ic, detailCache[ic])) {
      try { await writePaymentApprovalCode(token, null, paymentRec.record_id, ic); } catch (e) {}
      return ic;
    }
  }

  const approvalCode = paymentApprovalCode();
  if (!approvalCode) return '';
  const appDate = parsePaymentTs(fields['申請日期']);
  const startMs = appDate ? (appDate.getTime() - 86400000) : (Date.now() - 90 * 86400000);
  const endMs = appDate ? (appDate.getTime() + 14 * 86400000) : Date.now();
  const codes = await listApprovalInstanceCodes(token, approvalCode, startMs, endMs);
  for (let j = 0; j < codes.length; j++) {
    const ic = codes[j];
    let detail = detailCache[ic];
    if (!detail) {
      try {
        detail = await getApprovalInstanceDetail(token, ic);
        detailCache[ic] = detail;
      } catch (e) { continue; }
    }
    if (tryMatch(ic, detail)) {
      try { await writePaymentApprovalCode(token, null, paymentRec.record_id, ic); } catch (e) {}
      return ic;
    }
  }
  return '';
}

function mergePaymentApprovalMeta(records, approvalMeta) {
  if (!approvalMeta || !Object.keys(approvalMeta).length) return records;
  return records.map(function(rec) {
    const meta = approvalMeta[rec.record_id];
    if (!meta) return rec;
    const fields = Object.assign({}, rec.fields || {});
    if (meta.instanceCode && !paymentApprovalInstanceCode(fields)) fields['審批編號'] = meta.instanceCode;
    if (meta.pendingApprover && !String(fields['待簽核人'] || '').trim()) fields['待簽核人'] = meta.pendingApprover;
    return Object.assign({}, rec, { fields: fields, approvalMeta: meta });
  });
}

function buildExpenseFieldsFromPayment(fields, paymentRecordId) {
  const amount = paymentAmountNumber(fields);
  const wiIds = getLinkIds(fields['所屬工作項目']);
  const projIds = getLinkIds(fields['所屬標案'] || fields['所數標案']);
  const payee = String(fields['支付對象'] || '').trim();
  const reason = String(fields['事由'] || '').trim();
  const name = payee && reason ? (payee + '｜' + reason) : (payee || reason || '付款申請');
  const expense = {
    '支出細項': name,
    '實際金額': amount,
    '未稅金額': Math.round(amount / 1.05),
    '未稅金額(X)': Math.round(amount / 1.05),
    '狀態': '已合銷'
  };
  if (fields['申請日期']) expense['日期'] = fields['申請日期'];
  if (wiIds.length) expense['所屬工作項目'] = wiIds;
  if (projIds.length) {
    expense['所屬標案'] = projIds;
    expense['所數標案'] = projIds;
  }
  if (fields['申請人']) expense['負責人'] = fields['申請人'];
  const remark = String(fields['備註'] || '').trim();
  expense['備註'] = remark
    ? (remark + ' · payment:' + paymentRecordId)
    : ('payment:' + paymentRecordId);
  return expense;
}

function expenseLinkedPaymentId(fields) {
  const remark = String((fields && (fields['備註'] || fields['說明'])) || '');
  const m = remark.match(/payment:([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

let _accTenantTokenCache = null;
let _accExpenseFieldsReady = false;

async function getAccTenantToken() {
  if (!ACC_APP_SECRET) return '';
  const now = Date.now();
  if (_accTenantTokenCache && _accTenantTokenCache.expiresAt > now + 60000) {
    return _accTenantTokenCache.token;
  }
  const res = await fetch(BASE_URL + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: ACC_APP_ID, app_secret: ACC_APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error('ACC Token error: ' + (data.msg || JSON.stringify(data)));
  }
  _accTenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, (data.expire || 7200)) * 1000
  };
  return _accTenantTokenCache.token;
}

function accNormName(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/115年度?/g, '')
    .replace(/計畫預算表/g, '')
    .replace(/計畫$/g, '');
}

function accNamesMatch(a, b) {
  const x = accNormName(a);
  const y = accNormName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return shorter.length >= 4 && longer.indexOf(shorter) >= 0;
}

function accFieldText(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw).trim();
  if (Array.isArray(raw)) {
    return raw.map(function(item) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text || item.name || '';
      return '';
    }).filter(Boolean).join('、');
  }
  if (typeof raw === 'object') return String(raw.text || raw.name || '').trim();
  return String(raw).trim();
}

function accPaymentDateMs(fields) {
  const raw = fields && fields['申請日期'];
  if (typeof raw === 'number' && raw > 0) return raw < 1e11 ? raw * 1000 : raw;
  if (typeof raw === 'string' && raw.trim()) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
      ? new Date(raw.trim() + 'T00:00:00+08:00')
      : new Date(raw);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return Date.now();
}

async function ensureAccExpenseSourceFields(accToken) {
  if (_accExpenseFieldsReady) return;
  const res = await fetch(
    BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(ACC_APP_TOKEN)
      + '/tables/' + encodeURIComponent(ACC_TABLE_EXPENSES) + '/fields?page_size=100',
    { headers: { Authorization: 'Bearer ' + accToken } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error('讀取會計支出欄位失敗: ' + (data.msg || data.code));
  const names = {};
  (data.data && data.data.items || []).forEach(function(f) {
    names[f.field_name] = true;
  });
  const extras = ['來源付款ID', '來源標案', '來源工項'];
  for (let i = 0; i < extras.length; i++) {
    if (names[extras[i]]) continue;
    const created = await fetch(
      BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(ACC_APP_TOKEN)
        + '/tables/' + encodeURIComponent(ACC_TABLE_EXPENSES) + '/fields',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_name: extras[i], type: 1 })
      }
    ).then(function(r) { return r.json(); });
    if (created.code !== 0) throw new Error('新增會計支出欄位失敗: ' + extras[i] + ' ' + (created.msg || created.code));
  }
  _accExpenseFieldsReady = true;
}

async function resolveXimoPaymentLabels(ximoToken, fields) {
  let projectName = getLinkText(fields['所屬標案'] || fields['所數標案'])
    || accFieldText(fields['標案名稱']);
  let workitemName = getLinkText(fields['所屬工作項目'])
    || accFieldText(fields['工作項目名稱']);
  const projIds = getLinkIds(fields['所屬標案'] || fields['所數標案']);
  const wiIds = getLinkIds(fields['所屬工作項目']);
  if (!projectName && projIds[0]) {
    try {
      const rec = await getRecordById(ximoToken, tableIdFor('projects'), projIds[0], appTokenForTable('projects'));
      projectName = accFieldText((rec && rec.fields) ? rec.fields['標案名稱'] : '');
    } catch (e) {}
  }
  if (!workitemName && wiIds[0]) {
    try {
      const rec = await getRecordById(ximoToken, tableIdFor('workitems'), wiIds[0], appTokenForTable('workitems'));
      const wf = (rec && rec.fields) || {};
      workitemName = accFieldText(wf['工作項目名稱'] || wf['名稱'] || wf['工作項目']);
    } catch (e) {}
  }
  return { projectName: projectName || '', workitemName: workitemName || '' };
}

async function findAccProjectRecord(accToken, projectName) {
  if (!projectName || !ACC_TABLE_PROJECTS) return null;
  const rows = await getRecords(accToken, ACC_TABLE_PROJECTS, ACC_APP_TOKEN);
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].fields || {};
    if (accNamesMatch(projectName, f['案名']) || accNamesMatch(projectName, f['完整名稱'])) {
      return rows[i];
    }
  }
  return null;
}

async function findAccWorkitemRecord(accToken, projectRecordId, workitemName) {
  if (!workitemName || !ACC_TABLE_WORKITEMS) return null;
  const rows = await getRecords(accToken, ACC_TABLE_WORKITEMS, ACC_APP_TOKEN);
  let fallback = null;
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].fields || {};
    const nameHit = accNamesMatch(workitemName, f['工作項目']) || accNamesMatch(workitemName, f['代號']);
    if (!nameHit) continue;
    const linked = getLinkIds(f['所屬案件']);
    if (projectRecordId && linked.indexOf(projectRecordId) >= 0) return rows[i];
    if (!fallback) fallback = rows[i];
  }
  return projectRecordId ? null : fallback;
}

async function syncSettledPaymentToAccPortal(ximoToken, paymentRec) {
  if (!ACC_APP_SECRET || !ACC_APP_TOKEN || !ACC_TABLE_EXPENSES) {
    return { skipped: true, reason: 'acc-env-missing' };
  }
  const rec = paymentRec || {};
  const fields = rec.fields || {};
  const paymentId = rec.record_id;
  if (!paymentId) return { skipped: true, reason: 'no-payment-id' };

  const accToken = await getAccTenantToken();
  await ensureAccExpenseSourceFields(accToken);

  const existing = await getRecords(accToken, ACC_TABLE_EXPENSES, ACC_APP_TOKEN);
  for (let i = 0; i < existing.length; i++) {
    const ef = existing[i].fields || {};
    if (accFieldText(ef['來源付款ID']) === paymentId) {
      return { skipped: true, reason: 'already-synced', recordId: existing[i].record_id };
    }
  }

  const labels = await resolveXimoPaymentLabels(ximoToken, fields);
  const accProject = await findAccProjectRecord(accToken, labels.projectName);
  const accWorkitem = await findAccWorkitemRecord(
    accToken,
    accProject ? accProject.record_id : '',
    labels.workitemName
  );

  const payee = accFieldText(fields['支付對象']);
  const reason = accFieldText(fields['事由']) || accFieldText(fields['支出細項']);
  const summary = payee && reason ? (payee + '｜' + reason) : (payee || reason || '付款申請');
  const out = {
    '摘要': summary,
    '金額': paymentAmountNumber(fields),
    '對象': payee,
    '日期': accPaymentDateMs(fields),
    '來源付款ID': paymentId,
    '來源標案': labels.projectName,
    '來源工項': labels.workitemName
  };
  if (accProject) out['所屬案件'] = [accProject.record_id];
  if (accWorkitem) out['工項'] = [accWorkitem.record_id];

  const created = await createRecord(accToken, ACC_TABLE_EXPENSES, out, ACC_APP_TOKEN, false);
  return {
    ok: true,
    recordId: extractRecordId(created),
    linkedProject: !!(accProject),
    linkedWorkitem: !!(accWorkitem),
    sourceProject: labels.projectName
  };
}

async function loadExpenseRecords(tenantToken) {
  const tableId = tableIdFor('expenses');
  const appToken = appTokenForTable('expenses');
  if (!tableId || !appToken) return [];
  return getRecords(tenantToken, tableId, appToken);
}

async function findExpenseIdsForPayment(tenantToken, paymentRecordId, expenseCache) {
  const rows = expenseCache || await loadExpenseRecords(tenantToken);
  return rows.filter(function(rec) {
    return expenseLinkedPaymentId(rec.fields || {}) === paymentRecordId;
  }).map(function(rec) { return rec.record_id; });
}

async function deleteDuplicatePaymentExpenses(tenantToken, keepId, extraIds) {
  const tableId = tableIdFor('expenses');
  const appToken = appTokenForTable('expenses');
  if (!tableId || !appToken || !keepId) return 0;
  let removed = 0;
  for (let i = 0; i < extraIds.length; i++) {
    if (!extraIds[i] || extraIds[i] === keepId) continue;
    try {
      await deleteRecord(tenantToken, tableId, extraIds[i], appToken, false);
      removed++;
    } catch (e) {}
  }
  return removed;
}

async function createExpenseFromPayment(tenantToken, paymentRecordId, fields, expenseCache) {
  const tableId = tableIdFor('expenses');
  const appToken = appTokenForTable('expenses');
  if (!tableId || !appToken) throw new Error('找不到支出明細資料表');
  const existing = await findExpenseIdsForPayment(tenantToken, paymentRecordId, expenseCache);
  if (existing.length) {
    await deleteDuplicatePaymentExpenses(tenantToken, existing[0], existing.slice(1));
    return existing[0];
  }
  const body = await normalizeWriteFields(
    tenantToken,
    tableId,
    buildExpenseFieldsFromPayment(fields, paymentRecordId),
    appToken
  );
  if (!body || !Object.keys(body).length) throw new Error('支出明細欄位無法寫入');
  const res = await createRecord(tenantToken, tableId, body, appToken, false);
  const id = extractRecordId(res);
  if (id && expenseCache) {
    expenseCache.push({ record_id: id, fields: body });
  }
  return id;
}

async function finalizeApprovedPaymentRecord(tenantToken, paymentRec, expenseCache, opts) {
  const rec = paymentRec || {};
  const recordId = rec.record_id;
  const fields = rec.fields || {};
  const frontCfg = paymentsFrontConfig();
  const tableId = await resolvePaymentsTableId(tenantToken, frontCfg.appToken, frontCfg.tableId);
  if (!tableId) throw new Error('找不到付款資料表');

  let expenseId = getLinkIds(fields['支出明細'] || fields['關聯支出'])[0] || '';
  const existing = await findExpenseIdsForPayment(tenantToken, recordId, expenseCache);
  if (!expenseId && existing.length) expenseId = existing[0];
  if (existing.length > 1) {
    await deleteDuplicatePaymentExpenses(tenantToken, expenseId || existing[0], existing);
    expenseId = expenseId || existing[0];
  }
  if (!expenseId) {
    expenseId = await createExpenseFromPayment(tenantToken, recordId, fields, expenseCache);
  }

  const updateFields = { '狀態': '已核銷' };
  if (expenseId) {
    updateFields['支出明細'] = [expenseId];
    updateFields['關聯支出'] = [expenseId];
  }
  const body = await normalizeWriteFields(tenantToken, tableId, updateFields, frontCfg.appToken);
  if (body && Object.keys(body).length) {
    await updateRecord(tenantToken, tableId, recordId, body, frontCfg.appToken, false);
  }
  rec.fields = Object.assign({}, fields, { '狀態': '已核銷' });
  let accounting = null;
  try {
    accounting = await routeApprovedPaymentToAccounting(tenantToken, rec, opts || {});
  } catch (e) {
    accounting = { error: e.message || String(e) };
  }
  let accPortal = null;
  try {
    accPortal = await syncSettledPaymentToAccPortal(tenantToken, rec);
  } catch (e) {
    accPortal = { error: e.message || String(e) };
  }
  return { recordId: recordId, expenseId: expenseId, status: '已核銷', accounting: accounting, accPortal: accPortal };
}

async function dedupePaymentExpenses(tenantToken, expenseCache) {
  const rows = expenseCache || await loadExpenseRecords(tenantToken);
  const grouped = {};
  rows.forEach(function(rec) {
    const pid = expenseLinkedPaymentId(rec.fields || {});
    if (pid) {
      if (!grouped[pid]) grouped[pid] = [];
      grouped[pid].push(rec.record_id);
      return;
    }
    const f = rec.fields || {};
    const name = String(f['支出細項'] || '');
    if (name.indexOf('｜') < 0 && name.indexOf('|') < 0) return;
    const amount = paymentAmountNumber({ '付款總金額': f['實際金額'] });
    const date = String(f['日期'] || '');
    if (!amount || !name) return;
    const key = 'same:' + name + '|' + amount + '|' + date;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(rec.record_id);
  });
  let removed = 0;
  const ids = Object.keys(grouped);
  for (let i = 0; i < ids.length; i++) {
    const list = grouped[ids[i]];
    if (list.length < 2) continue;
    removed += await deleteDuplicatePaymentExpenses(tenantToken, list[0], list.slice(1));
  }
  return removed;
}

let paymentApprovalSyncInflight = null;

async function syncPendingPaymentApprovals(tenantToken) {
  if (paymentApprovalSyncInflight) return paymentApprovalSyncInflight;
  paymentApprovalSyncInflight = syncPendingPaymentApprovalsInner(tenantToken).finally(function() {
    paymentApprovalSyncInflight = null;
  });
  return paymentApprovalSyncInflight;
}

async function syncPendingPaymentApprovalsInner(tenantToken) {
  const frontCfg = paymentsFrontConfig();
  const tableId = await resolvePaymentsTableId(tenantToken, frontCfg.appToken, frontCfg.tableId);
  if (!tableId) return { checked: 0, updated: 0, approverSynced: 0, removedDupes: 0, errors: [], approvalMeta: {} };

  const records = await getRecords(tenantToken, tableId, frontCfg.appToken);
  const targets = records.filter(function(rec) {
    const fields = rec.fields || {};
    const status = paymentRecordStatus(fields);
    if (isPaymentPendingStatus(status)) return true;
    if (isPaymentApprovedStatus(status) && !isAccountingDelivered(fields)) return true;
    return false;
  });

  let expenseCache = [];
  try { expenseCache = await loadExpenseRecords(tenantToken); } catch (e) { expenseCache = []; }
  const removedDupes = await dedupePaymentExpenses(tenantToken, expenseCache);
  if (removedDupes) {
    try { expenseCache = await loadExpenseRecords(tenantToken); } catch (e) {}
  }

  const results = {
    checked: targets.length,
    updated: 0,
    approverSynced: 0,
    linked: 0,
    removedDupes: removedDupes,
    errors: [],
    details: [],
    approvalMeta: {}
  };
  if (!targets.length) return results;

  let widgets = [];
  try {
    const def = await getPaymentApprovalDefinition(tenantToken);
    widgets = parseApprovalFormWidgets(def.form);
  } catch (e) {}

  let peopleLookup = {};
  try { peopleLookup = await buildMembersOpenIdLookup(tenantToken); } catch (e) {}

  const detailCache = {};
  const missingCode = targets.filter(function(rec) { return !paymentApprovalInstanceCode(rec.fields || {}); });
  if (missingCode.length) {
    let minTs = Date.now();
    let maxTs = 0;
    missingCode.forEach(function(rec) {
      const d = parsePaymentTs((rec.fields || {})['申請日期']);
      const t = d ? d.getTime() : Date.now();
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    });
    try {
      const codes = await listApprovalInstanceCodes(
        tenantToken,
        paymentApprovalCode(),
        minTs - 90 * 86400000,
        maxTs + 14 * 86400000
      );
      results.instanceCandidates = codes.length;
      for (let ci = 0; ci < codes.length; ci++) {
        try {
          detailCache[codes[ci]] = await getApprovalInstanceDetail(tenantToken, codes[ci]);
        } catch (e) {}
      }
    } catch (e) {
      results.errors.push({ error: 'list instances: ' + (e.message || String(e)) });
    }
  }

  for (let i = 0; i < targets.length; i++) {
    const rec = targets[i];
    const status = paymentRecordStatus(rec.fields || {});
    const pending = isPaymentPendingStatus(status);
    try {
      const instanceCode = await resolvePaymentInstanceCode(tenantToken, rec, widgets, detailCache);
      if (!instanceCode) {
        if (!pending && isPaymentApprovedStatus(status)) {
          const routed = await routeApprovedPaymentToAccounting(tenantToken, rec, { approvalStatus: 'APPROVED' });
          if (routed && !routed.skipped) results.updated++;
        }
        continue;
      }
      const detail = detailCache[instanceCode] || await getApprovalInstanceDetail(tenantToken, instanceCode);
      detailCache[instanceCode] = detail;
      const st = String(detail.status || '').trim().toUpperCase();
      const approver = st === 'PENDING'
        ? await pendingApproverFromApprovalDetail(tenantToken, detail, peopleLookup)
        : '';
      results.approvalMeta[rec.record_id] = {
        instanceCode: instanceCode,
        approvalStatus: st,
        pendingApprover: approver,
        url: 'https://www.larksuite.com/approval/detail/' + instanceCode
      };
      results.linked++;
      if (!paymentApprovalInstanceCode(rec.fields || {})) {
        rec.fields = rec.fields || {};
        rec.fields['審批編號'] = instanceCode;
      }

      if (pending && (st === 'APPROVED' || isXimoStageCompleteForAccounting(st, approver))) {
        const out = await finalizeApprovedPaymentRecord(tenantToken, rec, expenseCache, {
          pendingApprover: approver,
          approvalStatus: st
        });
        results.updated++;
        results.details.push({
          recordId: rec.record_id,
          instanceCode: instanceCode,
          expenseId: out.expenseId,
          accounting: out.accounting || null
        });
        continue;
      }
      if (!pending && isPaymentApprovedStatus(status)) {
        const routed = await routeApprovedPaymentToAccounting(tenantToken, rec, {
          pendingApprover: approver,
          approvalStatus: st
        });
        if (routed && !routed.skipped) results.updated++;
        continue;
      }
      if (pending && st === 'PENDING' && approver) {
        const current = String((rec.fields || {})['待簽核人'] || '').trim();
        if (approver !== current) {
          const wrote = await writePaymentPendingApprover(tenantToken, rec.record_id, approver);
          rec.fields = rec.fields || {};
          rec.fields['待簽核人'] = approver;
          if (wrote) results.approverSynced++;
        }
      }
    } catch (err) {
      results.errors.push({
        recordId: rec.record_id,
        error: err.message || String(err)
      });
    }
  }
  return results;
}

async function createPaymentInBothBases(tenantToken, userToken, rawFields, applicantOpenIdHint) {
  const results = { main: null, accounting: null };
  const errors = [];
  const fields = Object.assign({}, rawFields || {});
  if (fields['狀態'] === undefined) fields['狀態'] = '審批中';
  await enrichPaymentApplicant(tenantToken, userToken, fields, applicantOpenIdHint);

  const frontCfg = paymentsFrontConfig();
  const schemaCache = {};
  try {
    const mainTableId = await resolvePaymentsTableId(
      tenantToken,
      frontCfg.appToken,
      frontCfg.tableId
    );
    if (!mainTableId) throw new Error('找不到前台付款資料表');
    const mainSchemas = await getTableFieldSchemas(tenantToken, frontCfg.appToken, mainTableId, schemaCache);
    if (!fields['申請人'] && fields._applicantDisplayName) {
      applyApplicantTextFallback(fields, mainSchemas.allowedSet);
    }
    const mainBody = await normalizeWriteFields(tenantToken, mainTableId, fields, frontCfg.appToken);
    injectApplicantIntoBody(mainBody, fields, mainSchemas.allowedSet, mainSchemas.fieldMeta);
    const applicantKey = findApplicantFieldName(mainSchemas.allowedSet) || '申請人';
    if (fields._applicantDisplayName && !mainBody[applicantKey] && !hasApplicantTextFallback(mainBody, mainSchemas.allowedSet)) {
      errors.push('申請人未寫入：無法對應 Lark 人員（' + fields._applicantDisplayName + '），請確認人員資料表');
    }
    results.applicantDebug = {
      hint: applicantOpenIdHint || '',
      enriched: fields['申請人'],
      inBody: mainBody[applicantKey],
      fieldName: applicantKey
    };
    results.main = await writeWithUserFallback(tenantToken, userToken, function(tok, asUser) {
      return createRecord(tok, mainTableId, mainBody, frontCfg.appToken, asUser);
    });
  } catch (err) {
    errors.push('前台資料庫：' + (err.message || String(err)));
  }

  const accCfg = paymentsAccountingConfig();
  if (accCfg.appToken && (accCfg.appToken !== frontCfg.appToken || accCfg.tableId !== frontCfg.tableId)) {
    try {
      const accTableId = await resolvePaymentsTableId(
        tenantToken,
        accCfg.appToken,
        accCfg.tableId
      );
      if (!accTableId) throw new Error('找不到會計付款資料表');
      const accSchemas = await getTableFieldSchemas(tenantToken, accCfg.appToken, accTableId, schemaCache);
      const accFields = Object.assign({}, fields);
      if (!accFields['申請人'] && accFields._applicantDisplayName) {
        applyApplicantTextFallback(accFields, accSchemas.allowedSet);
      }
      const accBody = await normalizeWriteFields(tenantToken, accTableId, accFields, accCfg.appToken);
      results.accounting = await writeWithUserFallback(tenantToken, userToken, function(tok, asUser) {
        return createRecord(tok, accTableId, accBody, accCfg.appToken, asUser);
      });
    } catch (err) {
      errors.push('會計資料庫：' + (err.message || String(err)));
    }
  }

  if (!results.main && !results.accounting) {
    throw new Error(errors.join('；') || '付款資料寫入失敗');
  }

  try {
    results.approval = await createPaymentApprovalInstance(tenantToken, fields, applicantOpenIdHint);
    const recId = extractRecordId(results.main) || extractRecordId(results.accounting);
    if (results.approval && results.approval.ok && results.approval.instanceCode && recId) {
      try {
        await writePaymentApprovalCode(tenantToken, userToken, recId, results.approval.instanceCode);
      } catch (writeErr) {
        errors.push('審批編號未寫回表格：' + (writeErr.message || String(writeErr)));
      }
    } else if (results.approval && !results.approval.ok && results.approval.error) {
      errors.push('Lark 審批：' + results.approval.error);
    }
  } catch (apprErr) {
    results.approval = { ok: false, error: apprErr.message || String(apprErr) };
    errors.push('Lark 審批：' + results.approval.error);
  }

  if (errors.length) results.partialErrors = errors;

  const primary = results.main || results.accounting;
  return {
    code: 0,
    data: primary && primary.data ? primary.data : {},
    main: results.main,
    accounting: results.accounting,
    partialErrors: results.partialErrors || [],
    enrichedFields: fields,
    applicantDebug: results.applicantDebug || null,
    approval: results.approval || null
  };
}

function hasApplicantTextFallback(body, allowedSet) {
  const fallbacks = ['申請人姓名', '申请人姓名', '申請人名稱', '申请人', '申請人文字'];
  return fallbacks.some(function(name) { return allowedSet[name] && body[name]; });
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
    if (!isArchiveTemplateConfigured()) throw err;
    return {
      mode: 'template_copy',
      templateConfigured: true,
      note: '封存時將在知識庫內複製範本頁面並寫入資料'
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

async function gatherProjectRelatedFullScan(token, projectId, cfg, readOpts) {
  const appToken = cfg.appToken;
  const jobs = [
    getRecords(token, cfg.tables.projects, appToken, readOpts),
    getRecords(token, cfg.tables.workitems, appToken, readOpts),
    getRecords(token, cfg.tables.tasks, appToken, readOpts),
    getRecords(token, cfg.tables.expenses, appToken, readOpts),
    getRecords(token, cfg.tables.designs, appToken, readOpts),
    getRecords(token, cfg.tables.journal, appToken, readOpts)
  ];
  if (cfg.tables.milestones) {
    jobs.push(getRecords(token, cfg.tables.milestones, appToken, readOpts).catch(function() { return []; }));
  } else {
    jobs.push(Promise.resolve([]));
  }
  const [projects, workitems, tasks, expenses, designs, journalAll, milestonesAll] = await Promise.all(jobs);
  const proj = projects.find(function(p) { return p.record_id === projectId; });
  if (!proj) throw new Error('找不到標案');

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
  const journal = journalAll.filter(function(r) { return journalBelongsToProject(r, projectId); });
  const milestonesRel = (milestonesAll || []).filter(function(m) {
    return getLinkIds((m.fields || {})['所屬標案']).indexOf(projectId) >= 0;
  });

  return {
    project: proj,
    workitems: workitemsRel,
    tasks: tasksRel,
    expenses: expensesRel,
    designs: designsRel,
    journal: journal,
    milestones: milestonesRel
  };
}

async function gatherProjectRelatedScoped(token, projectId, cfg, readOpts, appToken) {
  const proj = await getRecordById(token, cfg.tables.projects, projectId, appToken, readOpts);
  if (!proj) throw new Error('找不到標案');

  const linkedWiIds = getProjectWiIds(proj);
  const [workitemsByProj, linkedWorkitems] = await Promise.all([
    searchRecordsByLinkFieldsAny(token, cfg.tables.workitems, '所屬標案', [projectId], appToken, readOpts),
    batchGetRecords(token, cfg.tables.workitems, linkedWiIds, appToken, readOpts)
  ]);
  let workitemsRel = gatherWorkitemsForProject(proj, mergeRecordsById(workitemsByProj, linkedWorkitems), [proj]);
  if (!workitemsRel.length) {
    const allWorkitems = await getRecords(token, cfg.tables.workitems, appToken, readOpts);
    workitemsRel = gatherWorkitemsForProject(proj, allWorkitems, [proj]);
  }

  const wiIds = workitemsRel.map(function(w) { return w.record_id; });
  const wiIdSet = {};
  wiIds.forEach(function(id) { wiIdSet[id] = 1; });

  const [tasksRel, expensesByWi, expensesByProjA, expensesByProjB, journalByA, journalByB, designsRel, milestonesRel] = await Promise.all([
    searchRecordsByLinkFieldsAny(token, cfg.tables.tasks, '所屬工作項目', wiIds, appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.expenses, '所屬工作項目', wiIds, appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.expenses, '所數標案', [projectId], appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.expenses, '所屬標案', [projectId], appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.journal, '所屬標案', [projectId], appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.journal, '所屬專案', [projectId], appToken, readOpts),
    searchRecordsByLinkFieldsAny(token, cfg.tables.designs, '所屬工作項目', wiIds, appToken, readOpts),
    cfg.tables.milestones
      ? searchRecordsByLinkFieldsAny(token, cfg.tables.milestones, '所屬標案', [projectId], appToken, readOpts).catch(function() { return []; })
      : Promise.resolve([])
  ]);
  const expensesRel = mergeRecordsById(expensesByWi, expensesByProjA, expensesByProjB).filter(function(e) {
    var ewiIds = getLinkIds(e.fields['所屬工作項目']);
    if (ewiIds.some(function(id) { return wiIdSet[id]; })) return true;
    return getExpenseProjIds(e.fields).indexOf(projectId) >= 0;
  });
  const journal = mergeRecordsById(journalByA, journalByB).filter(function(r) {
    return journalBelongsToProject(r, projectId);
  });

  return {
    project: proj,
    workitems: workitemsRel,
    tasks: tasksRel,
    expenses: expensesRel,
    designs: designsRel,
    journal: journal,
    milestones: milestonesRel || []
  };
}

async function gatherProjectRelated(token, projectId) {
  const cfg = getOperationalBitableConfig();
  const readOpts = { userIdType: 'open_id' };
  const appToken = cfg.appToken;
  try {
    return await gatherProjectRelatedScoped(token, projectId, cfg, readOpts, appToken);
  } catch (scopedErr) {
    console.warn('標案範圍查詢失敗，改為全表讀取', scopedErr.message || scopedErr);
    return gatherProjectRelatedFullScan(token, projectId, cfg, readOpts);
  }
}

// ══════════════════════════════════════════════════════
// AI 分析
// ══════════════════════════════════════════════════════

function summarizeTasksForPrompt(tasks) {
  return tasks.map(function(t) {
    const f = t.fields || {};
    const due = f['預計完成日'] ? new Date(f['預計完成日']).toISOString().slice(0, 10) : '無期限';
    const overdueDays = f['預計完成日'] ? Math.floor((Date.now() - f['預計完成日']) / 86400000) : null;
    const progress = f['進度數值'] || 0;
    const isOverdue = overdueDays !== null && overdueDays > 0 && progress < 100;
    return {
      name: f['任務名稱'] || '未命名任務',
      status: f['進度狀態'] || '未開始',
      progress: progress,
      due: due,
      overdueDays: isOverdue ? overdueDays : 0
    };
  });
}

function summarizeExpensesForPrompt(expenses) {
  let total = 0;
  expenses.forEach(function(e) {
    total += parseFloat((e.fields || {})['實際金額']) || 0;
  });
  return { count: expenses.length, totalSpent: total };
}

function summarizeWorkitemsForPrompt(workitems) {
  return workitems.map(function(w) {
    const f = w.fields || {};
    return {
      name: f['工作項目名稱'] || '未命名',
      assignee: personDisplayName(f['負責夥伴']) || '未指定',
      weight: f['權重'] || 0
    };
  });
}

function buildAnalysisPromptText(bundle) {
  const proj = bundle.project.fields || {};
  const budget = parseFloat(proj['合約金額']) || 0;
  const available = parseFloat(proj['可用成本']) || 0;

  const data = {
    專案名稱: proj['標案名稱'] || '未命名標案',
    合約金額: budget,
    可用成本: available,
    工作項目: summarizeWorkitemsForPrompt(bundle.workitems),
    任務清單: summarizeTasksForPrompt(bundle.tasks),
    支出彙總: summarizeExpensesForPrompt(bundle.expenses)
  };

  return '你是專案管理分析助理。根據以下 JSON 格式的專案資料，進行分析。\n\n'
    + '專案資料：\n' + JSON.stringify(data, null, 2) + '\n\n'
    + '請只回傳 JSON，不要有任何其他文字、不要用 markdown 標記（不要加 ```json），格式如下：\n'
    + '{\n'
    + '  "progress_summary": "1-2句話說明目前處於哪個階段，是否符合預定時程",\n'
    + '  "risk_alert": "列出逾期或有風險的任務，包含逾期天數與可能影響；若無逾期則寫「目前無逾期風險」",\n'
    + '  "cost_analysis": "目前花費是否符合預算、有無超支風險，1-2句話",\n'
    + '  "team_allocation": "根據工作項目的負責夥伴，說明分工現況，2-3句話",\n'
    + '  "next_actions": "2-3條具體、可執行的下一步建議，用「、」分隔"\n'
    + '}\n\n'
    + '每個欄位請簡潔，整份 JSON 控制在 800 字以內；risk_alert 若有多項請用「1.」「2.」編號且每項換行；編號標題用【高風險】【中風險】等標記。\n'
    + '語氣專業、直接，不要客套話，不要編造資料中沒有的內容。';
}

// ── 呼叫 Claude API ──
async function callClaudeApi(messages, options) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY 環境變數');
  const body = {
    model: (options && options.model) || 'claude-sonnet-4-6',
    max_tokens: (options && options.maxTokens) || 1024,
    messages: messages
  };
  if (options && options.tools) body.tools = options.tools;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.type === 'error') {
    throw new Error('Claude API error: ' + (data.error && data.error.message || JSON.stringify(data)));
  }
  return data;
}

function extractClaudeText(data) {
  const blocks = (data.content || []).filter(function(b) { return b.type === 'text'; });
  return blocks.map(function(b) { return b.text; }).join('\n').trim();
}

function parseClaudeJson(text) {
  let cleaned = String(text || '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Claude 回傳非合法 JSON：' + cleaned.slice(0, 200));
  }
}

function calcTaskCompletionPct(tasks) {
  const list = tasks || [];
  if (!list.length) return 0;
  let sum = 0;
  list.forEach(function(t) {
    const f = t.fields || {};
    const p = parseFloat(f['進度數值']) || 0;
    const status = f['進度狀態'] || '';
    if (status === '已完成' || p >= 100) sum += 100;
    else sum += Math.min(100, Math.max(0, p));
  });
  return Math.round(sum / list.length);
}

function countOverdueTasks(tasks) {
  return summarizeTasksForPrompt(tasks || []).filter(function(t) { return t.overdueDays > 0; }).length;
}

function getLatestJournalDayMerge(journalRecords, taskMap) {
  const byDay = {};
  (journalRecords || []).forEach(function(r) {
    const ts = journalRecordTs(r);
    if (!ts) return;
    const d = new Date(ts);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(r);
  });
  const keys = Object.keys(byDay).sort().reverse();
  if (!keys.length) return { recs: [], merge: null, dateKey: '' };
  const recs = byDay[keys[0]];
  return { recs: recs, merge: mergeJournalSummaries(recs, taskMap), dateKey: keys[0] };
}

function categorizeTasksByStatus(tasks) {
  const result = { done: [], doing: [], block: [], notStarted: [] };
  (tasks || []).forEach(function(t) {
    const f = t.fields || {};
    const name = f['任務名稱'] || '未命名';
    const status = f['進度狀態'] || '';
    const p = parseFloat(f['進度數值']) || 0;
    if (status === '已完成' || p >= 100) result.done.push(name);
    else if (/卡關|阻塞/.test(status)) result.block.push(name);
    else if (p > 0 || /進行|持續/.test(status)) result.doing.push(name);
    else result.notStarted.push(name);
  });
  return result;
}

function formatJournalSummaryText(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^【.+?】\s*/g, '');
  const slash = s.match(/：(.+)$/);
  if (slash && slash[1]) s = slash[1].trim();
  return s.slice(0, 30);
}

function buildOverallSummaryFromJournal(latestRecs, merged, cats) {
  if (merged && merged.notes && merged.notes.length) {
    const excerpt = formatJournalSummaryText(merged.notes.join(' '));
    if (excerpt) return excerpt;
  }
  const parts = [];
  if (cats.done.length) parts.push('已完成' + cats.done.length + '項');
  if (cats.doing.length) parts.push('進行' + cats.doing.length + '項');
  if (cats.block.length) parts.push('卡關' + cats.block.length + '項');
  if (cats.notStarted.length) parts.push('未開始' + cats.notStarted.length + '項');
  let fallback = parts.join('，');
  if (!fallback) fallback = latestRecs && latestRecs.length ? '已取最近日報' : '本月尚無日報紀錄';
  return fallback.slice(0, 30);
}

function buildJournalSnapshot(journalRecords, tasks, taskMap) {
  const d = new Date();
  const monthLabel = (d.getMonth() + 1) + '月';
  const hasJournal = !!(journalRecords && journalRecords.length);
  const latest = getLatestJournalDayMerge(journalRecords, taskMap);
  let cats = { done: [], doing: [], block: [], notStarted: [] };
  const allTaskNames = (tasks || []).map(function(t) {
    return (t.fields && t.fields['任務名稱']) || '未命名';
  });

  if (latest.merge) {
    cats.done = latest.merge.done.slice();
    cats.doing = latest.merge.doing.slice();
    cats.block = latest.merge.block.slice();
    const listed = {};
    function mark(arr) { arr.forEach(function(n) { listed[n] = 1; }); }
    mark(cats.done);
    mark(cats.doing);
    mark(cats.block);
    latest.merge.tomorrow.forEach(function(n) {
      if (!listed[n]) { cats.doing.push(n); listed[n] = 1; }
    });
    allTaskNames.forEach(function(name) {
      if (!listed[name]) cats.notStarted.push(name);
    });
  }

  const noJournalMsg = '此標案尚無墨日誌日報紀錄，請至墨日誌填寫今日回報。';
  return {
    monthLabel: monthLabel,
    hasJournal: hasJournal && !!latest.merge,
    done: cats.done,
    doing: cats.doing,
    block: cats.block,
    notStarted: cats.notStarted,
    counts: {
      done: cats.done.length,
      doing: cats.doing.length,
      block: cats.block.length,
      notStarted: cats.notStarted.length
    },
    overallSummary: (hasJournal && latest.merge)
      ? buildOverallSummaryFromJournal(latest.recs, latest.merge, cats)
      : noJournalMsg,
    snapshotDate: latest.dateKey || ''
  };
}

function buildTaskAnalysis(bundle, snapshot) {
  const tasks = summarizeTasksForPrompt(bundle.tasks || []);
  const overdue = tasks.filter(function(t) { return t.overdueDays > 0; })
    .sort(function(a, b) { return b.overdueDays - a.overdueDays; });
  const blocked = (snapshot && snapshot.block) ? snapshot.block.slice() : [];
  const parts = [];
  if (blocked.length) {
    parts.push('【卡關】' + blocked.join('、') + '。建議今日確認卡關原因、責任分工與預計解除日。');
  }
  overdue.forEach(function(t) {
    parts.push('【逾期】' + t.name + '（逾期 ' + t.overdueDays + ' 天）：建議立即追蹤進度或調整完成日，避免影響後續時程。');
  });
  if (!parts.length) {
    return '目前無卡關或逾期任務，可維持現有進度；建議持續更新墨日誌以便追蹤。';
  }
  return parts.join('\n\n');
}

function computeProjectMetrics(bundle, journalRecords) {
  const taskMap = buildTaskNameMap(bundle.tasks);
  const completionPct = calcTaskCompletionPct(bundle.tasks);
  const overdueCount = countOverdueTasks(bundle.tasks);
  const weekRecs = journalRecordsOnDay(journalRecords, 7);
  let weekAgoCompletionPct = null;
  let weekAgoOverdueCount = null;
  if (weekRecs.length) {
    const merged = mergeJournalSummaries(weekRecs, taskMap);
    const total = merged.doing.length + merged.done.length + merged.block.length + merged.tomorrow.length;
    if (total) weekAgoCompletionPct = Math.round((merged.done.length / total) * 100);
    weekAgoOverdueCount = merged.block.length;
  }
  let weekDeltaPct = null;
  if (weekAgoCompletionPct != null) weekDeltaPct = completionPct - weekAgoCompletionPct;
  const d = new Date();
  const journalSnapshot = buildJournalSnapshot(journalRecords, bundle.tasks, taskMap);
  return {
    completionPct: completionPct,
    overdueCount: overdueCount,
    weekDeltaPct: weekDeltaPct,
    weekAgoCompletionPct: weekAgoCompletionPct,
    weekAgoOverdueCount: weekAgoOverdueCount,
    analysisDate: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
    journalSnapshot: journalSnapshot,
    taskAnalysis: buildTaskAnalysis(bundle, journalSnapshot)
  };
}

async function runProjectAnalysis(projectId, larkToken) {
  const bundle = await gatherProjectRelatedWithJournal(larkToken, projectId);
  const metrics = computeProjectMetrics(bundle, bundle.journal || []);
  const promptText = buildAnalysisPromptText(bundle);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const maxTokens = attempt === 0 ? 2048 : 4096;
    const claudeRes = await callClaudeApi([
      { role: 'user', content: promptText }
    ], { maxTokens });
    const text = extractClaudeText(claudeRes);
    try {
      const analysis = parseClaudeJson(text);
      return { bundle: bundle, analysis: analysis, metrics: metrics };
    } catch (err) {
      lastError = err;
      if (claudeRes.stop_reason === 'max_tokens' || attempt === 0) continue;
      throw err;
    }
  }
  throw lastError || new Error('Claude 分析失敗');
}

function notifyTrim(text, maxLen) {
  maxLen = maxLen || 300;
  const s = String(text || '').replace(/\r/g, '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

function formatAnalysisNotifyMessage(projectName, analysis, metrics) {
  metrics = metrics || {};
  analysis = analysis || {};
  const lines = [];
  lines.push('【AI 分析完成】');
  lines.push('----------------');
  lines.push('專案：' + (projectName || '專案') + (metrics.analysisDate ? '（' + metrics.analysisDate + '）' : ''));
  lines.push('');
  if (metrics.completionPct != null) {
    let kpi = '完成度 ' + metrics.completionPct + '%｜逾期 ' + (metrics.overdueCount != null ? metrics.overdueCount : '—') + ' 件';
    if (metrics.weekDeltaPct != null) {
      kpi += '｜較上週 ' + (metrics.weekDeltaPct >= 0 ? '+' : '') + metrics.weekDeltaPct + '%';
    }
    lines.push(kpi);
    lines.push('');
  }
  function section(num, title, body) {
    const t = notifyTrim(body, 280);
    if (!t) return;
    lines.push('■ ' + num + '. ' + title);
    lines.push(t);
    lines.push('');
  }
  section('1', '進度概況', analysis.progress_summary);
  section('2', '風險與逾期', analysis.risk_alert);
  section('3', '成本分析', analysis.cost_analysis);
  section('4', '人力分工', analysis.team_allocation);
  section('5', '下一步建議', analysis.next_actions);
  lines.push('-- 璽墨專案管理 --');
  return lines.join('\n');
}

function formatLatestFollowupNotify(question, reply) {
  const ts = new Date().toLocaleString('zh-TW', { hour12: false });
  return [
    '【AI 追問回覆】' + ts,
    '----------------',
    'Q：' + notifyTrim(question, 200),
    '',
    'A：' + notifyTrim(reply, 500),
    '',
    '-- 璽墨專案管理 --'
  ].join('\n');
}

async function saveAnalysisRecord(larkToken, userToken, projectId, analysis, triggeredByOpenId, extras) {
  extras = extras || {};
  const tableId = tableIdFor('ai_analysis');
  if (!tableId) throw new Error('未設定 AI 分析表（LARK_TABLE_AI_ANALYSIS）');
  const appToken = appTokenForTable('ai_analysis');
  const fields = {
    '專案': [projectId],
    '日期': Date.now(),
    '進度概況': analysis.progress_summary || '',
    '風險與逾期': analysis.risk_alert || '',
    '成本分析': analysis.cost_analysis || '',
    '人力分工': analysis.team_allocation || '',
    '下一步建議': analysis.next_actions || '',
    '通知摘要': formatAnalysisNotifyMessage(extras.projectName, analysis, extras.metrics)
    // 「分析時間」為 Lark 自動建立時間欄位，不需手動寫入
  };
  if (triggeredByOpenId) fields['觸發人'] = [{ id: triggeredByOpenId }];
  const normalized = await normalizeWriteFields(larkToken, tableId, fields, appToken);
  const notifyDropped = fields['通知摘要'] && !normalized['通知摘要'];
  const triggerDropped = triggeredByOpenId && !normalized['觸發人'];
  const writeFn = userToken ? writePreferUserFirst : writeWithUserFallback;
  const result = await writeFn(larkToken, userToken, function(tok, asUser) {
    return createRecord(tok, tableId, normalized, appToken, asUser);
  });
  if (notifyDropped) result._notifyFieldMissing = '通知摘要';
  if (triggerDropped) result._triggerFieldMissing = true;
  return result;
}

// 把追問對話存回同一筆分析紀錄（累加寫入「追問紀錄」欄位）
async function appendFollowupToRecord(larkToken, userToken, analysisRecordId, question, reply) {
  const tableId = tableIdFor('ai_analysis');
  if (!tableId) throw new Error('未設定 AI 分析表（LARK_TABLE_AI_ANALYSIS）');
  const appToken = appTokenForTable('ai_analysis');
  const existing = await getRecords(larkToken, tableId, appToken);
  const rec = existing.find(function(r) { return r.record_id === analysisRecordId; });
  const prevText = (rec && rec.fields && rec.fields['追問紀錄']) || '';
  const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
  const newLine = '[' + timestamp + ']\nQ: ' + question + '\nA: ' + reply;
  const merged = prevText ? (prevText + '\n\n' + newLine) : newLine;
  const latestNotify = formatLatestFollowupNotify(question, reply);
  const normalized = await normalizeWriteFields(larkToken, tableId, {
    '追問紀錄': merged,
    '最新追問': latestNotify
  }, appToken);
  const followDropped = latestNotify && !normalized['最新追問'];
  const writeFn = userToken ? writePreferUserFirst : writeWithUserFallback;
  const result = await writeFn(larkToken, userToken, function(tok, asUser) {
    return updateRecord(tok, tableId, analysisRecordId, normalized, appToken, asUser);
  });
  if (followDropped) result._notifyFieldMissing = '最新追問';
  return result;
}

// ── 追問：從資料庫查詢（日報／任務／支出），不依賴對話歷史 ──
const DESIGN_CAT_MARKER = '__XIMA_DSG__';

function parseFieldTs(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function journalRecordTs(rec) {
  const f = (rec && rec.fields) || {};
  const keys = ['日期', '日報日期', '日誌日期'];
  for (let i = 0; i < keys.length; i++) {
    const ts = parseFieldTs(f[keys[i]]);
    if (ts) return ts;
  }
  return null;
}

function journalBelongsToProject(rec, projectId) {
  const f = (rec && rec.fields) || {};
  return getLinkIds(f['所屬標案'] || f['所屬專案']).indexOf(projectId) >= 0;
}

function stripDesignMarkerFromNote(text) {
  const idx = String(text || '').indexOf(DESIGN_CAT_MARKER);
  if (idx < 0) return String(text || '').trim();
  return String(text).slice(0, idx).trim();
}

function dayStartMs(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (daysAgo || 0));
  return d.getTime();
}

function formatDayLabel(daysAgo) {
  const d = new Date(dayStartMs(daysAgo));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    + (daysAgo === 0 ? '（今天）' : ('（' + daysAgo + '天前）'));
}

function buildTaskNameMap(tasks) {
  const map = {};
  (tasks || []).forEach(function(t) {
    map[t.record_id] = (t.fields && t.fields['任務名稱']) || '未命名任務';
  });
  return map;
}

function journalRecordsOnDay(journalRecords, daysAgo) {
  const start = dayStartMs(daysAgo);
  const end = start + 86400000;
  return (journalRecords || []).filter(function(r) {
    const ts = journalRecordTs(r);
    return ts != null && ts >= start && ts < end;
  });
}

function summarizeJournalRecord(rec, taskMap) {
  const f = (rec && rec.fields) || {};
  function names(key) {
    return getLinkIds(f[key]).map(function(id) { return taskMap[id] || id; });
  }
  const note = stripDesignMarkerFromNote(f['備註'] || f['日誌內容'] || f['內容'] || '');
  return {
    doing: names('進行中任務'),
    done: names('已完成今日任務'),
    block: names('卡關任務'),
    tomorrow: names('明日預計任務'),
    note: note ? note.slice(0, 400) : ''
  };
}

function mergeJournalSummaries(recs, taskMap) {
  const merged = { doing: [], done: [], block: [], tomorrow: [], notes: [] };
  (recs || []).forEach(function(r) {
    const s = summarizeJournalRecord(r, taskMap);
    ['doing', 'done', 'block', 'tomorrow'].forEach(function(k) {
      s[k].forEach(function(name) {
        if (merged[k].indexOf(name) < 0) merged[k].push(name);
      });
    });
    if (s.note && merged.notes.indexOf(s.note) < 0) merged.notes.push(s.note);
  });
  return merged;
}

function summarizeJournalDayPoint(journalRecords, taskMap, daysAgo) {
  const recs = journalRecordsOnDay(journalRecords, daysAgo);
  const label = formatDayLabel(daysAgo);
  if (!recs.length) {
    return { 日期: label, 有日報: false, 說明: '此日無日報紀錄' };
  }
  const merged = mergeJournalSummaries(recs, taskMap);
  return {
    日期: label,
    有日報: true,
    進行中: merged.doing,
    今日完成: merged.done,
    卡關: merged.block,
    明日預計: merged.tomorrow,
    備註摘要: merged.notes.join(' / ').slice(0, 500)
  };
}

function buildCompactProjectSnapshot(bundle) {
  const tasks = summarizeTasksForPrompt(bundle.tasks || []);
  const overdue = tasks.filter(function(t) { return t.overdueDays > 0; });
  const done = tasks.filter(function(t) { return t.progress >= 100 || t.status === '已完成'; });
  const inProgress = tasks.filter(function(t) { return t.progress > 0 && t.progress < 100 && t.status !== '已完成'; });
  return {
    任務總數: tasks.length,
    已完成: done.length,
    進行中: inProgress.length,
    逾期中: overdue.length,
    逾期任務: overdue.slice(0, 10).map(function(t) { return t.name + '（逾期' + t.overdueDays + '天）'; }),
    支出合計: summarizeExpensesForPrompt(bundle.expenses || []).totalSpent
  };
}

function buildSpendingInRange(expenses, daysAgoStart, daysAgoEnd) {
  const from = dayStartMs(daysAgoEnd);
  const to = dayStartMs(daysAgoStart) + 86400000;
  let total = 0;
  let count = 0;
  (expenses || []).forEach(function(e) {
    const ts = parseFieldTs((e.fields || {})['日期']);
    if (ts == null || ts < from || ts >= to) return;
    total += parseFloat((e.fields || {})['實際金額']) || 0;
    count++;
  });
  return {
    區間: formatDayLabel(daysAgoEnd) + ' ~ ' + formatDayLabel(daysAgoStart),
    筆數: count,
    合計: total
  };
}

function parseDaysAgoFromQuestion(question) {
  const text = String(question || '');
  const days = [];
  if (/今天|目前|現在|今日/.test(text)) days.push(0);
  if (/昨天/.test(text)) days.push(1);
  if (/前天/.test(text)) days.push(2);
  if (/三天前|3天前/.test(text)) days.push(3);
  if (/上週|上星期|一週前|1週前|7天前|七天前/.test(text)) days.push(7);
  if (/兩週前|二週前|14天前|兩星期前/.test(text)) days.push(14);
  if (/上個月|30天前/.test(text)) days.push(30);
  const unique = [];
  days.forEach(function(d) { if (unique.indexOf(d) < 0) unique.push(d); });
  if (/差|比較|對比|變化|進展|跟上週|跟上次/.test(text)) {
    if (unique.indexOf(0) < 0) unique.unshift(0);
    if (unique.length < 2) unique.push(7);
  }
  if (!unique.length) unique.push(0);
  return unique.sort(function(a, b) { return a - b; });
}

function journalCompletionPct(point) {
  if (!point || !point.有日報) return null;
  const total = (point.進行中 || []).length + (point.今日完成 || []).length + (point.卡關 || []).length + (point.明日預計 || []).length;
  if (!total) return null;
  return Math.round(((point.今日完成 || []).length / total) * 100);
}

function buildFollowupAnswerHints(bundle, taskMap, userQuestion) {
  const daysPoints = parseDaysAgoFromQuestion(userQuestion);
  const journalRecords = bundle.journal || [];
  const hints = [];
  const taskPct = calcTaskCompletionPct(bundle.tasks || []);
  hints.push('目前任務整體完成度約 ' + taskPct + '%');
  daysPoints.forEach(function(d) {
    const pt = summarizeJournalDayPoint(journalRecords, taskMap, d);
    const dayLabel = formatDayLabel(d).replace(/（.+）$/, '');
    if (pt.有日報) {
      const pct = journalCompletionPct(pt);
      hints.push(dayLabel + '日報：完成 ' + (pt.今日完成 || []).length + ' 項、進行中 ' + (pt.進行中 || []).length + ' 項、卡關 ' + (pt.卡關 || []).length + ' 項'
        + (pct != null ? '（日報完成度約 ' + pct + '%）' : ''));
    } else {
      hints.push(dayLabel + '：無日報紀錄');
    }
  });
  const overdue = countOverdueTasks(bundle.tasks || []);
  if (overdue) hints.push('目前逾期任務 ' + overdue + ' 件');
  const snap = buildCompactProjectSnapshot(bundle);
  if (snap.逾期任務 && snap.逾期任務.length) {
    hints.push('逾期項目：' + snap.逾期任務.slice(0, 3).join('、'));
  }
  return hints;
}

function buildFollowupDbContext(bundle, taskMap, userQuestion) {
  const daysPoints = parseDaysAgoFromQuestion(userQuestion);
  const journalRecords = bundle.journal || [];
  const timePoints = daysPoints.map(function(d) {
    return summarizeJournalDayPoint(journalRecords, taskMap, d);
  });
  const spending = [];
  if (daysPoints.length >= 2) {
    const maxDay = Math.max.apply(null, daysPoints);
    spending.push(buildSpendingInRange(bundle.expenses, 0, maxDay));
  } else {
    spending.push(buildSpendingInRange(bundle.expenses, 0, 7));
  }
  return {
    專案名稱: (bundle.project.fields || {})['標案名稱'] || '未命名',
    回答參考摘要: buildFollowupAnswerHints(bundle, taskMap, userQuestion),
    查詢時間點: timePoints,
    任務現況: buildCompactProjectSnapshot(bundle),
    支出區間: spending
  };
}

function buildFollowupSystemPrompt(context, question) {
  return '你是專案管理分析助理。下方「內部資料」僅供你閱讀，禁止原樣貼給使用者。\n\n'
    + '【回答規則】\n'
    + '1. 用繁體中文、口語化，像 PM 向主管口頭匯報\n'
    + '2. 第一句直接回答問題（比較、升降、好壞）\n'
    + '3. 再用 2～4 個簡短要點補充關鍵數字與風險，每點一行，以「·」開頭\n'
    + '4. 禁止：JSON、欄位名、Markdown（##、---、| 表格、**）、「資料來源」「查詢時間點」等系統用語\n'
    + '5. 數字融入句子（例：「目前完成約 16%，較上週…」），不要列報表或表格\n'
    + '6. 優先參考「回答參考摘要」，需要細節時再查內部其他欄位\n'
    + '7. 全篇 300 字以內\n\n'
    + '【內部資料】\n' + JSON.stringify(context, null, 2) + '\n\n'
    + '【使用者問題】\n' + question;
}

function humanizeFollowupReply(text) {
  let s = String(text || '').trim();
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^-{3,}\s*$/gm, '');
  s = s.replace(/^\|.+\|\s*$/gm, '');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/^.*(?:資料來源|查詢時間點|資料庫即時查詢|Lark 資料庫).*$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function gatherProjectRelatedWithJournal(token, projectId) {
  return gatherProjectRelated(token, projectId);
}

const AI_FOLLOWUP_TOOLS = [
  {
    name: 'get_journal_summary',
    description: '查詢此專案在指定天數前的日報摘要。days_ago=0 表示今天，7 表示一週前。',
    input_schema: {
      type: 'object',
      properties: {
        days_ago: { type: 'number', description: '幾天前（0=今天）' }
      },
      required: ['days_ago']
    }
  },
  {
    name: 'compare_periods',
    description: '比較兩個時間點的日報與任務現況差異。',
    input_schema: {
      type: 'object',
      properties: {
        days_ago_a: { type: 'number', description: '較近時間點（0=今天）' },
        days_ago_b: { type: 'number', description: '較早時間點（如 7=一週前）' }
      },
      required: ['days_ago_a', 'days_ago_b']
    }
  },
  {
    name: 'get_design_status',
    description: '查詢此專案的設計任務：進度、設計師、預算與實際花費。',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

function summarizeDesignsForTool(designs) {
  return (designs || []).map(function(d) {
    const f = d.fields || {};
    return {
      name: f['主類別'] || f['設計項目名稱'] || '未命名',
      status: f['進度狀態'] || '未開始',
      designer: personDisplayName(f['設計師']) || '未指定',
      budget: f['預算金費'] || f['預算'] || 0,
      spent: f['實際花費'] || 0
    };
  });
}

function executeFollowupTool(name, input, bundle, taskMap) {
  if (name === 'get_design_status') {
    return JSON.stringify(summarizeDesignsForTool(bundle.designs || []));
  }
  if (name === 'get_journal_summary') {
    const daysAgo = Number(input && input.days_ago) || 0;
    return JSON.stringify(summarizeJournalDayPoint(bundle.journal || [], taskMap, daysAgo));
  }
  if (name === 'compare_periods') {
    const a = Number(input && input.days_ago_a) || 0;
    const b = Number(input && input.days_ago_b) || 7;
    return JSON.stringify({
      較近: summarizeJournalDayPoint(bundle.journal || [], taskMap, a),
      較早: summarizeJournalDayPoint(bundle.journal || [], taskMap, b),
      任務現況: buildCompactProjectSnapshot(bundle)
    });
  }
  return JSON.stringify({ error: 'unknown tool: ' + name });
}

async function runFollowupWithTools(messages, bundle, taskMap) {
  let currentMessages = messages.slice();
  for (let round = 0; round < 4; round++) {
    const claudeRes = await callClaudeApi(currentMessages, {
      maxTokens: 800,
      tools: AI_FOLLOWUP_TOOLS
    });
    const toolUses = (claudeRes.content || []).filter(function(b) { return b.type === 'tool_use'; });
    if (!toolUses.length) {
      const text = humanizeFollowupReply(extractClaudeText(claudeRes));
      if (text) return text;
      throw new Error('Claude 未回傳有效內容');
    }
    const toolResults = toolUses.map(function(tu) {
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: executeFollowupTool(tu.name, tu.input || {}, bundle, taskMap)
      };
    });
    currentMessages = currentMessages.concat([
      { role: 'assistant', content: claudeRes.content },
      { role: 'user', content: toolResults }
    ]);
  }
  throw new Error('追問查詢次數過多，請簡化問題後再試');
}

async function runProjectFollowup(projectId, larkToken, userQuestion) {
  const bundle = await gatherProjectRelatedWithJournal(larkToken, projectId);
  const taskMap = buildTaskNameMap(bundle.tasks);
  const ctx = buildFollowupDbContext(bundle, taskMap, userQuestion);
  const messages = [{
    role: 'user',
    content: buildFollowupSystemPrompt(ctx, userQuestion)
  }];
  return runFollowupWithTools(messages, bundle, taskMap);
}

async function batchCreateRecords(token, appToken, tableId, fieldsList, tableLabel) {
  if (!fieldsList.length) return [];
  const created = [];
  const chunkSize = 100;
  const label = tableLabel || tableId;
  for (let i = 0; i < fieldsList.length; i += chunkSize) {
    const chunk = fieldsList.slice(i, i + chunkSize);
    const url = BASE_URL + '/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables/' + encodeURIComponent(tableId) + '/records/batch_create?user_id_type=open_id';
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

function stripArchiveFieldsByTypes(fields, fieldMeta, typeMap) {
  const out = Object.assign({}, fields || {});
  Object.keys(out).forEach(function(name) {
    const meta = fieldMeta[name];
    if (meta && typeMap[meta.type]) delete out[name];
  });
  return out;
}

function softenArchiveFieldsList(fieldsList, fieldMeta, level) {
  return fieldsList.map(function(fields) {
    if (level === 1) {
      return stripArchiveFieldsByTypes(fields, fieldMeta, { 3: 1, 4: 1 });
    }
    if (level === 2) {
      return stripArchiveFieldsByTypes(fields, fieldMeta, { 3: 1, 4: 1, 11: 1, 15: 1 });
    }
    const out = {};
    const keepKeys = ['標案名稱', '工作項目名稱', '任務名稱', '支出細項', '主類別', '設計項目名稱', '里程碑名稱', '標題', '名稱'];
    keepKeys.forEach(function(k) {
      if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') out[k] = fields[k];
    });
    Object.keys(fields).forEach(function(name) {
      const meta = fieldMeta[name];
      if (meta && BITABLE_LINK_FIELD_TYPES[meta.type] && fields[name]) out[name] = fields[name];
    });
    return out;
  });
}

async function batchCreateArchiveRecords(token, appToken, tableId, fieldsList, tableLabel, fieldMeta) {
  const attempts = [
    { fieldsList: fieldsList, note: '' },
    { fieldsList: softenArchiveFieldsList(fieldsList, fieldMeta, 1), note: '略過選項欄位' },
    { fieldsList: softenArchiveFieldsList(fieldsList, fieldMeta, 2), note: '略過人員/連結欄位' },
    { fieldsList: softenArchiveFieldsList(fieldsList, fieldMeta, 3), note: '僅保留名稱與關聯' }
  ];
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    if (!att.fieldsList.length) continue;
    const hasPayload = att.fieldsList.some(function(f) { return f && Object.keys(f).length; });
    if (!hasPayload) continue;
    try {
      return await batchCreateRecords(token, appToken, tableId, att.fieldsList, tableLabel);
    } catch (err) {
      if (!isRetryableWriteError(err)) throw err;
      errors.push((att.note || '重試') + '：' + (err.message || String(err)));
    }
  }
  throw new Error(errors.join('；') || (tableLabel || tableId) + '：寫入失敗');
}

async function copyProjectBundleToWikiBase(token, bundle, wikiUrl, wikiToken) {
  const projectName = bundle.project.fields['標案名稱'] || '封存標案';
  const target = await resolveOrCreateWikiBitableTarget(token, wikiUrl, projectName, wikiToken);
  const targetApp = target.appToken;
  const tableMap = target.tableMap;
  const finalWikiUrl = target.wikiUrl || wikiUrl;
  const fieldCache = {};

  const projSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.projects, fieldCache);
  const projAllowed = projSchemas.allowedSet;
  const projMeta = projSchemas.fieldMeta;
  const projOverrides = {};
  if (projAllowed['狀態']) {
    const stMeta = projMeta['狀態'];
    if (stMeta && (stMeta.type === 1 || stMeta.type === 13)) projOverrides['狀態'] = '封存';
  }
  if (finalWikiUrl) applyWikiUrlOverrides(projOverrides, projAllowed, projMeta, finalWikiUrl);
  const projBuilt = await buildEnrichedArchiveFields(token, bundle.project.fields, projAllowed, projMeta, projOverrides);
  const projCreated = await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.projects, [projBuilt.fields], '標案', projMeta);
  const newProjId = projCreated[0] && projCreated[0].record_id;
  if (!newProjId) throw new Error('複製標案至知識庫失敗');
  await patchArchivePersonFields(wikiToken, targetApp, tableMap.projects, newProjId, projBuilt.personPatch);

  const wiSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.workitems, fieldCache);
  const wiAllowed = wiSchemas.allowedSet;
  const wiMeta = wiSchemas.fieldMeta;
  const wiLinkField = pickProjectLinkFieldName(wiAllowed) || '所屬標案';
  const wiMap = {};
  const wiBuiltList = [];
  const wiFieldsList = [];
  for (let wiIdx = 0; wiIdx < bundle.workitems.length; wiIdx++) {
    const wi = bundle.workitems[wiIdx];
    const overrides = {};
    if (wiAllowed[wiLinkField]) overrides[wiLinkField] = [newProjId];
    const built = await buildEnrichedArchiveFields(token, wi.fields, wiAllowed, wiMeta, overrides);
    wiBuiltList.push(built);
    wiFieldsList.push(built.fields);
  }
  const wiCreated = await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.workitems, wiFieldsList, '工作項目', wiMeta);
  bundle.workitems.forEach(function(wi, i) {
    if (wiCreated[i]) wiMap[wi.record_id] = wiCreated[i].record_id;
  });
  for (let wiPatchIdx = 0; wiPatchIdx < wiCreated.length; wiPatchIdx++) {
    if (wiCreated[wiPatchIdx] && wiBuiltList[wiPatchIdx]) {
      await patchArchivePersonFields(wikiToken, targetApp, tableMap.workitems, wiCreated[wiPatchIdx].record_id, wiBuiltList[wiPatchIdx].personPatch);
    }
  }

  if (projAllowed['工作項目'] && wiCreated.length) {
    const newWiIds = wiCreated.map(function(r) { return r.record_id; }).filter(Boolean);
    if (newWiIds.length) {
      await updateBitableRecord(wikiToken, targetApp, tableMap.projects, newProjId, {
        '工作項目': newWiIds.map(String)
      });
    }
  }

  const taskSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.tasks, fieldCache);
  const taskAllowed = taskSchemas.allowedSet;
  const taskMeta = taskSchemas.fieldMeta;
  const taskBuiltList = [];
  const taskFieldsList = [];
  for (let ti = 0; ti < bundle.tasks.length; ti++) {
    const t = bundle.tasks[ti];
    const overrides = {};
    const oldWi = getLinkIds(t.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && taskAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    const built = await buildEnrichedArchiveFields(token, t.fields, taskAllowed, taskMeta, overrides);
    taskBuiltList.push(built);
    taskFieldsList.push(built.fields);
  }
  const taskCreated = await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.tasks, taskFieldsList, '任務', taskMeta);
  for (let tpi = 0; tpi < taskCreated.length; tpi++) {
    if (taskCreated[tpi] && taskBuiltList[tpi]) {
      await patchArchivePersonFields(wikiToken, targetApp, tableMap.tasks, taskCreated[tpi].record_id, taskBuiltList[tpi].personPatch);
    }
  }

  const expSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.expenses, fieldCache);
  const expAllowed = expSchemas.allowedSet;
  const expMeta = expSchemas.fieldMeta;
  const expProjField = pickProjectLinkFieldName(expAllowed);
  const expBuiltList = [];
  const expFieldsList = [];
  for (let ei = 0; ei < bundle.expenses.length; ei++) {
    const e = bundle.expenses[ei];
    const overrides = {};
    const oldWi = getLinkIds(e.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && expAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    if (expProjField) overrides[expProjField] = [newProjId];
    const built = await buildEnrichedArchiveFields(token, e.fields, expAllowed, expMeta, overrides);
    expBuiltList.push(built);
    expFieldsList.push(built.fields);
  }
  const expCreated = await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.expenses, expFieldsList, '支出', expMeta);
  for (let epi = 0; epi < expCreated.length; epi++) {
    if (expCreated[epi] && expBuiltList[epi]) {
      await patchArchivePersonFields(wikiToken, targetApp, tableMap.expenses, expCreated[epi].record_id, expBuiltList[epi].personPatch);
    }
  }

  const desSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.designs, fieldCache);
  const desAllowed = desSchemas.allowedSet;
  const desMeta = desSchemas.fieldMeta;
  const desBuiltList = [];
  const desFieldsList = [];
  for (let di = 0; di < bundle.designs.length; di++) {
    const d = bundle.designs[di];
    const overrides = {};
    const oldWi = getLinkIds(d.fields['所屬工作項目'])[0];
    if (oldWi && wiMap[oldWi] && desAllowed['所屬工作項目']) overrides['所屬工作項目'] = [wiMap[oldWi]];
    const built = await buildEnrichedArchiveFields(token, d.fields, desAllowed, desMeta, overrides);
    desBuiltList.push(built);
    desFieldsList.push(built.fields);
  }
  const desCreated = await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.designs, desFieldsList, '設計', desMeta);
  for (let dpi = 0; dpi < desCreated.length; dpi++) {
    if (desCreated[dpi] && desBuiltList[dpi]) {
      await patchArchivePersonFields(wikiToken, targetApp, tableMap.designs, desCreated[dpi].record_id, desBuiltList[dpi].personPatch);
    }
  }

  if (tableMap.milestones && bundle.milestones && bundle.milestones.length) {
    const msSchemas = await getTableFieldSchemas(wikiToken, targetApp, tableMap.milestones, fieldCache);
    const msAllowed = msSchemas.allowedSet;
    const msMeta = msSchemas.fieldMeta;
    const msFieldsList = [];
    for (let mi = 0; mi < bundle.milestones.length; mi++) {
      const m = bundle.milestones[mi];
      const overrides = {};
      if (msAllowed['所屬標案']) overrides['所屬標案'] = [newProjId];
      const oldWi = getLinkIds((m.fields || {})['展開工作項目'])[0];
      if (oldWi && wiMap[oldWi] && msAllowed['展開工作項目']) overrides['展開工作項目'] = [wiMap[oldWi]];
      const built = await buildEnrichedArchiveFields(token, m.fields, msAllowed, msMeta, overrides);
      if (built.fields['已產生任務']) delete built.fields['已產生任務'];
      msFieldsList.push(built.fields);
    }
    await batchCreateArchiveRecords(wikiToken, targetApp, tableMap.milestones, msFieldsList, '履約里程碑', msMeta);
  }

  return { copied: true, newProjectId: newProjId, targetAppToken: targetApp, wikiUrl: finalWikiUrl, wikiFolderUrl: target.wikiFolderUrl || wikiUrl };
}

function countMilestonesInBundle(bundle) {
  if (bundle && bundle.milestones && bundle.milestones.length) return bundle.milestones.length;
  return countMilestonesInProjectField(bundle && bundle.project);
}

function countMilestonesInProjectField(proj) {
  if (!proj || !proj.fields) return 0;
  const raw = proj.fields['履約里程碑'] || proj.fields['里程碑'] || '';
  if (!raw) return 0;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && Array.isArray(parsed.items)) return parsed.items.length;
  } catch (e) {}
  return 0;
}

async function archiveProject(token, projectId, wikiUrl, userAccessToken) {
  const bundle = await gatherProjectRelated(token, projectId);
  const name = bundle.project.fields['標案名稱'] || '';
  const milestoneCount = countMilestonesInBundle(bundle);
  const summary = '工作項目 ' + bundle.workitems.length + ' 筆、任務 ' + bundle.tasks.length
    + ' 筆、支出 ' + bundle.expenses.length + ' 筆、設計 ' + bundle.designs.length
    + ' 筆、履約里程碑 ' + milestoneCount + ' 筆';

  if (!String(userAccessToken || '').trim()) {
    return {
      ok: false,
      projectName: name,
      summary: summary,
      counts: {
        workitems: bundle.workitems.length,
        tasks: bundle.tasks.length,
        expenses: bundle.expenses.length,
        designs: bundle.designs.length,
        milestones: milestoneCount
      },
      copiedToWikiBase: false,
      wikiUrl: wikiUrl,
      copyError: '封存至知識庫必須先 Lark 登入（wiki + 多維表格授權）。',
      needsUserLogin: true
    };
  }

  let finalWikiUrl = wikiUrl;
  let copyError = '';
  let copiedToWiki = false;
  try {
    const copyResult = await copyProjectBundleToWikiBase(token, bundle, wikiUrl, userAccessToken);
    finalWikiUrl = copyResult.wikiUrl || wikiUrl;
    copiedToWiki = true;
  } catch (err) {
    copyError = formatArchiveCopyError(err.message || String(err));
    return {
      ok: false,
      projectName: name,
      summary: summary,
      counts: {
        workitems: bundle.workitems.length,
        tasks: bundle.tasks.length,
        expenses: bundle.expenses.length,
        designs: bundle.designs.length,
        milestones: milestoneCount
      },
      copiedToWikiBase: false,
      wikiUrl: wikiUrl,
      copyError: copyError
    };
  }

  let statusWarning = '';
  let statusUpdated = false;
  let srcAllowed = null;
  const cfg = getOperationalBitableConfig();
  const userTok = String(userAccessToken || '').trim();

  async function tryUpdateProjectFields(fields) {
    const normalized = await normalizeWriteFields(token, cfg.tables.projects, fields, cfg.appToken);
    const body = normalized && Object.keys(normalized).length ? normalized : fields;
    if (!body || !Object.keys(body).length) return false;
    await writeWithUserFallback(token, userTok, function(tok, asUser) {
      return updateRecord(tok, cfg.tables.projects, projectId, body, cfg.appToken, asUser);
    });
    return true;
  }

  try {
    const srcFieldCache = {};
    const srcSchemas = await getTableFieldSchemas(token, cfg.appToken, cfg.tables.projects, srcFieldCache);
    srcAllowed = srcSchemas.allowedSet;
    const srcMeta = srcSchemas.fieldMeta;
    const safeUpdate = { '狀態': '封存', '封存摘要': summary };
    if (finalWikiUrl) {
      applyWikiUrlOverrides(safeUpdate, srcAllowed, srcMeta, finalWikiUrl, ['知識庫連結', '封存連結', 'Wiki連結']);
    }
    if (wikiUrl) {
      applyWikiUrlOverrides(safeUpdate, srcAllowed, srcMeta, normalizeWikiInputUrl(wikiUrl), ['Wiki存放位置']);
    }
    statusUpdated = await tryUpdateProjectFields(safeUpdate);
  } catch (err) {
    statusWarning = formatArchiveCopyError(err.message || String(err));
    if (srcAllowed && srcAllowed['狀態']) {
      try {
        statusUpdated = await tryUpdateProjectFields({ '狀態': '封存' });
        if (statusUpdated) statusWarning = '';
      } catch (retryErr) {
        statusWarning = formatArchiveCopyError(retryErr.message || String(retryErr));
      }
    }
  }

  return {
    ok: true,
    projectName: name,
    summary: summary,
    statusUpdated: statusUpdated,
    statusWarning: statusWarning,
    counts: {
      workitems: bundle.workitems.length,
      tasks: bundle.tasks.length,
      expenses: bundle.expenses.length,
      designs: bundle.designs.length,
      milestones: milestoneCount
    },
    copiedToWikiBase: copiedToWiki,
    wikiUrl: finalWikiUrl,
    wikiNote: statusWarning
      ? '資料已寫入知識庫，但 PM 後台狀態未能自動更新'
      : '已封存至知識庫'
  };
}
 
function parseWebhookUrls(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map(function(u) { return u.trim(); })
    .filter(Boolean);
}

function getWebhookUrls() {
  const urls = [];
  const add = function(list) {
    list.forEach(function(u) {
      if (urls.indexOf(u) < 0) urls.push(u);
    });
  };
  add(parseWebhookUrls(process.env.LARK_WEBHOOK_URL));
  add(parseWebhookUrls(process.env.LARK_WEBHOOK_URL_EXTRA));
  return urls;
}

async function sendWebhookToUrl(url, text, keyword) {
  let bodyText = String(text || '');
  if (keyword && bodyText.indexOf(keyword) < 0) bodyText = keyword + '\n' + bodyText;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: bodyText } })
  });
  const data = await res.json();
  if (data.StatusCode !== 0 && data.code !== 0) {
    const errMsg = data.msg || data.StatusMessage || 'webhook failed';
    const hint = errMsg.indexOf('Key Words') >= 0
      ? errMsg + '（請在 Vercel 設定 LARK_WEBHOOK_KEYWORD 為機器人關鍵字，或關閉機器人關鍵字驗證）'
      : errMsg;
    return { ok: false, error: hint, raw: data, url: url };
  }
  return { ok: true, raw: data, url: url };
}

async function sendWebhook(text) {
  const urls = getWebhookUrls();
  if (!urls.length) return { ok: false, skipped: true, reason: 'LARK_WEBHOOK_URL not set' };
  const keyword = (process.env.LARK_WEBHOOK_KEYWORD || '').trim();
  const results = await Promise.all(urls.map(function(url) {
    return sendWebhookToUrl(url, text, keyword);
  }));
  const failed = results.filter(function(r) { return !r.ok; });
  if (!failed.length) {
    return { ok: true, count: results.length, results: results };
  }
  if (failed.length === results.length) {
    return Object.assign({ ok: false, count: results.length, results: results }, failed[0]);
  }
  return {
    ok: true,
    partial: true,
    count: results.length,
    failedCount: failed.length,
    results: results,
    error: failed.map(function(r) { return r.error; }).filter(Boolean).join('；')
  };
}

function aiAnalysisDmNotifyEnabled() {
  const raw = (process.env.AI_ANALYSIS_DM_NOTIFY || 'on').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== 'skip' && raw !== '0';
}

async function sendImTextToOpenId(tenantToken, openId, text) {
  const receiveId = String(openId || '').trim();
  if (!receiveId || !isValidPersonOpenId(receiveId)) {
    return { ok: false, skipped: true, reason: 'invalid open_id' };
  }
  const bodyText = String(text || '').trim();
  if (!bodyText) return { ok: false, skipped: true, reason: 'empty text' };
  const url = BASE_URL + '/im/v1/messages?receive_id_type=open_id';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tenantToken,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: bodyText.slice(0, 4000) })
    })
  });
  const data = await res.json();
  if (data.code !== 0) {
    let hint = data.msg || 'im send failed';
    if (/permission|scope|90208|99991672/i.test(hint)) {
      hint += '（請在 Lark 開發者後台開啟 im:message、im:message:send_as_bot 並重新發布）';
    }
    return { ok: false, error: hint, code: data.code };
  }
  return { ok: true, messageId: data.data && data.data.message_id };
}

async function findProjectNameById(larkToken, projectId) {
  try {
    const cfg = getOperationalBitableConfig();
    const records = await getRecords(larkToken, tableIdFor('projects'), cfg.appToken);
    const rec = records.find(function(r) { return r.record_id === projectId; });
    return (rec && rec.fields && rec.fields['標案名稱']) || '';
  } catch (e) {
    return '';
  }
}

async function sendAiAnalysisDm(larkToken, openId, projectName, notifyText) {
  const title = 'AI分析｜' + (projectName || '專案');
  const text = title + '\n----------------\n' + String(notifyText || '').trim();
  return sendImTextToOpenId(larkToken, openId, text);
}

async function sendAiFollowupDm(larkToken, openId, projectName, question, reply) {
  const title = 'AI追問｜' + (projectName || '專案');
  const text = title + '\n----------------\n' + formatLatestFollowupNotify(question, reply);
  return sendImTextToOpenId(larkToken, openId, text);
}

function paymentApplicantText(fields) {
  if (!fields) return '';
  if (fields._applicantDisplayName) return String(fields._applicantDisplayName).trim();
  const a = fields['申請人'];
  if (!a) return '';
  if (typeof a === 'string') return a.trim();
  if (Array.isArray(a) && a[0]) {
    if (a[0].name) return String(a[0].name).trim();
    if (a[0].en_name) return String(a[0].en_name).trim();
    if (a[0].id && !/^ou_/i.test(String(a[0].id))) return String(a[0].id).trim();
  }
  return '';
}

function findApplicantFieldName(allowedSet) {
  const names = ['申請人', '申請人員', 'Applicant', '申请人'];
  for (let i = 0; i < names.length; i++) {
    if (allowedSet[names[i]]) return names[i];
  }
  return '';
}

function applyApplicantTextFallback(fields, allowedSet) {
  const displayName = paymentApplicantText(fields);
  if (!displayName) return;
  const fallbacks = ['申請人姓名', '申请人姓名', '申請人名稱', '申请人', '申請人文字'];
  fallbacks.forEach(function(name) {
    if (allowedSet[name] && !fields[name]) fields[name] = displayName;
  });
}

async function resolveApplicantOpenId(tenantToken, userToken, rawName, hintOpenId) {
  let openId = String(hintOpenId || '').trim();
  if (openId && !/^ou_/i.test(openId) && !/^on_/i.test(openId)) openId = '';
  if (openId) return openId;

  let loginUser = null;
  if (userToken) {
    try { loginUser = await getUserInfoFromToken(userToken); } catch (e) {}
  }
  if (loginUser) {
    const tokenOpenId = String(loginUser.open_id || '').trim();
    const tokenNames = [loginUser.name, loginUser.en_name].map(function(s) { return String(s || '').trim(); }).filter(Boolean);
    if (tokenOpenId) {
      if (!rawName) return tokenOpenId;
      for (let i = 0; i < tokenNames.length; i++) {
        if (namesMatch(rawName, tokenNames[i])) return tokenOpenId;
      }
    }
  }
  if (rawName) {
    const members = await getRecords(tenantToken, tableIdFor('members'), appTokenForTable('members'));
    for (let i = 0; i < members.length; i++) {
      const mf = members[i].fields || {};
      const mn = getMemberName(mf);
      if (mn && namesMatch(mn, rawName)) {
        openId = getMemberPersonOpenId(mf);
        if (openId) break;
      }
    }
  }
  return openId;
}

function injectApplicantIntoBody(body, fields, allowedSet, fieldMeta) {
  const key = findApplicantFieldName(allowedSet);
  if (!key || body[key]) return body;
  const src = fields['申請人'];
  if (!src) return body;
  const meta = fieldMeta[key];
  if (!meta || meta.type !== 11) return body;
  const norm = normalizePersonFieldValue(src);
  if (norm) body[key] = norm;
  return body;
}

function buildPaymentPrintPath(fields) {
  const params = new URLSearchParams();
  function set(k, v) {
    if (v !== undefined && v !== null && String(v).trim()) params.set(k, String(v).trim());
  }
  set('dept', fields['申請部門']);
  const dateVal = fields['申請日期'];
  if (dateVal) {
    const d = new Date(dateVal);
    if (!isNaN(d.getTime())) {
      set('date', d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }
  }
  set('payee', fields['支付對象']);
  set('vendor', fields['廠商名稱']);
  set('method', fields['支付方式']);
  set('reason', fields['事由']);
  set('remark', fields['備註']);
  const total = fields['付款總金額'];
  if (total !== undefined && total !== null && String(total).trim()) {
    set('total', String(total).replace(/[^0-9.]/g, ''));
  }
  const nature = fields['支付性質'];
  if (Array.isArray(nature) && nature.length) set('nature', nature.join(','));
  else if (nature) set('nature', String(nature).replace(/、/g, ','));
  const applicant = paymentApplicantText(fields);
  if (applicant) set('applicant', applicant);
  const q = params.toString();
  return q ? 'payment-print.html?' + q : 'payment-print.html';
}

async function sendPaymentNotify(fields) {
  const site = (process.env.SITE_URL || 'https://ximo-pm.vercel.app').replace(/\/$/, '');
  const printPath = buildPaymentPrintPath(fields || {});
  const printUrl = site + '/' + printPath;
  const amount = fields && fields['付款總金額'];
  const amountStr = amount ? 'NT$' + Number(amount).toLocaleString() : '';
  const notifyTo = process.env.PAYMENT_NOTIFY_TARGET || '會計';
  const text = [
    '【標案·付款申請待處理】',
    '通知對象：' + notifyTo,
    '申請人：' + paymentApplicantText(fields),
    '申請部門：' + (fields['申請部門'] || ''),
    '支付對象：' + (fields['支付對象'] || ''),
    '事由：' + (fields['事由'] || ''),
    '金額：' + amountStr,
    printUrl,
    '已送出審批，請依流程線上簽核 👇'
  ].join('\n');
  const result = await sendWebhook(text);
  return Object.assign({ notifyTo: notifyTo, printUrl: printUrl }, result);
}

function paymentNotifyMode() {
  const raw = (process.env.PAYMENT_NOTIFY_MODE || '').trim().toLowerCase();
  if (raw === 'automation' || raw === 'lark' || raw === 'skip' || raw === 'off' || raw === 'false') return 'automation';
  if (raw === 'both') return 'both';
  return 'app';
}

async function maybeSendPaymentNotify(fields) {
  const mode = paymentNotifyMode();
  if (mode === 'automation') {
    return {
      ok: true,
      skipped: true,
      mode: 'automation',
      reason: '已略過 App 通知，改由 Lark 多維表格自動化發送'
    };
  }
  const result = await sendPaymentNotify(fields);
  result.mode = mode;
  return result;
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

async function loginWithOAuthCode(code, redirectUri, opts) {
  opts = opts || {};
  let accessToken = null;
  let expiresIn = 7200;
  let refreshToken = '';
  let refreshExpiresIn = 0;
  let lastErr = '';

  async function exchangeOnce(useRedirect, useRedirectUri) {
    const appToken = await getAppAccessToken();
    const v1Body = { grant_type: 'authorization_code', code: code };
    if (useRedirect && useRedirectUri) v1Body.redirect_uri = useRedirectUri;
    const v1Res = await fetch(BASE_URL + '/authen/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + appToken
      },
      body: JSON.stringify(v1Body)
    });
    const tokenData = await v1Res.json();
    if (tokenData.code === 0 && tokenData.data && tokenData.data.access_token) {
      return {
        accessToken: tokenData.data.access_token,
        expiresIn: Number(tokenData.data.expires_in) || 7200,
        refreshToken: tokenData.data.refresh_token || '',
        refreshExpiresIn: Number(tokenData.data.refresh_expires_in) || 0
      };
    }
    throw new Error(tokenData.msg || tokenData.message || JSON.stringify(tokenData));
  }

  const attempts = [];
  if (opts.fromLarkJsapi) {
    attempts.push({ useRedirect: false, redirect: '' });
  } else {
    const redirects = redirectUri ? redirectUriVariants(redirectUri) : [''];
    redirects.forEach(function(r) {
      attempts.push({ useRedirect: !!r, redirect: r });
    });
    attempts.push({ useRedirect: false, redirect: '' });
  }

  for (let i = 0; i < attempts.length; i++) {
    try {
      const hit = await exchangeOnce(attempts[i].useRedirect, attempts[i].redirect);
      accessToken = hit.accessToken;
      expiresIn = hit.expiresIn;
      refreshToken = hit.refreshToken || '';
      refreshExpiresIn = hit.refreshExpiresIn || 0;
      break;
    } catch (e) {
      lastErr = e.message || lastErr;
    }
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
    userId: u.user_id || '',
    accessToken: accessToken,
    expiresIn: expiresIn,
    refreshToken: refreshToken,
    refreshExpiresIn: refreshExpiresIn
  };
}

async function refreshUserAccessToken(refreshToken) {
  const token = String(refreshToken || '').trim();
  if (!token) throw new Error('缺少 refresh_token');
  const appToken = await getAppAccessToken();
  const res = await fetch(BASE_URL + '/authen/v1/refresh_access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + appToken
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: token
    })
  });
  const data = await res.json();
  if (data.code !== 0 || !data.data || !data.data.access_token) {
    throw new Error(data.msg || data.message || '無法刷新登入狀態');
  }
  const d = data.data;
  return {
    accessToken: d.access_token,
    expiresIn: Number(d.expires_in) || 7200,
    refreshToken: d.refresh_token || token,
    refreshExpiresIn: Number(d.refresh_expires_in) || 0
  };
}

function buildAuthUrl(redirectUri) {
  const q = new URLSearchParams({
    app_id: APP_ID,
    redirect_uri: redirectUri,
    state: 'ximo_pm',
    scope: 'offline_access'
  });
  return BASE_URL + '/authen/v1/index?' + q.toString();
}

function getOAuthSetupHint(redirectUri) {
  const variants = redirectUriVariants(redirectUri);
  return [
    '1. 请用国际版开发者后台：https://open.larksuite.com/app（不是 open.feishu.cn 飞书）',
    '2. 打开 App ID 为 ' + (APP_ID || '（未设定）') + ' 的应用 → 凭证与基础信息核对',
    '3. 开发配置 → 安全设置 → 重定向 URL 须包含（建议两条都加）：' + variants.join(' 或 '),
    '4. 版本管理与发布 → 创建版本并发布（仅保存 URL 不会生效）',
    '5. 群机器人 webhook 与 OAuth 是不同设置；webhook 不影响登入'
  ].join('\n');
}

function fieldTextValue(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw) && raw.length) return fieldTextValue(raw[0]);
  if (raw && typeof raw === 'object') {
    if (raw.text) return String(raw.text).trim();
    if (raw.name) return String(raw.name).trim();
    if (raw.text_arr && raw.text_arr[0]) return String(raw.text_arr[0]).trim();
  }
  return String(raw).trim();
}

function normalizePersonNameKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_＿\-－]+/g, '');
}

/** 去掉常見員工代碼後綴，例如 吳詩涵__YDXM25 → 吳詩涵 */
function personNameCore(s) {
  return String(s || '')
    .trim()
    .replace(/[_\s＿]*[A-Za-z]{0,8}\d{2,}[A-Za-z0-9]*$/u, '')
    .replace(/[_\s＿]+$/g, '')
    .trim();
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  a = String(a).trim();
  b = String(b).trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const na = normalizePersonNameKey(a);
  const nb = normalizePersonNameKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0) return true;
  const ca = normalizePersonNameKey(personNameCore(a));
  const cb = normalizePersonNameKey(personNameCore(b));
  if (ca && cb && (ca === cb || ca.indexOf(cb) >= 0 || cb.indexOf(ca) >= 0)) return true;
  return false;
}

function collectPersonFromValue(val, ids, names) {
  if (!val) return;
  if (typeof val === 'string' && val.trim()) {
    names.push(val.trim());
    return;
  }
  const items = Array.isArray(val) ? val : [val];
  items.forEach(function(x) {
    if (!x) return;
    if (typeof x === 'string' && x.trim()) names.push(x.trim());
    if (x.id) ids.push(String(x.id).trim());
    if (x.open_id) ids.push(String(x.open_id).trim());
    if (x.user_id) ids.push(String(x.user_id).trim());
    if (x.union_id) ids.push(String(x.union_id).trim());
    if (x.name) names.push(String(x.name).trim());
    if (x.en_name) names.push(String(x.en_name).trim());
    if (x.enName) names.push(String(x.enName).trim());
  });
}

function listMemberPersonIds(fields) {
  const ids = [];
  const names = [];
  const priorityKeys = ['帳號', '成員', '姓名', '名稱', '人員', 'Member', 'Account', '英文名', 'English Name', 'Name'];
  priorityKeys.forEach(function(k) { collectPersonFromValue(fields[k], ids, names); });
  Object.keys(fields || {}).forEach(function(k) {
    const v = fields[k];
    if (!v) return;
    if (Array.isArray(v) && v[0] && (v[0].id || v[0].open_id || v[0].name)) {
      collectPersonFromValue(v, ids, names);
    } else if (v && typeof v === 'object' && !Array.isArray(v) && (v.id || v.open_id || v.name)) {
      collectPersonFromValue(v, ids, names);
    }
  });
  const extra = fieldTextValue(fields['open_id'] || fields['Open ID'] || fields['user_id'] || fields['User ID'] || fields['userid']);
  if (extra) ids.push(extra);
  return ids.filter(Boolean);
}

function listMemberPersonNames(fields) {
  const names = [];
  const ids = [];
  const priorityKeys = ['帳號', '成員', '姓名', '名稱', '人員', 'Member', 'Account', '顯示名稱', '英文名', 'English Name', 'Name'];
  priorityKeys.forEach(function(k) { collectPersonFromValue(fields[k], ids, names); });
  Object.keys(fields || {}).forEach(function(k) {
    const v = fields[k];
    if (!v) return;
    if (typeof v === 'string' && v.trim() && /名|Name|Account|帳號|人員|成員/i.test(k)) {
      names.push(v.trim());
      return;
    }
    if (Array.isArray(v) && v[0] && (v[0].id || v[0].name || v[0].en_name || v[0].enName)) collectPersonFromValue(v, ids, names);
    else if (v && typeof v === 'object' && !Array.isArray(v) && (v.id || v.name || v.en_name || v.enName)) collectPersonFromValue(v, ids, names);
  });
  return names.filter(Boolean);
}

function getMemberPersonOpenId(fields) {
  const ids = listMemberPersonIds(fields);
  for (let i = 0; i < ids.length; i++) {
    if (isValidPersonOpenId(ids[i])) return ids[i];
  }
  return '';
}

function getMemberName(fields) {
  const names = listMemberPersonNames(fields);
  return names[0] || '';
}

function collectMemberRoleTokens(fields) {
  const tokens = [];
  function pushRaw(raw) {
    if (raw == null || raw === '') return;
    if (Array.isArray(raw)) {
      raw.forEach(pushRaw);
      return;
    }
    if (typeof raw === 'object') {
      if (raw.text) tokens.push(String(raw.text).trim());
      else if (raw.name) tokens.push(String(raw.name).trim());
      else if (Array.isArray(raw.text_arr)) {
        raw.text_arr.forEach(function(t) { tokens.push(String(t).trim()); });
      }
      return;
    }
    tokens.push(String(raw).trim());
  }
  const f = fields || {};
  pushRaw(f['角色']);
  pushRaw(f['Role']);
  pushRaw(f['標籤']);
  pushRaw(f['Tag']);
  pushRaw(f['Tags']);
  return tokens.filter(Boolean);
}

function isDesignLeadRoleToken(raw) {
  const r = String(raw || '').trim();
  if (!r) return false;
  if (r === '設計主管' || r === '设计主管') return true;
  if (r.indexOf('設計主管') >= 0 || r.indexOf('设计主管') >= 0) return true;
  const lower = r.toLowerCase();
  return lower === 'design_lead' || lower === 'design-lead' || lower === 'design lead' || lower === 'design supervisor';
}

function isDesignerRoleToken(raw) {
  const r = String(raw || '').trim();
  if (!r) return false;
  if (isDesignLeadRoleToken(r)) return false;
  if (r === '設計師' || r === '设计师') return true;
  return r.toLowerCase() === 'designer';
}

function isAdminRoleToken(raw) {
  const r = String(raw || '').trim();
  if (!r) return false;
  if (r === '管理員' || r === '管理员') return true;
  if (r.indexOf('管理員') >= 0 || r.indexOf('管理员') >= 0) return true;
  const lower = r.toLowerCase();
  return lower === 'admin' || lower === 'administrator';
}

function isAccountantRoleToken(raw) {
  const r = String(raw || '').trim();
  if (!r) return false;
  if (r === '會計' || r === '会计') return true;
  if (r.indexOf('會計') >= 0 || r.indexOf('会计') >= 0) return true;
  const lower = r.toLowerCase();
  return lower === 'accounting' || lower === 'accountant' || lower === 'finance';
}

function isAccountantMemberName(name) {
  return !!(accountingPersonKeyFromName(name));
}

function getMemberRole(fields) {
  // 「免日報」不影響登入權限；管理員全頁；設計主管／設計師限縮設計頁；會計只看會計前台
  const tokens = collectMemberRoleTokens(fields);
  for (let i = 0; i < tokens.length; i++) {
    if (isAdminRoleToken(tokens[i])) return '管理員';
  }
  for (let i = 0; i < tokens.length; i++) {
    if (isAccountantRoleToken(tokens[i])) return '會計';
  }
  for (let i = 0; i < tokens.length; i++) {
    if (isDesignLeadRoleToken(tokens[i])) return '設計主管';
  }
  for (let i = 0; i < tokens.length; i++) {
    if (isDesignerRoleToken(tokens[i])) return '設計師';
  }
  const memberName = getMemberName(fields);
  if (isAccountantMemberName(memberName)) return '會計';
  return 'PM';
}

function findMemberForUser(members, user) {
  const openId = String(user.openId || '').trim();
  const unionId = String(user.unionId || '').trim();
  const userId = String(user.userId || '').trim();
  const userNames = [user.name, user.enName].map(function(s) { return String(s || '').trim(); }).filter(Boolean);
  for (let i = 0; i < members.length; i++) {
    const f = members[i].fields || {};
    const personIds = listMemberPersonIds(f);
    if (openId && personIds.some(function(id) { return id === openId; })) return members[i];
    if (unionId && personIds.some(function(id) { return id === unionId; })) return members[i];
    const mUserId = fieldTextValue(f['user_id'] || f['User ID'] || f['userid']);
    if (userId && mUserId && userId === mUserId) return members[i];
    const mNames = listMemberPersonNames(f);
    for (let u = 0; u < userNames.length; u++) {
      for (let n = 0; n < mNames.length; n++) {
        if (namesMatch(mNames[n], userNames[u])) return members[i];
      }
    }
  }
  return null;
}

async function resolveTriggeredByOpenId(larkToken, userAccessToken, hintOpenId) {
  const hint = String(hintOpenId || '').trim();
  if (hint && isValidPersonOpenId(hint)) return hint;
  if (!userAccessToken) return '';
  try {
    const loginUser = await getUserInfoFromToken(userAccessToken);
    const oid = String(loginUser.openId || '').trim();
    if (oid && isValidPersonOpenId(oid)) return oid;
    const members = await getMembersRecords(larkToken);
    const memberRec = findMemberForUser(members, loginUser);
    if (memberRec) {
      const ids = listMemberPersonIds(memberRec.fields || {});
      for (let i = 0; i < ids.length; i++) {
        if (isValidPersonOpenId(ids[i])) return ids[i];
      }
    }
  } catch (e) {}
  return '';
}

function extractUserAccessToken(req) {
  const body = req.body || {};
  const fromBody = String(body.userAccessToken || body.user_access_token || '').trim();
  if (fromBody) return fromBody;
  const fromQuery = String(req.query.userAccessToken || '').trim();
  if (fromQuery) return fromQuery;
  const hdr = req.headers['x-user-access-token'] || req.headers['X-User-Access-Token'];
  return String(hdr || '').trim();
}

function stripAuthFromBody(body) {
  const out = Object.assign({}, body || {});
  delete out.userAccessToken;
  delete out.user_access_token;
  delete out.applicantOpenId;
  return out;
}

function extractApplicantOpenIdHint(body) {
  const b = body || {};
  return String(b.applicantOpenId || b.applicant_open_id || '').trim();
}

async function getUserInfoFromToken(userAccessToken) {
  const infoRes = await fetch(BASE_URL + '/authen/v1/user_info', {
    headers: { 'Authorization': 'Bearer ' + userAccessToken }
  });
  const info = await infoRes.json();
  if (info.code !== 0) throw new Error(info.msg || '無法取得使用者資訊');
  const u = info.data || {};
  return {
    name: u.name || u.en_name || '',
    enName: u.en_name || '',
    openId: u.open_id || '',
    userId: u.user_id || '',
    unionId: u.union_id || ''
  };
}

function isTableConfigError(err) {
  const msg = (err && err.message) || String(err || '');
  return msg.indexOf('TableIdNotFound') >= 0 || msg.indexOf('1254041') >= 0;
}

function tableConfigErrorMessage() {
  const backend = (process.env.LARK_APP_TOKEN_BACKEND || '').trim();
  if (backend) {
    return 'LARK_APP_TOKEN_BACKEND 與程式設定的表格 ID 不符（TableIdNotFound）。請確認 LARK_TABLE_PROFILE_BACKEND 或 LARK_TABLE_PROFILE 與該 Base 的表格 ID 一致，或開啟 /api/lark?action=tables-check 查看診斷。';
  }
  return 'LARK_APP_TOKEN 與程式設定的表格 ID 不符（TableIdNotFound）。請在 Vercel 將 LARK_APP_TOKEN 改成與正式多維表格相同的 Base app_token，或開啟 /api/lark?action=tables-check 查看診斷。';
}

async function buildTablesCheckReportForCfg(token, cfg, label) {
  if (!cfg || !cfg.appToken) {
    return { label: label, ok: false, error: '缺少 app_token' };
  }
  try {
    const resolved = await resolveBitableConfig(token, cfg);
    const listed = await listBitableTables(token, cfg.appToken);
    const ids = listed.map(function(t) { return t.table_id || t.id || ''; });
    const report = Object.keys(resolved.tables).map(function(key) {
      const resolvedId = resolved.tables[key];
      return {
        key: key,
        configuredId: cfg.tables[key],
        resolvedId: resolvedId,
        found: ids.indexOf(resolvedId) >= 0
      };
    });
    const missing = report.filter(function(r) { return !r.found; });
    return {
      label: label,
      ok: missing.length === 0,
      appTokenSuffix: cfg.appToken.slice(-6),
      tableCount: listed.length,
      tables: listed.map(function(t) {
        return { id: t.table_id || t.id, name: t.name || '' };
      }),
      report: report,
      missingKeys: missing.map(function(m) { return m.key; })
    };
  } catch (err) {
    return {
      label: label,
      ok: false,
      appTokenSuffix: cfg.appToken.slice(-6),
      error: err.message || String(err)
    };
  }
}

async function buildTablesCheckReport() {
  const token = await getToken();
  const front = getFrontBitableConfig();
  const backend = getBackendBitableConfig();
  const bases = [];
  if (front.appToken) bases.push(buildTablesCheckReportForCfg(token, front, 'front'));
  if (backend && backend.appToken && backend.appToken !== front.appToken) {
    bases.push(buildTablesCheckReportForCfg(token, backend, 'backend'));
  }
  if (!bases.length) {
    return { ok: false, error: '缺少 LARK_APP_TOKEN 環境變數' };
  }
  const results = await Promise.all(bases);
  return {
    ok: results.every(function(r) { return r.ok; }),
    tableProfile: resolveTableProfileKey(),
    tableProfileBackend: (process.env.LARK_TABLE_PROFILE_BACKEND || resolveTableProfileKey()).trim(),
    bases: results
  };
}

async function getMembersRecords(token, opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.bypassCache && _membersRecordsCache && _membersRecordsCache.expiresAt > now) {
    return _membersRecordsCache.records;
  }
  const cfg = getOperationalBitableConfig();
  // 必須用 open_id，才能與 OAuth user_info 的 open_id 對上
  const members = await getRecords(token, tableIdFor('members'), cfg.appToken, { userIdType: 'open_id' });
  _membersRecordsCache = {
    records: members,
    expiresAt: now + MEMBERS_CACHE_TTL_MS
  };
  return members;
}

async function checkMemberAuthorization(userAccessToken) {
  if (!userAccessToken) return { ok: true, needLogin: true, authorized: false };
  let user;
  try {
    user = await getUserInfoFromToken(userAccessToken);
  } catch (err) {
    return { ok: true, needLogin: true, authorized: false, error: err.message };
  }
  const tenantToken = await getToken();
  let members;
  try {
    // 登入權限檢查不走快取，避免剛加入人員表卻仍被擋
    members = await getMembersRecords(tenantToken, { bypassCache: true });
  } catch (err) {
    if (isTableConfigError(err)) {
      return {
        ok: false,
        needLogin: false,
        authorized: false,
        user,
        configError: tableConfigErrorMessage(),
        memberCount: 0
      };
    }
    throw err;
  }
  const memberRec = findMemberForUser(members, user);
  if (!memberRec) {
    return {
      ok: true,
      needLogin: false,
      authorized: false,
      user,
      memberCount: members.length,
      hint: '登入身分「' + ([user.name, user.enName].filter(Boolean).join(' / ') || '未知')
        + '」未對上人員表。請在「帳號」欄位用 Lark 人員選擇器選入本人（不要只打文字）。'
    };
  }
  const role = getMemberRole(memberRec.fields || {});
  return {
    ok: true,
    needLogin: false,
    authorized: true,
    role,
    memberName: getMemberName(memberRec.fields || {}),
    user
  };
}

const BOOTSTRAP_TABLE_KEYS = ['projects', 'workitems', 'tasks', 'expenses', 'designs', 'design_versions', 'journal', 'members', 'milestones', 'payments'];

async function fetchTableRecordsSafe(token, tableKey) {
  if (tableKey === 'payments') {
    const cfg = paymentsFrontConfig();
    if (!cfg.appToken) return { records: [], error: 'payments app token missing' };
    try {
      const tableId = await resolvePaymentsTableId(token, cfg.appToken, cfg.tableId);
      if (!tableId) return { records: [], error: 'Invalid table: payments' };
      const records = await getRecords(token, tableId, cfg.appToken);
      return { records: records };
    } catch (err) {
      console.error('bootstrap payments', err);
      return { records: [], error: err.message || String(err) };
    }
  }
  const tableId = tableIdFor(tableKey);
  if (!tableId) return { records: [], error: 'Invalid table: ' + tableKey };
  try {
    const tableAppToken = appTokenForTable(tableKey);
    const records = await getRecords(token, tableId, tableAppToken);
    return { records: records };
  } catch (err) {
    console.error('bootstrap ' + tableKey, err);
    return { records: [], error: err.message || String(err) };
  }
}

async function fetchBootstrapPayload() {
  const token = await getToken();
  const parts = await Promise.all(BOOTSTRAP_TABLE_KEYS.map(function(key) {
    return fetchTableRecordsSafe(token, key);
  }));
  const payload = { ok: true, ts: Date.now() };
  BOOTSTRAP_TABLE_KEYS.forEach(function(key, i) {
    payload[key] = parts[i];
  });
  return payload;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Access-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { table, recordId, action } = req.query;

  try {
    if (action === 'appid' && req.method === 'GET') {
      const redirectUri = getRedirectUriForRequest(req);
      return res.status(200).json({
        appId: APP_ID,
        redirectUri: redirectUri,
        redirectAllowlist: getRedirectAllowlist(),
        developerConsole: 'https://open.larksuite.com/app',
        oauthSetupHint: getOAuthSetupHint(redirectUri)
      });
    }

    if (action === 'jssdk-config' && req.method === 'GET') {
      const pageUrl = (req.query.url || '').trim();
      if (!pageUrl) return res.status(400).json({ error: 'missing url' });
      const token = await getToken();
      const cfg = await buildJssdkConfig(token, pageUrl);
      return res.status(200).json(cfg);
    }

    if (action === 'auth-url' && req.method === 'GET') {
      const redirect = getRedirectUriForRequest(req);
      return res.status(200).json({
        url: buildAuthUrl(redirect),
        appId: APP_ID,
        redirectUri: redirect,
        redirectUriAlternatives: redirectUriVariants(redirect),
        developerConsole: 'https://open.larksuite.com/app',
        oauthSetupHint: getOAuthSetupHint(redirect)
      });
    }

    if (action === 'login' && req.method === 'POST') {
      const code = req.body && req.body.code;
      if (!code) return res.status(400).json({ ok: false, error: 'missing code' });
      const fromLarkJsapi = !!(req.body && req.body.from_lark_jsapi);
      const redirectUri = fromLarkJsapi ? '' : (req.body.redirect_uri || '').trim();
      try {
        const user = await loginWithOAuthCode(code, redirectUri, { fromLarkJsapi: fromLarkJsapi });
        return res.status(200).json({ ok: true, user });
      } catch (loginErr) {
        return res.status(400).json({ ok: false, error: loginErr.message || '登入失敗' });
      }
    }

    if (action === 'auth-check' && req.method === 'GET') {
      const userAccessToken = extractUserAccessToken(req);
      const result = await checkMemberAuthorization(userAccessToken);
      return res.status(200).json(result);
    }

    if (action === 'bootstrap' && req.method === 'GET') {
      const raw = String(req.query.tables || '').trim();
      if (raw) {
        const keys = raw.split(',').map(function(s) { return s.trim(); }).filter(function(k) {
          return BOOTSTRAP_TABLE_KEYS.indexOf(k) >= 0;
        });
        const uniq = keys.filter(function(k, i) { return keys.indexOf(k) === i; });
        if (uniq.length) {
          const token = await getToken();
          const parts = await Promise.all(uniq.map(function(key) {
            return fetchTableRecordsSafe(token, key);
          }));
          const payload = { ok: true, ts: Date.now() };
          uniq.forEach(function(key, i) { payload[key] = parts[i]; });
          return res.status(200).json(payload);
        }
      }
      const payload = await fetchBootstrapPayload();
      return res.status(200).json(payload);
    }

    if (action === 'sync' && req.method === 'GET') {
      const raw = String(req.query.tables || '').trim();
      const keys = raw
        ? raw.split(',').map(function(s) { return s.trim(); }).filter(function(k) { return BOOTSTRAP_TABLE_KEYS.indexOf(k) >= 0; })
        : BOOTSTRAP_TABLE_KEYS.slice();
      const uniq = keys.filter(function(k, i) { return keys.indexOf(k) === i; });
      const token = await getToken();
      const parts = await Promise.all(uniq.map(function(key) {
        return fetchTableRecordsSafe(token, key);
      }));
      const payload = { ok: true, ts: Date.now() };
      uniq.forEach(function(key, i) { payload[key] = parts[i]; });
      return res.status(200).json(payload);
    }

    if (action === 'auth-refresh' && req.method === 'POST') {
      const refreshToken = String((req.body && req.body.refreshToken) || '').trim();
      if (!refreshToken) return res.status(400).json({ ok: false, error: 'missing refreshToken' });
      try {
        const tokens = await refreshUserAccessToken(refreshToken);
        return res.status(200).json({ ok: true, ...tokens });
      } catch (refreshErr) {
        return res.status(400).json({ ok: false, error: refreshErr.message || '刷新失敗' });
      }
    }

    if (action === 'tables-check' && req.method === 'GET') {
      const report = await buildTablesCheckReport();
      return res.status(200).json(report);
    }

    if (action === 'upload-attachment' && req.method === 'POST') {
      const b = stripAuthFromBody(req.body || {});
      const fileName = String(b.fileName || b.file_name || 'file').trim() || 'file';
      const contentBase64 = String(b.contentBase64 || b.data || '').trim();
      const tableKey = String(b.table || 'tasks').trim();
      if (!contentBase64) return res.status(400).json({ error: 'missing file data' });
      const buffer = Buffer.from(contentBase64, 'base64');
      if (!buffer.length) return res.status(400).json({ error: 'empty file' });
      if (buffer.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'file too large (max 20MB)' });
      const token = await getToken();
      let appToken = appTokenForTable(tableKey);
      if (tableKey === 'payments') {
        appToken = paymentsFrontConfig().appToken || appToken;
      }
      if (!appToken) return res.status(400).json({ error: 'missing app token for table' });
      const uploaded = await uploadBitableMedia(token, appToken, fileName, buffer);
      return res.status(200).json(uploaded);
    }

    if (action === 'download-attachment' && req.method === 'GET') {
      const fileToken = String(req.query.fileToken || '').trim();
      if (!fileToken) return res.status(400).json({ error: 'missing fileToken' });
      const token = await getToken();
      const url = await getMediaDownloadUrl(token, fileToken);
      if (!url) return res.status(404).json({ error: 'download url not found' });
      return res.status(200).json({ ok: true, url: url });
    }

    if (action === 'sync-payment-approvals' && req.method === 'GET') {
      const token = await getToken();
      const sync = await syncPendingPaymentApprovals(token);
      const cfg = paymentsFrontConfig();
      const tableId = await resolvePaymentsTableId(token, cfg.appToken, cfg.tableId);
      const records = tableId ? await getRecords(token, tableId, cfg.appToken) : [];
      const merged = mergePaymentApprovalMeta(records, sync.approvalMeta || {});
      return res.status(200).json({ ok: true, sync: sync, payments: { records: merged } });
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
        deploy: {
          commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12),
          ref: process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_REF || '',
          url: process.env.VERCEL_URL || ''
        },
        env: {
          tableProfile: resolveTableProfileKey(),
          operationalDataSource: (process.env.LARK_APP_TOKEN_BACKEND || '').trim() ? 'backend' : 'front',
          operationalAppTokenSuffix: getOperationalBitableConfig().appToken.slice(-6),
          writeMirrorCount: getBitableWriteTargets().mirrors.length,
          hasAppId: !!APP_ID,
          hasAppSecret: !!APP_SECRET,
          hasAppToken: !!APP_TOKEN,
          hasAppTokenBackend: !!(process.env.LARK_APP_TOKEN_BACKEND || '').trim(),
          hasAppTokenPayments: !!APP_TOKEN_PAYMENTS,
          hasWebhook: getWebhookUrls().length > 0,
          webhookCount: getWebhookUrls().length,
          hasWebhookKeyword: !!process.env.LARK_WEBHOOK_KEYWORD,
          paymentNotifyMode: paymentNotifyMode(),
          paymentApprovalCode: paymentApprovalCode(),
          paymentCashApprovalCodeSet: !!paymentCashApprovalCode(),
          paymentsTableMain: paymentsFrontConfig().tableId,
          paymentsTableAccounting: paymentsAccountingConfig().tableId,
          paymentsFrontUrlSet: !!(process.env.LARK_PAYMENTS_FRONTEND_URL || '').trim(),
          siteUrl: (process.env.SITE_URL || '').trim(),
          appIdLen: APP_ID ? APP_ID.length : 0,
          appSecretLen: APP_SECRET ? APP_SECRET.length : 0,
          appTokenLen: APP_TOKEN ? APP_TOKEN.length : 0,
          appTokenPaymentsLen: APP_TOKEN_PAYMENTS ? APP_TOKEN_PAYMENTS.length : 0,
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
        archiveTemplateConfigured: isArchiveTemplateConfigured()
      });
    }

    if (action === 'write-test' && req.method === 'GET') {
      const tenantToken = await getToken();
      const cfg = await resolveBitableConfig(tenantToken, getOperationalBitableConfig());
      const tableId = cfg.tables.projects;
      const testName = '寫入測試' + Date.now();
      const out = {
        appTokenSuffix: cfg.appToken.slice(-6),
        tableId: tableId,
        tests: []
      };
      async function tryCreate(label, authToken, asUser) {
        const body = await normalizeWriteFields(tenantToken, tableId, { '標案名稱': testName }, cfg.appToken);
        const url = buildMainRecordUrl(tableId, null, cfg.appToken, asUser);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: body })
        });
        const data = await res.json();
        const entry = { label: label, httpStatus: res.status, code: data.code, msg: data.msg || '' };
        if (data.code === 0) {
          const rid = extractRecordId(data);
          entry.recordId = rid;
          if (rid) {
            try {
              await deleteRecord(tenantToken, tableId, rid, cfg.appToken, asUser);
              entry.cleaned = true;
            } catch (delErr) {
              entry.cleaned = false;
              entry.cleanError = delErr.message || String(delErr);
            }
          }
        }
        out.tests.push(entry);
        return data.code === 0;
      }
      try {
        await tryCreate('tenant_app', tenantToken, false);
      } catch (e) {
        out.tests.push({ label: 'tenant_app', error: e.message || String(e) });
      }
      const userTok = extractUserAccessToken(req);
      if (userTok) {
        try {
          await tryCreate('user_token', userTok, true);
        } catch (e) {
          out.tests.push({ label: 'user_token', error: e.message || String(e) });
        }
      } else {
        out.note = '加上 ?userAccessToken=… 或登入後帶 X-User-Access-Token 可測使用者寫入';
      }
      out.ok = out.tests.some(function(t) { return t.code === 0; });
      return res.status(200).json(out);
    }

    if (action === 'project-import' && req.method === 'POST') {
      const tenantToken = await getToken();
      const userAccessToken = extractUserAccessToken(req);
      const b = stripAuthFromBody(req.body || {});
      const projectFields = b.project || {};
      const workitems = Array.isArray(b.workitems) ? b.workitems : [];
      const result = await createProjectImportBundle(tenantToken, userAccessToken, projectFields, workitems);
      return res.status(200).json(result);
    }

    if (action === 'workitems-import' && req.method === 'POST') {
      const tenantToken = await getToken();
      const userAccessToken = extractUserAccessToken(req);
      const b = stripAuthFromBody(req.body || {});
      const projectId = String(b.projectId || '').trim();
      const workitems = Array.isArray(b.workitems) ? b.workitems : [];
      if (!projectId) return res.status(400).json({ error: 'missing projectId' });
      const result = await createWorkItemsBundle(tenantToken, userAccessToken, projectId, workitems);
      return res.status(200).json(result);
    }

    if (action === 'archive-project' && req.method === 'POST') {
      const projectId = req.body && req.body.projectId;
      const wikiUrl = (req.body && req.body.wikiUrl || '').trim();
      const userAccessToken = (req.body && req.body.userAccessToken || '').trim();
      if (!projectId) return res.status(400).json({ error: 'missing projectId' });
      if (!wikiUrl) return res.status(400).json({ error: 'missing wikiUrl' });
      const token = await getToken();
      const result = await archiveProject(token, projectId, wikiUrl, userAccessToken);
      return res.status(200).json(result);
    }

    if (action === 'ai-analysis' && req.method === 'POST') {
      const projectId = req.body && req.body.projectId;
      if (!projectId) return res.status(400).json({ error: 'missing projectId' });
      const larkToken = await getToken();
      const userAccessTokenForAi = extractUserAccessToken(req);
      const hintOpenId = (req.body && req.body.triggeredByOpenId) || '';
      let triggeredByOpenId = '';
      try {
        triggeredByOpenId = await resolveTriggeredByOpenId(larkToken, userAccessTokenForAi, hintOpenId);
      } catch (e) { /* 觸發人可略過，不影響分析主流程 */ }
      try {
        const { analysis, metrics, bundle } = await runProjectAnalysis(projectId, larkToken);
        let saveWarning = '';
        let analysisRecordId = '';
        try {
          const projectName = (bundle.project && bundle.project.fields && bundle.project.fields['標案名稱']) || '未命名標案';
          const saved = await saveAnalysisRecord(larkToken, userAccessTokenForAi, projectId, analysis, triggeredByOpenId, {
            projectName: projectName,
            metrics: metrics
          });
          analysisRecordId = extractRecordId(saved) || '';
          if (saved && saved._notifyFieldMissing) {
            saveWarning = (saveWarning ? saveWarning + '\n' : '') + '請在「AI分析」表新增「' + saved._notifyFieldMissing + '」多行文字欄位，自動化通知才會有內容。';
          }
          if (saved && saved._triggerFieldMissing) {
            saveWarning = (saveWarning ? saveWarning + '\n' : '') + '「觸發人」欄位寫入失敗，請確認表內有「觸發人」人員欄位。';
          }
          if (!triggeredByOpenId) {
            saveWarning = (saveWarning ? saveWarning + '\n' : '') + '未寫入「觸發人」，紀錄會顯示為應用機器人，自動化也無法寄給您（請重新 Lark 登入後再分析）。';
          }
          if (triggeredByOpenId && aiAnalysisDmNotifyEnabled()) {
            try {
              const notifyText = formatAnalysisNotifyMessage(projectName, analysis, metrics);
              const dm = await sendAiAnalysisDm(larkToken, triggeredByOpenId, projectName, notifyText);
              if (!dm.ok && !dm.skipped) {
                saveWarning = (saveWarning ? saveWarning + '\n' : '') + 'Lark 私訊通知失敗：' + (dm.error || '未知錯誤');
              }
            } catch (dmErr) {
              saveWarning = (saveWarning ? saveWarning + '\n' : '') + 'Lark 私訊通知失敗：' + (dmErr.message || String(dmErr));
            }
          }
        } catch (saveErr) {
          saveWarning = '分析成功，但寫入「AI分析」表失敗：' + (saveErr.message || String(saveErr));
        }
        return res.status(200).json({
          ok: true,
          analysis: analysis,
          metrics: metrics,
          analysisRecordId: analysisRecordId,
          saveWarning: saveWarning
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message || String(err) });
      }
    }

    if (action === 'ai-followup' && req.method === 'POST') {
      const b = req.body || {};
      const projectId = b.projectId;
      const userQuestion = b.question;
      const analysisRecordId = b.analysisRecordId || '';
      if (!projectId || !userQuestion) {
        return res.status(400).json({ error: 'missing projectId or question' });
      }
      const larkToken = await getToken();
      const userAccessTokenForFollowup = extractUserAccessToken(req);
      const hintOpenId = b.triggeredByOpenId || '';
      let followOpenId = '';
      try {
        followOpenId = await resolveTriggeredByOpenId(larkToken, userAccessTokenForFollowup, hintOpenId);
      } catch (e) {}
      try {
        const reply = await runProjectFollowup(projectId, larkToken, userQuestion);
        if (analysisRecordId) {
          try {
            await appendFollowupToRecord(larkToken, userAccessTokenForFollowup, analysisRecordId, userQuestion, reply);
          } catch (appendErr) {
            console.warn('追問紀錄寫入失敗', appendErr.message || appendErr);
          }
        }
        let followWarning = '';
        if (followOpenId && aiAnalysisDmNotifyEnabled()) {
          try {
            const projectName = await findProjectNameById(larkToken, projectId);
            const dm = await sendAiFollowupDm(larkToken, followOpenId, projectName, userQuestion, reply);
            if (!dm.ok && !dm.skipped) {
              followWarning = 'Lark 私訊通知失敗：' + (dm.error || '未知錯誤');
            }
          } catch (dmErr) {
            followWarning = 'Lark 私訊通知失敗：' + (dmErr.message || String(dmErr));
          }
        }
        return res.status(200).json({ ok: true, reply: reply, notifyWarning: followWarning || undefined });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message || String(err) });
      }
    }

    if (req.method === 'GET') {
      if (table === 'payments') {
        try {
          const token = await getToken();
          const cfg = paymentsFrontConfig();
          const tableId = await resolvePaymentsTableId(token, cfg.appToken, cfg.tableId);
          if (!tableId) return res.status(400).json({ error: 'Invalid table: payments' });
          const records = await getRecords(token, tableId, cfg.appToken);
          return res.status(200).json({ records: records });
        } catch (err) {
          console.error('GET payments', err);
          return res.status(200).json({ records: [], error: err.message });
        }
      }
      if (!tableIdFor(table)) return res.status(400).json({ error: 'Invalid table: ' + table });
      try {
        const token = await getToken();
        const tableAppToken = appTokenForTable(table);
        const records = await getRecords(token, tableIdFor(table), tableAppToken);
        return res.status(200).json({ records: records });
      } catch (err) {
        console.error('GET ' + table, err);
        // 讀取失敗時回空陣列，前台照常顯示（與舊版行為一致）
        return res.status(200).json({ records: [], error: err.message });
      }
    }

    const tenantToken = await getToken();
    const userAccessToken = extractUserAccessToken(req);

    if (action === 'notify' && req.method === 'POST') {
      const b = req.body || {};
      const fields = {
        '申請人': b.applicant || '',
        '申請部門': b.dept || '',
        '支付對象': b.payee || '',
        '事由': b.reason || '',
        '付款總金額': (b.amount || '').replace(/[^0-9.]/g, '')
      };
      const result = await maybeSendPaymentNotify(fields);
      return res.status(200).json({ ok: true, notify: result, notifyTo: result.notifyTo });
    }

    if (req.method === 'POST') {
      if (!tableIdFor(table)) return res.status(400).json({ error: 'Invalid table' });
      const applicantHint = extractApplicantOpenIdHint(req.body);
      const cleanBody = stripAuthFromBody(req.body || {});
      if (table === 'payments') {
        const result = await createPaymentInBothBases(tenantToken, userAccessToken, cleanBody, applicantHint);
        try {
          result.notify = await maybeSendPaymentNotify(result.enrichedFields || cleanBody);
        } catch (notifyErr) {
          result.notify = { ok: false, error: notifyErr.message || String(notifyErr) };
        }
        delete result.enrichedFields;
        return res.status(200).json(result);
      }
      const tableAppToken = appTokenForTable(table);
      const tid = tableIdFor(table);
      const body = await normalizeWriteFields(tenantToken, tid, cleanBody, tableAppToken);
      const result = await writeWithUserFallback(tenantToken, userAccessToken, function(tok, asUser) {
        return createRecord(tok, tid, body, tableAppToken, asUser);
      });
      return res.status(200).json(result);
    }

    if (req.method === 'PUT') {
      if (!tableIdFor(table) || !recordId) return res.status(400).json({ error: 'Invalid params' });
      const tableAppToken = appTokenForTable(table);
      const tid = tableIdFor(table);
      const cleanBody = stripAuthFromBody(req.body || {});
      const body = await normalizeWriteFields(tenantToken, tid, cleanBody, tableAppToken);
      const result = await writeWithUserFallback(tenantToken, userAccessToken, function(tok, asUser) {
        return updateRecord(tok, tid, recordId, body, tableAppToken, asUser);
      });
      return res.status(200).json(result);
    }

    if (req.method === 'DELETE') {
      if (!tableIdFor(table) || !recordId) return res.status(400).json({ error: 'Invalid params' });
      const tableAppToken = appTokenForTable(table);
      const result = await writeWithUserFallback(tenantToken, userAccessToken, function(tok, asUser) {
        return deleteRecord(tok, tableIdFor(table), recordId, tableAppToken, asUser);
      });
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
 
  } catch (err) {
    console.error(err);
    const msg = err.message || String(err);
    const status = /forbidden/i.test(msg) ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
}
