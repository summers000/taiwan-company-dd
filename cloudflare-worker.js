/**
 * cloudflare-worker.js
 *
 * DD 平臺的安全中繼：
 * 1. 保留既有 ?url=... 官方資料／台灣公司網代理
 * 2. 新增 /findbiz-search，將經濟部商工登記公示查詢的地址與人員搜尋轉成 JSON
 *
 * 部署方式：將此檔貼到原本 gcis-proxy Worker 後重新部署。
 * 若經濟部日後調整表單，可在 Worker Variables 設定：
 * FINDBIZ_INFO_ADDRESS、FINDBIZ_INFO_REPRESENTATIVE、FINDBIZ_INFO_OFFICER。
 */

const FINDBIZ_INIT = 'https://findbiz.nat.gov.tw/fts/query/QueryBar/queryInit.do';
const ALLOWED_PROXY_HOSTS = new Set([
  'data.gcis.nat.gov.tw',
  'twincn.com',
  'www.twincn.com',
  'findbiz.nat.gov.tw',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Accept,Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (!['GET', 'HEAD'].includes(request.method)) return jsonError(405, '僅支援 GET／HEAD。');

    const url = new URL(request.url);
    try {
      if (url.pathname === '/findbiz-search' || url.pathname === '/findbiz-search/') {
        return await handleFindbizSearch(url, env || {});
      }
      if (url.searchParams.has('url')) return await handleSafeProxy(url.searchParams.get('url'), request);
      return json({
        ok: true,
        service: 'DD GCIS proxy',
        endpoints: ['/?url=<encoded official URL>', '/findbiz-search?type=person|address&q=<query>'],
      });
    } catch (error) {
      return jsonError(502, error?.message || '中繼服務發生錯誤。', {
        code: error?.code || 'WORKER_ERROR',
      });
    }
  },
};

async function handleSafeProxy(rawTarget, request) {
  let target;
  try { target = new URL(rawTarget); } catch (_) { return jsonError(400, 'url 參數格式錯誤。'); }
  if (target.protocol !== 'https:' || !ALLOWED_PROXY_HOSTS.has(target.hostname)) {
    return jsonError(403, '此網域不在允許代理清單。');
  }

  const response = await fetch(target.toString(), {
    method: request.method,
    redirect: 'follow',
    headers: {
      Accept: request.headers.get('Accept') || '*/*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
      'User-Agent': browserUserAgent(),
    },
  });

  const headers = new Headers(CORS_HEADERS);
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers,
  });
}

async function handleFindbizSearch(url, env) {
  const type = String(url.searchParams.get('type') || '').toLowerCase();
  const query = String(url.searchParams.get('q') || '').trim();
  const top = clamp(Number(url.searchParams.get('top') || 50), 1, 100);

  if (!['person', 'address'].includes(type)) return jsonError(400, 'type 必須是 person 或 address。');
  if (query.length < 2) return jsonError(400, '查詢條件至少需要 2 個字。');

  const session = await loadFindbizSession();
  const warnings = [];
  const searches = type === 'address'
    ? [{ category: 'address', fallbackInfoType: env.FINDBIZ_INFO_ADDRESS || '' }]
    : [
        { category: 'representative', fallbackInfoType: env.FINDBIZ_INFO_REPRESENTATIVE || '' },
        { category: 'officer', fallbackInfoType: env.FINDBIZ_INFO_OFFICER || '' },
      ];

  const settled = await Promise.allSettled(
    searches.map(search => runFindbizCategory(session, search.category, query, top, search.fallbackInfoType))
  );

  const records = [];
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') records.push(...item.value.results);
    else warnings.push(`${categoryLabel(searches[index].category)}查詢失敗：${item.reason?.message || '未知錯誤'}`);
  });

  const results = mergeFindbizResults(records).slice(0, top);
  if (results.length === 0 && settled.every(item => item.status === 'rejected')) {
    return jsonError(502, '經濟部公示查詢表單目前無法解析。請確認 Worker 已更新，或在 Worker Variables 設定對應 FINDBIZ_INFO_* 值。', {
      warnings,
      officialUrl: FINDBIZ_INIT,
    });
  }

  return json({
    ok: true,
    type,
    query,
    count: results.length,
    results,
    warnings,
    officialUrl: FINDBIZ_INIT,
  });
}

async function loadFindbizSession() {
  const response = await fetch(FINDBIZ_INIT, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'User-Agent': browserUserAgent(),
    },
  });
  if (!response.ok) throw workerError('FINDBIZ_INIT_FAILED', `無法開啟經濟部公示查詢頁（HTTP ${response.status}）。`);
  return {
    html: await response.text(),
    finalUrl: response.url || FINDBIZ_INIT,
    cookie: collectCookies(response.headers),
  };
}

async function runFindbizCategory(session, category, query, top, fallbackInfoType = '') {
  const form = extractQueryForm(session.html, session.finalUrl);
  if (!form && !fallbackInfoType) throw workerError('FORM_NOT_FOUND', '找不到經濟部查詢表單。');

  const target = form ? findCategoryControl(form, category) : null;
  if (!target && !fallbackInfoType) {
    throw workerError('CATEGORY_NOT_FOUND', `找不到「${categoryLabel(category)}」查詢選項。`);
  }

  let currentPage = 1;
  let totalPage = 1;
  const results = [];
  const maxPages = Math.min(10, Math.ceil(top / 10) + 1);

  do {
    const response = form
      ? await submitDiscoveredForm(form, target, query, currentPage, session.cookie)
      : await submitFallbackInfoType(fallbackInfoType, query, currentPage, session.cookie);
    const html = await response.text();
    if (!response.ok) throw workerError('QUERY_FAILED', `${categoryLabel(category)}查詢失敗（HTTP ${response.status}）。`);

    const parsed = parseFindbizResults(html, category, query);
    results.push(...parsed.results);
    totalPage = parsed.totalPage || 1;
    currentPage += 1;
  } while (results.length < top && currentPage <= totalPage && currentPage <= maxPages);

  return { results: results.slice(0, top) };
}

function extractQueryForm(html, baseUrl) {
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = formRegex.exec(html))) {
    if (!/\bqryCond\b/i.test(match[2])) continue;
    const attrs = parseAttributes(match[1]);
    const action = new URL(attrs.action || baseUrl, baseUrl).toString();
    return {
      attrs,
      action,
      method: String(attrs.method || 'GET').toUpperCase(),
      html: match[2],
      controls: parseControls(match[2]),
    };
  }
  return null;
}

function parseControls(formHtml) {
  const controls = [];
  const inputRegex = /<input\b([^>]*)>/gi;
  let match;
  while ((match = inputRegex.exec(formHtml))) {
    const attrs = parseAttributes(match[1]);
    const id = attrs.id || '';
    const label = id ? findLabelText(formHtml, id) : '';
    const near = stripHtml(formHtml.slice(Math.max(0, match.index - 180), Math.min(formHtml.length, inputRegex.lastIndex + 220)));
    controls.push({
      tag: 'input',
      attrs,
      type: String(attrs.type || 'text').toLowerCase(),
      name: attrs.name || '',
      id,
      value: attrs.value || '',
      label: label.replace(/\s+/g, ' ').trim(),
      near: near.replace(/\s+/g, ' ').trim(),
      text: `${label} ${near}`.replace(/\s+/g, ' ').trim(),
    });
  }

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((match = selectRegex.exec(formHtml))) {
    const attrs = parseAttributes(match[1]);
    const options = [];
    const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let option;
    while ((option = optionRegex.exec(match[2]))) {
      const optionAttrs = parseAttributes(option[1]);
      options.push({ value: optionAttrs.value || '', text: stripHtml(option[2]), selected: 'selected' in optionAttrs });
    }
    controls.push({ tag: 'select', attrs, name: attrs.name || '', id: attrs.id || '', options });
  }
  return controls;
}

function findCategoryControl(form, category) {
  const candidates = form.controls.filter(control => control.tag === 'input' && ['radio', 'button'].includes(control.type));
  const score = control => {
    const label = control.label || '';
    const identity = `${control.id} ${control.name} ${control.value}`;
    const near = control.near || '';
    if (category === 'address') {
      if (/地址/.test(label)) return 30;
      if (/addr|address/i.test(identity)) return 20;
      return /地址/.test(near) ? 2 : -1;
    }
    if (category === 'representative') {
      if (/公司代表人|代表人/.test(label) && !/董事|監察|經理/.test(label)) return 30;
      if (/president|responsible|representative|owner/i.test(identity)) return 20;
      return /公司代表人|代表人/.test(near) && !/董事|監察|經理/.test(near) ? 2 : -1;
    }
    if (category === 'officer') {
      if (/董事/.test(label) && /監察/.test(label) && /經理/.test(label)) return 35;
      if (/董事|監察|經理/.test(label)) return 30;
      if (/director|officer|manager|supervisor/i.test(identity)) return 20;
      return /董事/.test(near) && /監察/.test(near) && /經理/.test(near) ? 2 : -1;
    }
    return -1;
  };
  return candidates
    .map(control => ({ control, score: score(control) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.control || null;
}

async function submitDiscoveredForm(form, target, query, page, cookie) {
  const params = new URLSearchParams();
  form.controls.forEach(control => {
    if (!control.name) return;
    if (control.tag === 'select') {
      const option = control.options.find(item => item.selected) || control.options[0];
      if (option) params.set(control.name, option.value);
      return;
    }
    const { type, attrs } = control;
    if (['submit', 'button', 'reset', 'file'].includes(type)) return;
    if (['radio', 'checkbox'].includes(type) && !('checked' in attrs)) return;
    params.set(control.name, control.value || '');
  });

  params.set('qryCond', query);
  params.set('pagingModel.currentPage', String(page));
  if (target?.name) params.set(target.name, target.value || 'on');
  const inferredInfoType = inferInfoType(target);
  if (inferredInfoType) params.set('infoType', inferredInfoType);

  const headers = requestHeaders(cookie);
  if (form.method === 'POST') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return fetch(form.action, { method: 'POST', redirect: 'follow', headers, body: params.toString() });
  }
  const targetUrl = new URL(form.action);
  params.forEach((value, key) => targetUrl.searchParams.set(key, value));
  return fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow', headers });
}

async function submitFallbackInfoType(infoType, query, page, cookie) {
  const url = new URL(FINDBIZ_INIT);
  url.searchParams.set('infoType', infoType);
  url.searchParams.set('qryCond', query);
  url.searchParams.set('pagingModel.currentPage', String(page));
  return fetch(url.toString(), { redirect: 'follow', headers: requestHeaders(cookie) });
}

function inferInfoType(control) {
  if (!control) return '';
  if (control.name === 'infoType') return control.value;
  const text = `${control.attrs.onclick || ''} ${control.attrs.onchange || ''}`;
  const match = text.match(/infoType[^A-Za-z0-9]+['\"]?([A-Za-z0-9_-]+)['\"]?/i)
    || text.match(/set\w*\(['\"]([A-Za-z0-9_-]+)['\"]\)/i);
  return match?.[1] || '';
}

function parseFindbizResults(html, category, query) {
  const containerMatch = html.match(/<[^>]+id=["']vParagraph["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const scope = containerMatch?.[1] || html;
  const text = stripHtml(scope);
  const totalPage = Number(findHiddenValue(html, 'pagingModel.totalPage') || 1);
  const results = [];
  const seen = new Set();
  const taxRegex = /(?<!\d)(\d{8})(?!\d)/g;
  let taxMatch;

  while ((taxMatch = taxRegex.exec(text))) {
    const taxNo = taxMatch[1];
    if (seen.has(taxNo)) continue;
    seen.add(taxNo);
    const start = Math.max(0, taxMatch.index - 350);
    const end = Math.min(text.length, taxMatch.index + 700);
    const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
    const name = extractCompanyName(context, taxNo);
    const address = extractField(context, ['公司所在地', '分公司所在地', '商業所在地', '所在地', '地址']);
    const status = extractField(context, ['公司狀況', '公司狀態', '商業狀況', '營業狀況', '狀態']);
    const responsibleName = extractField(context, ['代表人姓名', '負責人姓名', '代表人', '負責人']);
    const roles = category === 'representative'
      ? ['代表人']
      : category === 'officer'
        ? extractRoles(context)
        : [];

    results.push({
      taxNo,
      companyName: name,
      address,
      status,
      responsibleName,
      roles,
      matchType: category,
      query,
    });
  }

  return { results, totalPage };
}

function extractCompanyName(context, taxNo) {
  const labelled = context.match(/(?:公司名稱|商業名稱|分公司名稱)[：:]?\s*([^,，;；]{2,80})/);
  if (labelled) return cleanupField(labelled[1]);

  const escapedTax = taxNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = context.match(new RegExp(`([^,，;；]{2,70}(?:股份有限公司|有限公司|公司|商行|企業社|工作室|合作社|分公司))[^,，;；]{0,80}${escapedTax}`));
  if (before) return cleanupField(before[1]);
  const after = context.match(new RegExp(`${escapedTax}[^,，;；]{0,80}([^,，;；]{2,70}(?:股份有限公司|有限公司|公司|商行|企業社|工作室|合作社|分公司))`));
  if (after) return cleanupField(after[1]);
  const anyCompany = context.match(/([^,，;；：:\s]{2,70}(?:股份有限公司|有限公司|公司|商行|企業社|工作室|合作社|分公司))/);
  return anyCompany ? cleanupField(anyCompany[1]) : '';
}

function extractField(context, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = context.match(new RegExp(`${escaped}[：:]?\\s*([^,，;；]{1,120})`));
    if (match) return cleanupField(match[1]);
  }
  return '';
}

function extractRoles(context) {
  const order = ['董事長', '副董事長', '常務董事', '獨立董事', '董事', '監察人', '經理人', '經理', '法人代表'];
  const roles = order.filter(role => context.includes(role));
  return roles.length ? roles : ['董事／監察人／經理人'];
}

function mergeFindbizResults(records) {
  const map = new Map();
  records.forEach(record => {
    const key = record.taxNo || `${record.companyName}|${record.address}`;
    if (!key) return;
    const previous = map.get(key) || {};
    map.set(key, {
      ...previous,
      ...record,
      roles: [...new Set([...(previous.roles || []), ...(record.roles || [])])],
    });
  });
  return [...map.values()];
}

function parseAttributes(source = '') {
  const attrs = {};
  const regex = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = regex.exec(source))) attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function findLabelText(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<label\\b[^>]*for=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/label>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function findHiddenValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<input\\b[^>]*name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<input\\b[^>]*value=["']([^"']*)["'][^>]*name=["']${escaped}["']`, 'i'));
  return match?.[1] || '';
}

function stripHtml(value = '') {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function decodeHtml(value = '') {
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
  };
  return String(value)
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, match => entities[match] || match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function cleanupField(value = '') {
  return String(value)
    .replace(/(?:統一編號|公司狀況|公司狀態|代表人|所在地|地址)[：:].*$/g, '')
    .replace(/^[：:,，;；\s]+|[：:,，;；\s]+$/g, '')
    .trim();
}

function requestHeaders(cookie = '') {
  const headers = new Headers({
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'User-Agent': browserUserAgent(),
    Referer: FINDBIZ_INIT,
  });
  if (cookie) headers.set('Cookie', cookie);
  return headers;
}

function collectCookies(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(/,(?=[^;,]+=)/).map(item => item.split(';')[0].trim()).filter(Boolean).join('; ');
}

function browserUserAgent() {
  return 'Mozilla/5.0 (compatible; DD-Registry-Research/1.0; +https://findbiz.nat.gov.tw/)';
}

function categoryLabel(category) {
  return ({ address: '地址', representative: '公司代表人', officer: '董事／監察人／經理人' })[category] || category;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function json(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function jsonError(status, message, details = {}) {
  return json({ ok: false, message, ...details }, { status });
}
