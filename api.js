/**
 * api.js — 經濟部商工行政資料開放平臺 API 封裝
 * 透過 Cloudflare Worker 中繼，解決 CORS 問題
 */

const GCIS_BASE = 'https://data.gcis.nat.gov.tw/od/data/api';
const CF_WORKER = 'https://gcis-proxy.summers0309.workers.dev';

const API = {
  COMPANY_BASIC_1:     '5F64D864-61CB-4D0D-8AD9-492047CC1EA6',
  COMPANY_BASIC_2:     'F05D1060-7D57-4763-BDCE-0DAF5975AFE0',
  COMPANY_BASIC_3:     '236EE382-4942-41A9-BD03-CA0709025E7C',
  COMPANY_SEARCH:      '6BBA2268-1367-4B42-9CCA-BC17499EBE8C',
  COMPANY_DIRECTORS:   '4E5F7653-1B91-4DDC-99D5-468530FAE396',
  COMPANY_BY_PERSON:   '4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08',
  COMPANY_NAME_BY_TAX: '9D17AE0D-09B5-4732-A8F4-81ADED04B679',
  BRANCHES_BY_TAX:     'FDB8D2C8-573D-4276-BFA4-8D3925ABE1CB',
};

const COMPANY_STATUS = {
  '01': '核准設立', '02': '廢止',     '03': '撤銷',     '04': '解散',
  '05': '合併解散', '06': '裁定解散', '07': '命令解散',
  '09': '撤回',     '10': '核准遷出', '11': '依職權廢止',
};

const STATUS_CODE_BY_LABEL = Object.fromEntries(
  Object.entries(COMPANY_STATUS).map(([code, label]) => [label, code])
);

class GCISError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GCISError';
    this.code = code;
    this.details = details;
  }
}

function toGCISException(err, fallbackCode = 'REQUEST_FAILED') {
  if (err instanceof GCISError) return err;
  return new GCISError(fallbackCode, err?.message || '官方資料查詢失敗。', { cause: err });
}

// ── 核心請求函式（走 Cloudflare Worker）──
async function gcisGet(uuid, filterStr, skip = 0, top = 50, options = {}) {
  const targetUrl =
    `${GCIS_BASE}/${uuid}` +
    `?$format=json` +
    `&$filter=${encodeURIComponent(filterStr)}` +
    `&$skip=${skip}` +
    `&$top=${top}`;

  const proxyUrl = `${CF_WORKER}?url=${encodeURIComponent(targetUrl)}`;
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  let timedOut = false;

  if (externalSignal?.aborted) {
    throw new GCISError('ABORTED', '查詢已取消。', { uuid });
  }

  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(proxyUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new GCISError('HTTP_ERROR', `官方資料查詢失敗（HTTP ${res.status}）。`, {
        status: res.status,
        uuid,
      });
    }

    const text = await res.text();
    if (!text || text.trim() === '') return [];

    if (text.includes('非授權介接')) {
      throw new GCISError('UNAUTHORIZED', '此 IP 尚未加入官方 API 白名單。');
    }
    if (text.includes('超出本日最大介接次數')) {
      throw new GCISError('DAILY_LIMIT', '今日官方 API 查詢次數已達上限。');
    }
    if (text.includes('資料庫維護中')) {
      throw new GCISError('MAINTENANCE', '官方平臺資料庫維護中，請稍後再試。');
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      throw new GCISError('INVALID_RESPONSE', '官方資料回傳格式異常，無法完成查詢。', {
        uuid,
        responsePreview: text.slice(0, 200),
      });
    }

    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted && !timedOut) {
        throw new GCISError('ABORTED', '查詢已取消。', { uuid });
      }
      throw new GCISError('TIMEOUT', '官方資料查詢逾時，請稍後再試。', { uuid });
    }
    throw toGCISException(err);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

// ── 資料正規化 ──

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/臺/g, '台')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、．,.()（）\-—_\/\\]/g, '')
    .toLowerCase();
}

function normalizeCompanyName(value) {
  return normalizeText(value);
}

function normalizeCompanyCore(value) {
  return normalizeCompanyName(value)
    .replace(/股份有限公司$/, '')
    .replace(/有限公司$/, '')
    .replace(/股份公司$/, '')
    .replace(/公司$/, '')
    .replace(/企業社$/, '')
    .replace(/商行$/, '');
}

function normalizePersonName(value) {
  return normalizeText(value);
}

function normalizeAddress(value) {
  return normalizeText(value)
    .replace(/之([0-9]+)/g, '之$1')
    .replace(/([0-9]+)樓之([0-9]+)/g, '$1樓之$2');
}

function normalizeCompanyRecord(record = {}) {
  const statusDesc = record.Company_Status_Desc || '';
  const statusCode = String(record.Company_Status || STATUS_CODE_BY_LABEL[statusDesc] || '').padStart(2, '0');

  return {
    ...record,
    Business_Accounting_NO: String(record.Business_Accounting_NO || '').trim(),
    Company_Name: record.Company_Name || record.Business_Name || '',
    Company_Status: statusCode === '00' ? '' : statusCode,
    Company_Status_Desc: statusDesc || COMPANY_STATUS[statusCode] || '',
    Responsible_Name: record.Responsible_Name || record.President_Name || '',
    Company_Location: record.Company_Location || record.Company_Address || '',
    Company_Address: record.Company_Address || record.Company_Location || '',
    Date_Approved: record.Date_Approved || record.Company_Setup_Date || '',
    Capital_Stock_Amount_NT:
      record.Capital_Stock_Amount_NT ?? record.Capital_Stock_Amount ?? record.Paid_In_Capital_Amount ?? '',
    Organization: record.Organization || record.Organization_Desc || '',
  };
}

function dedupeCompanies(records) {
  const map = new Map();
  records.map(normalizeCompanyRecord).forEach(record => {
    const key = record.Business_Accounting_NO || `${normalizeCompanyName(record.Company_Name)}:${record.Company_Status}`;
    if (!key) return;
    const previous = map.get(key) || {};
    map.set(key, { ...previous, ...record });
  });
  return [...map.values()];
}

function bigramSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const pairs = value => {
    const result = [];
    for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
    return result;
  };

  const aPairs = pairs(a);
  const bPairs = pairs(b);
  const counts = new Map();
  aPairs.forEach(pair => counts.set(pair, (counts.get(pair) || 0) + 1));

  let intersection = 0;
  bPairs.forEach(pair => {
    const count = counts.get(pair) || 0;
    if (count > 0) {
      intersection++;
      counts.set(pair, count - 1);
    }
  });

  return (2 * intersection) / (aPairs.length + bPairs.length);
}

function scoreCompanyCandidate(inputName, candidate, inputPerson = '') {
  const inputFull = normalizeCompanyName(inputName);
  const inputCore = normalizeCompanyCore(inputName);
  const candidateFull = normalizeCompanyName(candidate.Company_Name);
  const candidateCore = normalizeCompanyCore(candidate.Company_Name);

  let score = 0;
  let reason = '低相似度';

  if (inputFull && inputFull === candidateFull) {
    score = 100;
    reason = '公司名稱完全相符';
  } else if (inputCore && inputCore === candidateCore) {
    score = 94;
    reason = '公司核心名稱相符';
  } else if (inputCore && candidateCore && (inputCore.includes(candidateCore) || candidateCore.includes(inputCore))) {
    const ratio = Math.min(inputCore.length, candidateCore.length) / Math.max(inputCore.length, candidateCore.length);
    score = 78 + Math.round(ratio * 10);
    reason = '公司名稱部分相符';
  } else {
    score = Math.round(bigramSimilarity(inputCore, candidateCore) * 85);
    reason = '公司名稱近似';
  }

  const personMatches = inputPerson &&
    normalizePersonName(inputPerson) === normalizePersonName(candidate.Responsible_Name);
  if (personMatches) {
    score = Math.min(100, score + 6);
    reason += '且代表人相符';
  }

  return { score, reason, personMatches };
}

/**
 * 從公司名稱查詢候選中選出可信結果。
 * status: matched / ambiguous / none
 */
function matchCompanyName(inputName, candidates, inputPerson = '') {
  const unique = dedupeCompanies(candidates || []);
  if (!inputName || unique.length === 0) {
    return { status: 'none', company: null, score: 0, ranked: [] };
  }

  const ranked = unique
    .map(company => ({ company, ...scoreCompanyCandidate(inputName, company, inputPerson) }))
    .sort((a, b) => b.score - a.score || (a.company.Company_Status === '01' ? -1 : 1));

  const top = ranked[0];
  const second = ranked[1];
  const topFull = normalizeCompanyName(top.company.Company_Name);
  const inputFull = normalizeCompanyName(inputName);
  const exactFull = ranked.filter(item => normalizeCompanyName(item.company.Company_Name) === inputFull);

  if (exactFull.length === 1) {
    return { status: 'matched', company: exactFull[0].company, score: 100, reason: exactFull[0].reason, ranked };
  }
  if (exactFull.length > 1) {
    return { status: 'ambiguous', company: null, score: 100, reason: '相同名稱有多筆候選', ranked };
  }

  const gap = second ? top.score - second.score : top.score;
  if (top.score >= 94 && gap >= 5) {
    return { status: 'matched', company: top.company, score: top.score, reason: top.reason, ranked };
  }

  if (topFull && top.score >= 72) {
    return { status: 'ambiguous', company: null, score: top.score, reason: '候選公司相似但不足以自動確認', ranked };
  }

  return { status: 'none', company: null, score: top.score, reason: '沒有足夠相符的候選公司', ranked };
}

// ── 公司資料 ──

async function fetchCompanyByTaxNo(taxNo, options = {}) {
  const cleanTaxNo = String(taxNo || '').replace(/\D/g, '');
  const filter = `Business_Accounting_NO eq ${cleanTaxNo}`;
  const settled = await Promise.allSettled([
    gcisGet(API.COMPANY_BASIC_1, filter, 0, 50, options),
    gcisGet(API.COMPANY_BASIC_2, filter, 0, 50, options),
    gcisGet(API.COMPANY_BASIC_3, filter, 0, 50, options),
  ]);

  if (options.signal?.aborted) {
    throw new GCISError('ABORTED', '查詢已取消。', { taxNo: cleanTaxNo });
  }

  const fulfilled = settled.filter(item => item.status === 'fulfilled');
  const rejected = settled.filter(item => item.status === 'rejected');
  const records = fulfilled
    .map(item => item.value?.[0])
    .filter(Boolean);

  if (records.length === 0) {
    if (rejected.length > 0) {
      throw new GCISError(
        'INCONCLUSIVE',
        '部分官方公司資料來源查詢失敗，無法確認是查無資料或系統暫時異常。',
        { taxNo: cleanTaxNo, errors: rejected.map(item => item.reason?.message || '未知錯誤') }
      );
    }
    return null;
  }

  const company = normalizeCompanyRecord(Object.assign({}, ...records));
  if (rejected.length > 0) {
    company._apiWarnings = rejected.map(item => item.reason?.message || '部分公司資料來源查詢失敗');
  }
  return company;
}

async function searchCompanyByName(keyword, statusCode = '01', top = 20, options = {}) {
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) return [];
  const records = await gcisGet(
    API.COMPANY_SEARCH,
    `Company_Name like ${cleanKeyword} and Company_Status eq ${statusCode}`,
    0,
    top,
    options
  );
  return records.map(normalizeCompanyRecord);
}

/**
 * 官方關鍵字 API 要求必須帶公司狀態，因此逐一查詢各狀態後合併。
 * 只有在所有狀態皆查詢完成且沒有結果時，才視為確定查無。
 */
async function searchCompanyAll(keyword, top = 20, options = {}) {
  const statusCodes = Object.keys(COMPANY_STATUS);
  const settled = await Promise.allSettled(
    statusCodes.map(code => searchCompanyByName(keyword, code, top, options))
  );

  if (options.signal?.aborted) {
    throw new GCISError('ABORTED', '查詢已取消。');
  }

  const fulfilled = settled.filter(item => item.status === 'fulfilled');
  const rejected = settled.filter(item => item.status === 'rejected');
  const combined = dedupeCompanies(fulfilled.flatMap(item => item.value || []));

  if (fulfilled.length === 0) {
    throw new GCISError('API_UNAVAILABLE', '所有公司名稱查詢皆失敗，請稍後再試。', {
      errors: rejected.map(item => item.reason?.message || '未知錯誤'),
    });
  }

  if (combined.length === 0 && rejected.length > 0) {
    throw new GCISError(
      'INCONCLUSIVE',
      '部分公司狀態查詢失敗，無法確認是否查無資料。',
      { errors: rejected.map(item => item.reason?.message || '未知錯誤') }
    );
  }

  combined.sort((a, b) => {
    if (a.Company_Status === '01' && b.Company_Status !== '01') return -1;
    if (a.Company_Status !== '01' && b.Company_Status === '01') return 1;
    return String(a.Company_Name).localeCompare(String(b.Company_Name), 'zh-TW');
  });

  const output = combined.slice(0, top);
  if (rejected.length > 0) {
    Object.defineProperty(output, 'partialErrors', {
      value: rejected.map(item => item.reason?.message || '未知錯誤'),
      enumerable: false,
    });
  }

  return output;
}

/**
 * 目前官方資料集僅支援依「負責人姓名」反查公司，不等同董監事反查。
 */
async function searchCompaniesByPerson(name, top = 50, options = {}) {
  const records = await gcisGet(API.COMPANY_BY_PERSON, `Responsible_Name eq ${String(name || '').trim()}`, 0, top, options);
  return dedupeCompanies(records);
}

async function fetchDirectors(taxNo, options = {}) {
  const raw = await gcisGet(
    API.COMPANY_DIRECTORS,
    `Business_Accounting_NO eq ${String(taxNo || '').replace(/\D/g, '')}`,
    0,
    100,
    options
  );

  return raw.map(d => ({
    Title: d.Person_Position_Name || d.Title || d.Director_Title || '',
    Name: d.Person_Name || d.Name || d.Director_Name || '',
    Representative_Name: d.Juristic_Person_Name || d.Representative_Name || '',
    Invest_Money: d.Person_Shareholding ?? d.Invest_Money ?? d.Out_In_Money ?? '',
    Sev_Date: d.Sev_Date || '',
    _raw: d,
  }));
}

async function fetchBranches(taxNo, options = {}) {
  return gcisGet(
    API.BRANCHES_BY_TAX,
    `Business_Accounting_NO eq ${String(taxNo || '').replace(/\D/g, '')}`,
    0,
    50,
    options
  );
}

// ── 工具函式 ──

function getStatusLabel(code) {
  if (!code) return '未知';
  return COMPANY_STATUS[code] || `代碼 ${code}`;
}

function rocToAD(rocDate) {
  if (!rocDate) return '';
  const clean = String(rocDate).replace(/\D/g, '');
  if (clean.length === 7) {
    const y = parseInt(clean.substring(0, 3), 10) + 1911;
    return `${y}/${clean.substring(3, 5)}/${clean.substring(5, 7)}`;
  }
  return rocDate;
}

function formatCapital(amount) {
  if (amount === '' || amount === null || amount === undefined) return '';
  const n = Number(amount);
  return Number.isFinite(n) ? `${n.toLocaleString('zh-TW')} 元` : String(amount);
}

window.GCISApi = {
  GCISError,
  fetchCompanyByTaxNo,
  searchCompanyByName,
  searchCompanyAll,
  searchCompaniesByPerson,
  fetchDirectors,
  fetchBranches,
  getStatusLabel,
  rocToAD,
  formatCapital,
  normalizeCompanyName,
  normalizeCompanyCore,
  normalizePersonName,
  normalizeAddress,
  normalizeCompanyRecord,
  matchCompanyName,
};
