/**
 * app.js — 主程式邏輯
 * 協調 API 查詢、UI 顯示、圖形互動與自動展開關聯
 */

let currentCompany = null;
let currentDirectors = [];
let currentBranches = [];
let searchDebounceTimer = null;
let currentSearchMode = 'company';

const graphExpansionState = {
  visitedTaxNos: new Set(),
  visitedPeople: new Set(),
};

const MAX_PEOPLE_TO_EXPAND = 12;
const MAX_RELATED_COMPANIES_PER_PERSON = 10;

const $ = id => document.getElementById(id);
const searchInput = $('searchInput');
const searchBtn = $('searchBtn');
const searchResults = $('searchResults');
const contentSection = $('contentSection');
const companyCard = $('companyCard');
const directorsPanel = $('directorsPanel');
const managersPanel = $('managersPanel');
const branchesPanel = $('branchesPanel');
const directorsTable = $('directorsTable');
const managersTable = $('managersTable');
const branchesTable = $('branchesTable');
const addToGraphBtn = $('addToGraphBtn');
const expandGraphBtn = $('expandGraphBtn');
const clearGraphBtn = $('clearGraphBtn');
const exportGraphBtn = $('exportGraphBtn');
const loadingOverlay = $('loadingOverlay');
const loadingText = $('loadingText');
const errorToast = $('errorToast');

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  Graph.init();
  setupSearchTabs();
  setupEventListeners();
});

function setupSearchTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSearchMode = btn.dataset.tab;

      const hints = {
        company: '支援關鍵字模糊搜尋，例如：台積電、遠東新世紀',
        tax: '輸入 8 碼統一編號，例如：03522600',
        person: '輸入完整姓名；公開 API 可查代表人與分公司經理人，董監事跨公司反查需另建索引',
        address: '公開 API 不支援直接以地址查全部公司；目前可透過關聯圖比對已載入公司的地址節點',
      };
      $('searchHint').textContent = hints[currentSearchMode] || '';

      const placeholders = {
        company: '輸入公司名稱關鍵字...',
        tax: '輸入統一編號（8碼）...',
        person: '輸入人名...',
        address: '輸入地址關鍵字...',
      };
      searchInput.placeholder = placeholders[currentSearchMode] || '搜尋...';
      hideResults();
    });
  });
}

function setupEventListeners() {
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const val = searchInput.value.trim();
    if (currentSearchMode === 'company' && val.length >= 2) {
      searchDebounceTimer = setTimeout(doSearch, 500);
    } else if (!val) {
      hideResults();
    }
  });

  addToGraphBtn.addEventListener('click', () => {
    if (!currentCompany) return;
    ensureGraphVisibleAndSized();
    Graph.addCompany(currentCompany, currentDirectors, currentBranches);
    graphExpansionState.visitedTaxNos.add(currentCompany.Business_Accounting_NO);
    flashButton(addToGraphBtn, '✓ 已加入');
  });

  if (expandGraphBtn) {
    expandGraphBtn.addEventListener('click', expandCurrentCompany);
  }

  clearGraphBtn.addEventListener('click', () => {
    Graph.clear();
    graphExpansionState.visitedTaxNos.clear();
    graphExpansionState.visitedPeople.clear();
  });

  exportGraphBtn.addEventListener('click', () => Graph.exportPNG());

  document.getElementById('graphCanvas').addEventListener('nodeClick', async e => {
    const node = e.detail;
    if (node.type === 'company' && node.taxNo) {
      await loadCompanyByTax(node.taxNo);
    } else if (node.type === 'person') {
      await loadCompaniesByPerson(node.key);
    }
  });
}

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  switch (currentSearchMode) {
    case 'company': await searchByCompanyName(query); break;
    case 'tax': await loadCompanyByTax(query); break;
    case 'person': await loadCompaniesByPerson(query); break;
    case 'address': showError('公開 API 不支援直接以地址反查全部公司；建議先查公司，再用關聯圖比對地址節點。'); break;
    default: break;
  }
}

async function searchByCompanyName(keyword) {
  showLoading('搜尋公司中...');
  try {
    const results = await GCISApi.searchCompanyAll(keyword, 20);
    showLoading(false);
    showResultList(results);
  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

async function loadCompaniesByPerson(name) {
  showLoading(`查詢 ${name} 的公開關聯資料...`);
  try {
    const rel = await GCISApi.searchPersonRelations(name, 30);
    showLoading(false);

    const rows = [
      ...rel.responsibleCompanies.map(r => ({ ...r, Role: '代表人' })),
      ...rel.managedBranches.map(b => ({
        Company_Name: b.Company_Name || b.Branch_Office_Name,
        Business_Accounting_NO: b.Business_Accounting_NO || b.Branch_Office_Business_Accounting_NO,
        Company_Status: b.Branch_Office_Status,
        Company_Status_Desc: b.Branch_Office_Status_Desc,
        Company_Location: b.Branch_Office_Name,
        Role: '分公司經理人',
        rawBranch: b,
      })),
    ];

    if (rows.length === 0) {
      showError(`公開 API 找不到「${name}」擔任代表人或分公司經理人的資料；董監事跨公司反查需另建董監事索引。`);
      return;
    }
    showResultList(rows);
  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

async function loadCompanyByTax(taxNo) {
  const clean = String(taxNo).replace(/\D/g, '');
  if (clean.length !== 8) {
    showError('統一編號應為 8 碼數字。');
    return;
  }

  hideResults();
  showLoading('查詢公司基本資料...');
  try {
    const bundle = await fetchCompanyBundle(clean);
    if (!bundle.company) {
      showLoading(false);
      showError(`找不到統一編號 ${clean} 的公司資料。`);
      return;
    }

    currentCompany = bundle.company;
    currentDirectors = bundle.directors;
    currentBranches = bundle.branches;

    renderCompanyCard(currentCompany);
    renderDirectors(currentDirectors);
    renderManagers(buildManagers(currentDirectors, currentBranches));
    renderBranches(currentBranches);

    contentSection.style.display = 'block';
    requestAnimationFrame(() => Graph.resize());
    contentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showLoading(false);
  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

async function fetchCompanyBundle(taxNo) {
  const company = await GCISApi.fetchCompanyByTaxNo(taxNo);
  if (!company) return { company: null, directors: [], branches: [] };

  setLoadingText('載入董監事與分公司資料...');
  const [directors, branches] = await Promise.all([
    GCISApi.fetchDirectors(taxNo).catch(() => []),
    GCISApi.fetchBranches(taxNo).catch(() => []),
  ]);
  return { company, directors, branches };
}

async function expandCurrentCompany() {
  if (!currentCompany) return;
  ensureGraphVisibleAndSized();
  if (expandGraphBtn) expandGraphBtn.disabled = true;
  showLoading('建立第一層關聯圖...');

  let addedCompanies = 0;
  let expandedPeople = 0;

  try {
    Graph.addCompany(currentCompany, currentDirectors, currentBranches);
    graphExpansionState.visitedTaxNos.add(currentCompany.Business_Accounting_NO);

    const people = collectPeople(currentCompany, currentDirectors, currentBranches).slice(0, MAX_PEOPLE_TO_EXPAND);
    if (people.length === 0) {
      showLoading(false);
      showError('此公司沒有可展開的人員資料。');
      return;
    }

    for (const person of people) {
      if (graphExpansionState.visitedPeople.has(person.name)) continue;
      graphExpansionState.visitedPeople.add(person.name);
      expandedPeople++;
      setLoadingText(`展開 ${person.name} 的公開關聯...`);

      const rel = await GCISApi.searchPersonRelations(person.name, MAX_RELATED_COMPANIES_PER_PERSON);

      for (const related of rel.responsibleCompanies) {
        const taxNo = related.Business_Accounting_NO;
        if (!taxNo || taxNo === currentCompany.Business_Accounting_NO || graphExpansionState.visitedTaxNos.has(taxNo)) continue;
        const bundle = await fetchCompanyBundle(taxNo);
        if (bundle.company) {
          Graph.addCompany(bundle.company, bundle.directors, bundle.branches);
          graphExpansionState.visitedTaxNos.add(taxNo);
          addedCompanies++;
        }
      }

      for (const branch of rel.managedBranches) {
        Graph.addBranchManagerRelation(branch, person.name);
        const headOfficeTaxNo = branch.Business_Accounting_NO;
        if (headOfficeTaxNo && !graphExpansionState.visitedTaxNos.has(headOfficeTaxNo)) {
          const bundle = await fetchCompanyBundle(headOfficeTaxNo);
          if (bundle.company) {
            Graph.addCompany(bundle.company, bundle.directors, bundle.branches);
            graphExpansionState.visitedTaxNos.add(headOfficeTaxNo);
            addedCompanies++;
          }
        }
      }
    }

    showLoading(false);
    showError(`已展開 ${expandedPeople} 位人員，新增 ${addedCompanies} 家公司／分公司關聯。董監事跨公司反查需另建索引後才能完整展開。`);
  } catch (err) {
    showLoading(false);
    showError(err.message);
  } finally {
    if (expandGraphBtn) expandGraphBtn.disabled = false;
  }
}

function collectPeople(company, directors, branches) {
  const map = new Map();
  const add = (name, role) => {
    const clean = String(name || '').trim();
    if (!clean || clean === '—') return;
    if (!map.has(clean)) map.set(clean, { name: clean, roles: new Set() });
    if (role) map.get(clean).roles.add(role);
  };

  add(company.Responsible_Name, '代表人');
  directors.forEach(d => add(d.Person_Name, d.Person_Position_Name || '董監事'));
  branches.forEach(b => add(b.Branch_Office_Manager_Name, '分公司經理人'));

  return [...map.values()].map(v => ({ name: v.name, roles: [...v.roles] }));
}

function buildManagers(directors, branches) {
  const rows = [];
  directors.forEach(d => {
    const title = d.Person_Position_Name || '';
    if (title.includes('經理')) rows.push({ source: '公司登記', title, name: d.Person_Name });
  });
  branches.forEach(b => {
    if (b.Branch_Office_Manager_Name) {
      rows.push({ source: b.Branch_Office_Name || '分公司', title: '分公司經理人', name: b.Branch_Office_Manager_Name });
    }
  });
  return rows;
}

function showResultList(results) {
  searchResults.innerHTML = '';
  if (!results || results.length === 0) {
    searchResults.innerHTML = '<div class="no-results">找不到符合的資料，請嘗試不同關鍵字。</div>';
    searchResults.classList.remove('hidden');
    return;
  }

  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'result-item fade-in';
    const status = r.Company_Status || '';
    const statusLabel = r.Company_Status_Desc || GCISApi.getStatusLabel(status);
    const badgeClass = status === '01' || statusLabel === '核准設立' ? 'badge-active' : (status || statusLabel ? 'badge-inactive' : 'badge-unknown');
    const roleText = r.Role ? `｜${escapeHtml(r.Role)}` : '';
    const meta = r.Company_Location || r.Responsible_Name || r.Branch_Office_Name || '';

    item.innerHTML = `
      <div>
        <div class="result-name">${escapeHtml(r.Company_Name || r.Branch_Office_Name || '未知公司')}</div>
        <div class="result-meta">統編：${escapeHtml(r.Business_Accounting_NO || r.Branch_Office_Business_Accounting_NO || '—')} ${roleText}　${escapeHtml(meta)}</div>
      </div>
      <span class="result-badge ${badgeClass}">${escapeHtml(statusLabel || '—')}</span>
    `;

    item.addEventListener('click', () => {
      const taxNo = r.Business_Accounting_NO || r.Branch_Office_Business_Accounting_NO;
      if (taxNo) {
        searchInput.value = r.Company_Name || r.Branch_Office_Name || '';
        hideResults();
        loadCompanyByTax(taxNo);
      }
    });
    searchResults.appendChild(item);
  });
  searchResults.classList.remove('hidden');
}

function hideResults() {
  searchResults.innerHTML = '';
  searchResults.classList.add('hidden');
}

function renderCompanyCard(c) {
  const statusCode = c.Company_Status || '';
  const statusLabel = c.Company_Status_Desc || GCISApi.getStatusLabel(statusCode);
  const isActive = statusCode === '01' || statusLabel === '核准設立';
  const badgeColor = isActive ? 'badge-active' : 'badge-inactive';

  const rows = [
    { label: '統一編號', value: c.Business_Accounting_NO, mono: true },
    { label: '登記現況', value: statusLabel, colored: isActive ? 'green' : 'red' },
    { label: '代表人', value: c.Responsible_Name, clickable: 'person', clickVal: c.Responsible_Name },
    { label: '公司所在地', value: c.Company_Location },
    { label: '核准設立日期', value: GCISApi.rocToAD(c.Company_Setup_Date) },
    { label: '最後核准日', value: GCISApi.rocToAD(c.Change_Of_Approval_Data) },
    { label: '資本總額', value: GCISApi.formatCapital(c.Capital_Stock_Amount) },
    { label: '實收資本額', value: GCISApi.formatCapital(c.Paid_In_Capital_Amount) },
    { label: '登記機關', value: c.Register_Organization_Desc },
  ].filter(r => r.value);

  companyCard.innerHTML = `
    <div class="company-name-block">
      <div class="company-main-name">${escapeHtml(c.Company_Name || '未知公司')}</div>
      <div class="company-status-row">
        <span class="status-badge ${badgeColor}">${escapeHtml(statusLabel || '—')}</span>
        <span class="tax-number">${escapeHtml(c.Business_Accounting_NO || '')}</span>
      </div>
    </div>
    <div class="info-rows">${rows.map(renderInfoRow).join('')}</div>
  `;

  companyCard.querySelectorAll('[data-click="person"]').forEach(el => {
    el.addEventListener('click', () => loadCompaniesByPerson(el.dataset.val));
  });
}

function renderInfoRow(r) {
  let valueHtml = '';
  if (r.clickable === 'person' && r.clickVal) {
    valueHtml = `<span class="info-value clickable" data-click="person" data-val="${escapeHtml(r.clickVal)}" title="點擊查詢公開可查關聯">${escapeHtml(r.value)}</span>`;
  } else if (r.mono) {
    valueHtml = `<span class="info-value" style="font-family:var(--font-mono)">${escapeHtml(r.value)}</span>`;
  } else if (r.colored) {
    const col = r.colored === 'green' ? 'var(--green)' : 'var(--red)';
    valueHtml = `<span class="info-value" style="color:${col}">${escapeHtml(r.value)}</span>`;
  } else {
    valueHtml = `<span class="info-value">${escapeHtml(r.value)}</span>`;
  }
  return `<div class="info-row"><span class="info-label">${escapeHtml(r.label)}</span>${valueHtml}</div>`;
}

function renderDirectors(directors) {
  const dirList = (directors || []).filter(d => !(d.Person_Position_Name || '').includes('經理'));
  if (dirList.length === 0) {
    directorsPanel.style.display = 'none';
    return;
  }

  $('directorCount').textContent = `${dirList.length} 筆`;
  directorsTable.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>職稱</th><th>姓名</th><th>所代表法人</th><th>持有股份數</th></tr>
      </thead>
      <tbody>
        ${dirList.map(d => `
          <tr>
            <td>${escapeHtml(d.Person_Position_Name || '—')}</td>
            <td><span class="clickable-name" data-name="${escapeHtml(d.Person_Name || '')}">${escapeHtml(d.Person_Name || '—')}</span></td>
            <td>${escapeHtml(d.Juristic_Person_Name || '—')}</td>
            <td style="font-family:var(--font-mono)">${d.Person_Shareholding ? GCISApi.formatNumber(d.Person_Shareholding) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  directorsTable.querySelectorAll('.clickable-name').forEach(el => {
    el.addEventListener('click', () => loadCompaniesByPerson(el.dataset.name));
  });
  directorsPanel.style.display = 'block';
}

function renderManagers(managers) {
  if (!managers || managers.length === 0) {
    managersPanel.style.display = 'none';
    return;
  }

  $('managerCount').textContent = `${managers.length} 筆`;
  managersTable.innerHTML = `
    <table class="data-table">
      <thead><tr><th>來源</th><th>職稱</th><th>姓名</th></tr></thead>
      <tbody>
        ${managers.map(m => `
          <tr>
            <td>${escapeHtml(m.source || '—')}</td>
            <td>${escapeHtml(m.title || '—')}</td>
            <td><span class="clickable-name" data-name="${escapeHtml(m.name || '')}">${escapeHtml(m.name || '—')}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  managersTable.querySelectorAll('.clickable-name').forEach(el => {
    el.addEventListener('click', () => loadCompaniesByPerson(el.dataset.name));
  });
  managersPanel.style.display = 'block';
}

function renderBranches(branches) {
  if (!branches || branches.length === 0) {
    branchesPanel.style.display = 'none';
    return;
  }

  $('branchCount').textContent = `${branches.length} 筆`;
  branchesTable.innerHTML = `
    <table class="data-table">
      <thead><tr><th>分公司名稱</th><th>統一編號</th><th>經理人</th><th>地址</th></tr></thead>
      <tbody>
        ${branches.map(b => `
          <tr>
            <td><span class="clickable-name" data-tax="${escapeHtml(b.Branch_Office_Business_Accounting_NO || '')}">${escapeHtml(b.Branch_Office_Name || '—')}</span></td>
            <td style="font-family:var(--font-mono)">${escapeHtml(b.Branch_Office_Business_Accounting_NO || '—')}</td>
            <td>${b.Branch_Office_Manager_Name ? `<span class="clickable-name" data-name="${escapeHtml(b.Branch_Office_Manager_Name)}">${escapeHtml(b.Branch_Office_Manager_Name)}</span>` : '—'}</td>
            <td>${escapeHtml(b.Branch_Office_Location || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  branchesTable.querySelectorAll('[data-tax]').forEach(el => {
    el.addEventListener('click', () => loadCompanyByTax(el.dataset.tax));
  });
  branchesTable.querySelectorAll('[data-name]').forEach(el => {
    el.addEventListener('click', () => loadCompaniesByPerson(el.dataset.name));
  });
  branchesPanel.style.display = 'block';
}

function ensureGraphVisibleAndSized() {
  contentSection.style.display = 'block';
  requestAnimationFrame(() => Graph.resize());
  Graph.resize();
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1500);
}

function showLoading(message) {
  if (message === false) {
    loadingOverlay.classList.add('hidden');
    return;
  }
  loadingText.textContent = message || '查詢中...';
  loadingOverlay.classList.remove('hidden');
}

function setLoadingText(message) {
  loadingText.textContent = message;
}

function showError(message) {
  errorToast.textContent = message;
  errorToast.classList.remove('hidden');
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => errorToast.classList.add('hidden'), 5200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
