/**
 * api.js — 經濟部商工行政資料開放平臺 API 封裝
 * https://data.gcis.nat.gov.tw/od/rule
 */

const GCIS_BASE = 'https://data.gcis.nat.gov.tw/od/data/api';

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
  '01': '核准設立', '02': '廢止', '03': '撤銷', '04': '解散',
  '05': '合併解散', '06': '裁定解散', '07': '命令解散',
  '09': '撤回', '10': '核准遷出', '11': '依職權廢止',
};

// ── CORS Proxy 輪替 ──
const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://proxy.cors.sh/${url}`,
  url => `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function fetchWithProxy(targetUrl) {
  let lastError;
  for (const buildProxy of PROXIES) {
    const proxyUrl = buildProxy(targetUrl);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(proxyUrl, {
        headers: { 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.trim() === '') continue;
      if (text.includes('非授權介接')) throw new Error('此 IP 尚未加入白名單。');
      if (text.includes('超出本日最大介接次數')) throw new Error('今日 API 查詢次數已達上限。');
      if (text.includes('資料庫維護中')) throw new Error('平臺資料庫維護中，請稍後再試。');
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.message.includes('白名單') || err.message.includes('上限') || err.message.includes('維護')) throw err;
      lastError = err;
    }
  }
  throw new Error(`無法連線至資料來源，請稍後再試。(${lastError?.message || 'unknown'})`);
}

async function gcisGet(uuid, filterStr, skip = 0, top = 50) {
  const targetUrl = `${GCIS_BASE}/${uuid}?$format=json&$filter=${encodeURIComponent(filterStr)}&$skip=${skip}&$top=${top}`;
  return fetchWithProxy(targetUrl);
}

// ── 公司資料 ──

async function fetchCompanyByTaxNo(taxNo) {
  const f = `Business_Accounting_NO eq ${taxNo}`;
  const [r1, r2, r3] = await Promise.allSettled([
    gcisGet(API.COMPANY_BASIC_1, f),
    gcisGet(API.COMPANY_BASIC_2, f),
    gcisGet(API.COMPANY_BASIC_3, f),
  ]);
  const v = s => s.status === 'fulfilled' && s.value.length > 0 ? s.value[0] : {};
  const base1 = v(r1), base2 = v(r2), base3 = v(r3);
  if (!Object.keys(base1).length && !Object.keys(base2).length) return null;
  return { ...base1, ...base2, ...base3 };
}

async function searchCompanyByName(keyword, statusCode = '01', top = 20) {
  return gcisGet(API.COMPANY_SEARCH, `Company_Name like ${keyword} and Company_Status eq ${statusCode}`, 0, top);
}

async function searchCompanyAll(keyword, top = 20) {
  return searchCompanyByName(keyword, '01', top);
}

async function searchCompaniesByPerson(name, top = 50) {
  return gcisGet(API.COMPANY_BY_PERSON, `Responsible_Name eq ${name}`, 0, top);
}

/**
 * 查詢董監事資料
 * 官方欄位：
 *   Business_Accounting_NO, Seq_No, Title（職稱）, Name（姓名）,
 *   Sev_Date（就任日期）, Representative_Name（所代表法人）,
 *   Invest_Money（出資額）
 */
async function fetchDirectors(taxNo) {
  const raw = await gcisGet(API.COMPANY_DIRECTORS, `Business_Accounting_NO eq ${taxNo}`, 0, 100);
  // 正規化欄位，相容不同 proxy 可能的欄位名稱差異
  return raw.map(d => ({
    Title:               d.Title || d.Director_Title || d.Dup_Title || '',
    Name:                d.Name  || d.Director_Name  || d.Dup_Name  || '',
    Representative_Name: d.Representative_Name || d.Rep_Name || '',
    Invest_Money:        d.Invest_Money || d.Out_In_Money || d.Capital || '',
    Sev_Date:            d.Sev_Date || '',
    _raw: d,
  }));
}

async function fetchBranches(taxNo) {
  return gcisGet(API.BRANCHES_BY_TAX, `Business_Accounting_NO eq ${taxNo}`, 0, 50);
}

// ── 工具函式 ──

function getStatusLabel(code) {
  return COMPANY_STATUS[code] || `代碼 ${code}`;
}

function rocToAD(rocDate) {
  if (!rocDate) return '';
  const clean = String(rocDate).replace(/\D/g, '');
  if (clean.length === 7) {
    const y = parseInt(clean.substring(0, 3)) + 1911;
    return `${y}/${clean.substring(3,5)}/${clean.substring(5,7)}`;
  }
  return rocDate;
}

function formatCapital(amount) {
  if (!amount) return '';
  const n = parseInt(amount);
  return isNaN(n) ? amount : n.toLocaleString('zh-TW') + ' 元';
}

window.GCISApi = {
  fetchCompanyByTaxNo,
  searchCompanyByName,
  searchCompanyAll,
  searchCompaniesByPerson,
  fetchDirectors,
  fetchBranches,
  getStatusLabel,
  rocToAD,
  formatCapital,
};
