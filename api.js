/**
 * api.js — 經濟部商工行政資料開放平臺 API 封裝
 *
 * GitHub Pages 版本：純前端、無後端。
 * 注意：大量或穩定使用仍建議申請 GCIS IP 白名單，或改成自己的後端 Proxy。
 */

const GCIS_BASE = 'https://data.gcis.nat.gov.tw/od/data/api';

const API = {
  COMPANY_BASIC_1: '5F64D864-61CB-4D0D-8AD9-492047CC1EA6',
  COMPANY_BASIC_2: 'F05D1060-7D57-4763-BDCE-0DAF5975AFE0',
  COMPANY_BASIC_3: '236EE382-4942-41A9-BD03-CA0709025E7C',
  COMPANY_SEARCH: '6BBA2268-1367-4B42-9CCA-BC17499EBE8C',
  COMPANY_DIRECTORS: '4E5F7653-1B91-4DDC-99D5-468530FAE396',
  COMPANY_BY_PERSON: '4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08',
  BRANCHES_BY_TAX: 'FDB8D2C8-573D-4276-BFA4-8D3925ABE1CB',
  BRANCHES_BY_MANAGER: '86E61A52-6649-452E-BDE8-C5A7970B7181',
};

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

function sanitizeFilterValue(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\n\r\t]/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ');
}

async function gcisGet(uuid, filterStr, skip = 0, top = 50) {
  const targetUrl =
    `${GCIS_BASE}/${uuid}` +
    `?$format=json` +
    `&$filter=${encodeURIComponent(filterStr)}` +
    `&$skip=${skip}` +
    `&$top=${top}`;

  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://thingproxy.freeboard.io/fetch/${targetUrl}`,
  ];

  let lastError;
  for (const proxyUrl of proxies) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(proxyUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      if (text.includes('非授權介接')) throw new Error('此 IP 尚未加入白名單，請向平臺申請介接授權。');
      if (text.includes('超出本日最大介接次數')) throw new Error('今日 API 查詢次數已達上限，請明天再試。');
      if (text.includes('資料庫維護中')) throw new Error('平臺資料庫維護中，請稍後再試。');
      if (!text.trim()) return [];

      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.message.includes('白名單') || err.message.includes('上限') || err.message.includes('維護')) throw err;
      lastError = err;
    }
  }

  throw new Error(`無法連線至資料來源，請稍後再試。(${lastError?.message || 'unknown'})`);
}

function normalizeCompany(row = {}) {
  return {
    ...row,
    Business_Accounting_NO: row.Business_Accounting_NO || row.Company_Business_Accounting_NO || '',
    Company_Name: row.Company_Name || row.Branch_Office_Name || '',
    Company_Status: row.Company_Status || row.Company_Status_Code || '',
    Company_Status_Desc: row.Company_Status_Desc || getStatusLabel(row.Company_Status || row.Company_Status_Code || ''),
    Responsible_Name: row.Responsible_Name || '',
    Company_Location: row.Company_Location || row.Company_Address || row.Address || '',
    Company_Setup_Date: row.Company_Setup_Date || row.Date_Approved || '',
    Change_Of_Approval_Data: row.Change_Of_Approval_Data || row.Chg_App_Date || '',
    Capital_Stock_Amount: row.Capital_Stock_Amount || row.Capital_Stock_Amount_NT || '',
    Paid_In_Capital_Amount: row.Paid_In_Capital_Amount || '',
    Register_Organization_Desc: row.Register_Organization_Desc || row.Organization || '',
  };
}

function normalizeDirector(row = {}) {
  return {
    ...row,
    Business_Accounting_NO: row.Business_Accounting_NO || '',
    Person_Position_Name: row.Person_Position_Name || row.Title || row.Director_Title || '',
    Person_Name: row.Person_Name || row.Name || row.Director_Name || '',
    Juristic_Person_Name: row.Juristic_Person_Name || row.Representative_Name || '',
    Person_Shareholding: row.Person_Shareholding || row.Invest_Money || row.Out_In_Money || '',
  };
}

function normalizeBranch(row = {}) {
  return {
    ...row,
    Business_Accounting_NO: row.Business_Accounting_NO || row.Head_Office_Business_Accounting_NO || '',
    Company_Name: row.Company_Name || row.Head_Office_Name || '',
    Branch_Office_Name: row.Branch_Office_Name || '',
    Branch_Office_Business_Accounting_NO: row.Branch_Office_Business_Accounting_NO || '',
    Branch_Office_Manager_Name: row.Branch_Office_Manager_Name || row.Manager_Name || '',
    Branch_Office_Status: row.Branch_Office_Status || '',
    Branch_Office_Status_Desc: row.Branch_Office_Status_Desc || getStatusLabel(row.Branch_Office_Status || ''),
    Branch_Office_Location: row.Branch_Office_Location || row.Branch_Office_Address || row.Company_Location || '',
  };
}

async function fetchCompanyByTaxNo(taxNo) {
  const clean = String(taxNo).replace(/\D/g, '');
  const filterStr = `Business_Accounting_NO eq ${clean}`;
  const [r1, r2, r3] = await Promise.allSettled([
    gcisGet(API.COMPANY_BASIC_1, filterStr),
    gcisGet(API.COMPANY_BASIC_2, filterStr),
    gcisGet(API.COMPANY_BASIC_3, filterStr),
  ]);

  const base1 = r1.status === 'fulfilled' && r1.value.length > 0 ? r1.value[0] : {};
  const base2 = r2.status === 'fulfilled' && r2.value.length > 0 ? r2.value[0] : {};
  const base3 = r3.status === 'fulfilled' && r3.value.length > 0 ? r3.value[0] : {};

  if (Object.keys(base1).length === 0 && Object.keys(base2).length === 0 && Object.keys(base3).length === 0) return null;
  return normalizeCompany({ ...base1, ...base2, ...base3 });
}

async function searchCompanyByName(keyword, statusCode = '01', top = 20) {
  const k = sanitizeFilterValue(keyword);
  const filterStr = `Company_Name like ${k} and Company_Status eq ${statusCode}`;
  const rows = await gcisGet(API.COMPANY_SEARCH, filterStr, 0, top);
  return rows.map(normalizeCompany);
}

async function searchCompanyAll(keyword, top = 20) {
  return searchCompanyByName(keyword, '01', top);
}

async function searchCompaniesByPerson(name, top = 50) {
  const n = sanitizeFilterValue(name);
  const filterStr = `Responsible_Name eq ${n}`;
  const rows = await gcisGet(API.COMPANY_BY_PERSON, filterStr, 0, top);
  return rows.map(row => ({ ...normalizeCompany(row), Role: '代表人' }));
}

async function searchBranchesByManager(name, top = 50) {
  const n = sanitizeFilterValue(name);
  const filterStr = `Branch_Office_Manager_Name eq ${n}`;
  const rows = await gcisGet(API.BRANCHES_BY_MANAGER, filterStr, 0, top);
  return rows.map(row => ({ ...normalizeBranch(row), Role: '分公司經理人' }));
}

async function searchPersonRelations(name, top = 50) {
  const [responsibleResult, branchManagerResult] = await Promise.allSettled([
    searchCompaniesByPerson(name, top),
    searchBranchesByManager(name, top),
  ]);

  return {
    name,
    responsibleCompanies: responsibleResult.status === 'fulfilled' ? responsibleResult.value : [],
    managedBranches: branchManagerResult.status === 'fulfilled' ? branchManagerResult.value : [],
    errors: [responsibleResult, branchManagerResult]
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message || String(r.reason)),
  };
}

async function fetchDirectors(taxNo) {
  const clean = String(taxNo).replace(/\D/g, '');
  const filterStr = `Business_Accounting_NO eq ${clean}`;
  const rows = await gcisGet(API.COMPANY_DIRECTORS, filterStr, 0, 1000);
  return rows.map(normalizeDirector);
}

async function fetchBranches(taxNo) {
  const clean = String(taxNo).replace(/\D/g, '');
  const filterStr = `Business_Accounting_NO eq ${clean}`;
  const rows = await gcisGet(API.BRANCHES_BY_TAX, filterStr, 0, 1000);
  return rows.map(normalizeBranch);
}

function getStatusLabel(code) {
  if (!code) return '';
  return COMPANY_STATUS[String(code)] || `代碼 ${code}`;
}

function rocToAD(rocDate) {
  if (!rocDate) return '';
  const clean = String(rocDate).replace(/\D/g, '');
  if (clean.length === 7) {
    const y = parseInt(clean.substring(0, 3), 10) + 1911;
    const m = clean.substring(3, 5);
    const d = clean.substring(5, 7);
    return `${y}/${m}/${d}`;
  }
  return rocDate;
}

function formatNumber(amount, suffix = '') {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(n)) return String(amount);
  return `${n.toLocaleString('zh-TW')}${suffix}`;
}

function formatCapital(amount) {
  return formatNumber(amount, ' 元');
}

window.GCISApi = {
  fetchCompanyByTaxNo,
  searchCompanyByName,
  searchCompanyAll,
  searchCompaniesByPerson,
  searchBranchesByManager,
  searchPersonRelations,
  fetchDirectors,
  fetchBranches,
  normalizeCompany,
  normalizeDirector,
  normalizeBranch,
  getStatusLabel,
  rocToAD,
  formatNumber,
  formatCapital,
};
