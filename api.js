/**
 * api.js — 經濟部商工行政資料開放平臺 API 封裝
 * 
 * 主要 API 端點（不需要 API Key，但大量使用需申請 IP 白名單）：
 * https://data.gcis.nat.gov.tw/od/rule
 */

const GCIS_BASE = 'https://data.gcis.nat.gov.tw/od/data/api';

// API UUID 對照表
const API = {
  // 公司基本資料（應用一：基本欄位）
  COMPANY_BASIC_1: '5F64D864-61CB-4D0D-8AD9-492047CC1EA6',
  // 公司基本資料（應用二：含資本額、設立日期等）
  COMPANY_BASIC_2: 'F05D1060-7D57-4763-BDCE-0DAF5975AFE0',
  // 公司基本資料（應用三：含所在地、營業項目）
  COMPANY_BASIC_3: '236EE382-4942-41A9-BD03-CA0709025E7C',
  // 公司關鍵字查詢
  COMPANY_SEARCH: '6BBA2268-1367-4B42-9CCA-BC17499EBE8C',
  // 公司董監事資料
  COMPANY_DIRECTORS: '4E5F7653-1B91-4DDC-99D5-468530FAE396',
  // 公司負責人查詢（用人名查公司）
  COMPANY_BY_PERSON: '4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08',
  // 統編查公司名稱
  COMPANY_NAME_BY_TAX: '9D17AE0D-09B5-4732-A8F4-81ADED04B679',
  // 統編查分公司資料
  BRANCHES_BY_TAX: 'FDB8D2C8-573D-4276-BFA4-8D3925ABE1CB',
};

// 公司狀態代碼對照
const COMPANY_STATUS = {
  '01': '核准設立',
  '02': '廢止',
  '03': '撤銷',
  '04': '解散',
  '05': '合併解散',
  '06': '裁定解散',
  '07': '命令解散',
  '09': '撤回',
  '10': '核准遷出',
  '11': '依職權廢止',
};

/**
 * 通用 fetch 函式（處理 CORS 與錯誤）
 */
async function gcisGet(uuid, filterStr, skip = 0, top = 50) {
  const proxyBase = 'https://corsproxy.io/?';
  const url = new URL(proxyBase + encodeURIComponent(`${GCIS_BASE}/${uuid}`));
  url.searchParams.set('$format', 'json');
  url.searchParams.set('$filter', filterStr);
  url.searchParams.set('$skip', skip);
  url.searchParams.set('$top', top);

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' }
  });

  if (!res.ok) {
    const text = await res.text();
    // 平臺有時回傳中文錯誤訊息
    if (text.includes('非授權介接')) {
      throw new Error('此 IP 尚未加入白名單，請向平臺申請介接授權。');
    }
    if (text.includes('超出本日最大介接次數')) {
      throw new Error('今日 API 查詢次數已達上限，請明天再試。');
    }
    throw new Error(`API 回應錯誤 (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 合併三個應用的公司基本資料
 */
async function fetchCompanyByTaxNo(taxNo) {
  const filterStr = `Business_Accounting_NO eq ${taxNo}`;
  const [r1, r2, r3] = await Promise.allSettled([
    gcisGet(API.COMPANY_BASIC_1, filterStr),
    gcisGet(API.COMPANY_BASIC_2, filterStr),
    gcisGet(API.COMPANY_BASIC_3, filterStr),
  ]);

  const base1 = r1.status === 'fulfilled' && r1.value.length > 0 ? r1.value[0] : {};
  const base2 = r2.status === 'fulfilled' && r2.value.length > 0 ? r2.value[0] : {};
  const base3 = r3.status === 'fulfilled' && r3.value.length > 0 ? r3.value[0] : {};

  if (Object.keys(base1).length === 0 && Object.keys(base2).length === 0) return null;

  return { ...base1, ...base2, ...base3 };
}

/**
 * 公司名稱關鍵字搜尋
 */
async function searchCompanyByName(keyword, statusCode = '01', top = 20) {
  const filterStr = `Company_Name like ${keyword} and Company_Status eq ${statusCode}`;
  return gcisGet(API.COMPANY_SEARCH, filterStr, 0, top);
}

/**
 * 搜尋所有狀態（包含非現役）
 */
async function searchCompanyAll(keyword, top = 20) {
  // 嘗試多種狀態，01 = 核准設立最常見
  const results = await searchCompanyByName(keyword, '01', top);
  return results;
}

/**
 * 依負責人姓名查詢公司
 */
async function searchCompaniesByPerson(name, top = 50) {
  const filterStr = `Responsible_Name eq ${name}`;
  return gcisGet(API.COMPANY_BY_PERSON, filterStr, 0, top);
}

/**
 * 查詢董監事資料
 */
async function fetchDirectors(taxNo) {
  const filterStr = `Business_Accounting_NO eq ${taxNo}`;
  return gcisGet(API.COMPANY_DIRECTORS, filterStr, 0, 100);
}

/**
 * 查詢分公司資料
 */
async function fetchBranches(taxNo) {
  const filterStr = `Business_Accounting_NO eq ${taxNo}`;
  return gcisGet(API.BRANCHES_BY_TAX, filterStr, 0, 50);
}

/**
 * 取得公司狀態中文說明
 */
function getStatusLabel(code) {
  return COMPANY_STATUS[code] || `代碼 ${code}`;
}

/**
 * 民國日期轉西元
 * @param {string} rocDate - 如 "1110101" (7碼) 或 "111/01/01"
 */
function rocToAD(rocDate) {
  if (!rocDate) return '';
  const clean = String(rocDate).replace(/\D/g, '');
  if (clean.length === 7) {
    const y = parseInt(clean.substring(0, 3)) + 1911;
    const m = clean.substring(3, 5);
    const d = clean.substring(5, 7);
    return `${y}/${m}/${d}`;
  }
  return rocDate;
}

/**
 * 格式化資本額
 */
function formatCapital(amount) {
  if (!amount) return '';
  const n = parseInt(amount);
  if (isNaN(n)) return amount;
  return n.toLocaleString('zh-TW') + ' 元';
}

// 公開介面
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
