/**
 * app.js — 主程式邏輯
 */

let currentCompany  = null;
let currentDirectors = [];
let currentBranches  = [];
let searchDebounceTimer = null;

const $ = id => document.getElementById(id);

const searchInput    = $('searchInput');
const searchBtn      = $('searchBtn');
const searchResults  = $('searchResults');
const contentSection = $('contentSection');
const companyCard    = $('companyCard');
const directorsPanel = $('directorsPanel');
const managersPanel  = $('managersPanel');
const branchesPanel  = $('branchesPanel');
const directorsTable = $('directorsTable');
const managersTable  = $('managersTable');
const branchesTable  = $('branchesTable');
const addToGraphBtn  = $('addToGraphBtn');
const clearGraphBtn  = $('clearGraphBtn');
const exportGraphBtn = $('exportGraphBtn');
const loadingOverlay = $('loadingOverlay');
const loadingText    = $('loadingText');
const errorToast     = $('errorToast');

document.addEventListener('DOMContentLoaded', () => {
  Graph.init();
  setupSearchTabs();
  setupEventListeners();
});

// ── Search Tabs ──
let currentSearchMode = 'company';

function setupSearchTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSearchMode = btn.dataset.tab;
      const hints = {
        company: '支援關鍵字模糊搜尋，例如：台積電、遠東新世紀',
        tax:     '輸入 8 碼統一編號，例如：03522600',
        person:  '輸入負責人完整姓名，例如：徐旭東',
        address: '請先查到公司，再透過關聯圖查看同地址公司',
      };
      $('searchHint').textContent = hints[currentSearchMode] || '';
      const placeholders = {
        company: '輸入公司名稱關鍵字...',
        tax:     '輸入統一編號（8碼）...',
        person:  '輸入負責人姓名...',
        address: '輸入地址關鍵字...',
      };
      searchInput.placeholder = placeholders[currentSearchMode] || '搜尋...';
      hideResults();
    });
  });
}

// ── Event Listeners ──
function setupEventListeners() {
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const val = searchInput.value.trim();
    if (currentSearchMode === 'company' && val.length >= 2) {
      searchDebounceTimer = setTimeout(doSearch, 600);
    } else if (!val) {
      hideResults();
    }
  });

  addToGraphBtn.addEventListener('click', () => {
    if (!currentCompany) return;
    Graph.addCompany(currentCompany, currentDirectors, currentBranches);
    addToGraphBtn.textContent = '✓ 已加入';
    addToGraphBtn.disabled = true;
    setTimeout(() => { addToGraphBtn.textContent = '+ 加入關聯圖'; addToGraphBtn.disabled = false; }, 2000);
  });

  clearGraphBtn.addEventListener('click', () => Graph.clear());
  exportGraphBtn.addEventListener('click', () => Graph.exportPNG());

  // 點擊關聯圖節點
  document.getElementById('graphCanvas').addEventListener('nodeClick', async e => {
    const node = e.detail;
    if (node.type === 'company' && node.taxNo) {
      await loadCompanyByTax(node.taxNo);
    } else if (node.type === 'person' || node.type === 'legalEntity') {
      await expandPersonInGraph(node.key, node.label);
    }
  });
}

// ── Search ──
async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;
  switch (currentSearchMode) {
    case 'company': await searchByCompanyName(query); break;
    case 'tax':     await loadCompanyByTax(query); break;
    case 'person':  await loadCompaniesByPerson(query, true); break;
    case 'address': showError('地址搜尋請先查到公司，再透過關聯圖查看同地址公司。'); break;
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

async function loadCompaniesByPerson(name, showList = false) {
  showLoading(`查詢 ${name} 的相關公司...`);
  try {
    const results = await GCISApi.searchCompaniesByPerson(name, 30);
    showLoading(false);
    if (results.length === 0) {
      showError(`找不到以「${name}」為負責人的公司。`);
      return [];
    }
    if (showList) {
      showResultList(results.map(r => ({
        Company_Name: r.Company_Name,
        Business_Accounting_NO: r.Business_Accounting_NO,
        Company_Status: r.Company_Status,
        Company_Location: r.Company_Address || '',
      })));
    }
    return results;
  } catch (err) {
    showLoading(false);
    showError(err.message);
    return [];
  }
}

/**
 * 自動擴展：查詢某人的所有公司並加入關聯圖
 */
async function expandPersonInGraph(name, label) {
  showLoading(`展開 ${label} 的關聯公司...`);
  try {
    const companies = await GCISApi.searchCompaniesByPerson(name, 30);
    showLoading(false);
    if (companies.length === 0) {
      showError(`找不到 ${label} 擔任負責人的其他公司。`);
      return;
    }
    // 對每一間公司加入關聯圖（只加基本資料，不再遞迴）
    for (const c of companies) {
      const taxNo = c.Business_Accounting_NO;
      if (!taxNo) continue;
      setLoadingText(`載入 ${c.Company_Name || taxNo}...`);
      try {
        const detail = await GCISApi.fetchCompanyByTaxNo(taxNo);
        const dirs = await GCISApi.fetchDirectors(taxNo).catch(() => []);
        if (detail) Graph.addCompany(detail, dirs, []);
      } catch (_) {}
    }
    showLoading(false);
  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

async function loadCompanyByTax(taxNo) {
  const clean = taxNo.replace(/\D/g, '');
  if (clean.length !== 8) { showError('統一編號應為 8 碼數字。'); return; }

  hideResults();
  showLoading('查詢公司基本資料...');
  try {
    const company = await GCISApi.fetchCompanyByTaxNo(clean);
    if (!company) {
      showLoading(false);
      showError(`找不到統一編號 ${clean} 的公司資料。`);
      return;
    }

    setLoadingText('載入董監事資料...');
    const directors = await GCISApi.fetchDirectors(clean).catch(() => []);

    setLoadingText('載入分公司資料...');
    const branches = await GCISApi.fetchBranches(clean).catch(() => []);

    showLoading(false);
    currentCompany  = company;
    currentDirectors = directors;
    currentBranches  = branches;

    renderCompanyCard(company);
    renderDirectors(directors);
    renderBranches(branches);

    contentSection.style.display = 'block';
    contentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // 自動加入關聯圖並展開
    Graph.addCompany(company, directors, branches);

  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

// ── Render ──

function showResultList(results) {
  searchResults.innerHTML = '';
  if (!results || results.length === 0) {
    searchResults.innerHTML = '<div class="no-results">找不到符合的公司，請嘗試不同關鍵字。</div>';
    searchResults.classList.remove('hidden');
    return;
  }
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'result-item fade-in';
    const status = r.Company_Status || '';
    const statusLabel = GCISApi.getStatusLabel(status);
    const badgeClass = status === '01' ? 'badge-active' : (status ? 'badge-inactive' : 'badge-unknown');
    item.innerHTML = `
      <div>
        <div class="result-name">${escapeHtml(r.Company_Name || '未知公司')}</div>
        <div class="result-meta">統編：${r.Business_Accounting_NO || '—'}　${escapeHtml(r.Company_Location || r.Responsible_Name || '')}</div>
      </div>
      <span class="result-badge ${badgeClass}">${statusLabel}</span>
    `;
    item.addEventListener('click', () => {
      searchInput.value = r.Company_Name || '';
      hideResults();
      loadCompanyByTax(r.Business_Accounting_NO);
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
  const statusCode  = c.Company_Status || '';
  const statusLabel = GCISApi.getStatusLabel(statusCode);
  const isActive    = statusCode === '01';
  const badgeClass  = isActive ? 'badge-active' : 'badge-inactive';

  const rows = [
    { label: '統一編號',   value: c.Business_Accounting_NO, mono: true },
    { label: '公司狀態',   value: statusLabel, colored: isActive ? 'green' : 'red' },
    { label: '代表人',     value: c.Responsible_Name, clickType: 'person' },
    { label: '公司所在地', value: c.Company_Location },
    { label: '核准設立日', value: GCISApi.rocToAD(c.Date_Approved) },
    { label: '最後核准日', value: GCISApi.rocToAD(c.Change_Of_Approval_Data) },
    { label: '資本額',     value: GCISApi.formatCapital(c.Capital_Stock_Amount_NT) },
    { label: '組織型態',   value: c.Organization },
  ].filter(r => r.value);

  companyCard.innerHTML = `
    <div class="company-name-block">
      <div class="company-main-name">${escapeHtml(c.Company_Name || '未知公司')}</div>
      <div class="company-status-row">
        <span class="status-badge ${badgeClass}">${statusLabel}</span>
        <span class="tax-number">${c.Business_Accounting_NO || ''}</span>
      </div>
    </div>
    <div class="info-rows">
      ${rows.map(r => renderInfoRow(r)).join('')}
    </div>
  `;

  companyCard.querySelectorAll('[data-click="person"]').forEach(el => {
    el.addEventListener('click', () => expandPersonInGraph(el.dataset.val, el.dataset.val));
  });
}

function renderInfoRow(r) {
  let val = '';
  if (r.clickType === 'person' && r.value) {
    val = `<span class="info-value clickable" data-click="person" data-val="${escapeHtml(r.value)}" title="點擊展開此人在關聯圖中的連結公司">${escapeHtml(r.value)} <small style="opacity:.5;font-size:11px">↗ 展開</small></span>`;
  } else if (r.mono) {
    val = `<span class="info-value" style="font-family:var(--font-mono)">${escapeHtml(r.value)}</span>`;
  } else if (r.colored) {
    const col = r.colored === 'green' ? 'var(--green)' : 'var(--red)';
    val = `<span class="info-value" style="color:${col}">${escapeHtml(r.value)}</span>`;
  } else {
    val = `<span class="info-value">${escapeHtml(r.value)}</span>`;
  }
  return `<div class="info-row"><span class="info-label">${escapeHtml(r.label)}</span>${val}</div>`;
}

function renderDirectors(directors) {
  if (!directors || directors.length === 0) {
    directorsPanel.style.display = 'none';
    managersPanel.style.display  = 'none';
    return;
  }

  const dirList = directors.filter(d => !String(d.Title).includes('經理'));
  const mgrList = directors.filter(d =>  String(d.Title).includes('經理'));

  // 董監事
  if (dirList.length > 0) {
    $('directorCount').textContent = `${dirList.length} 筆`;
    directorsTable.innerHTML = `
      <table class="data-table">
        <thead><tr><th>職稱</th><th>姓名</th><th>所代表法人</th><th>出資額（元）</th></tr></thead>
        <tbody>
          ${dirList.map(d => {
            const name   = d.Name || '—';
            const title  = d.Title || '—';
            const rep    = d.Representative_Name || '';
            const money  = d.Invest_Money ? parseInt(d.Invest_Money).toLocaleString('zh-TW') : '—';
            return `<tr>
              <td>${escapeHtml(title)}</td>
              <td><span class="clickable-name" data-name="${escapeHtml(name)}" title="點擊展開此人關聯公司">${escapeHtml(name)} <small style="opacity:.4">↗</small></span></td>
              <td>${escapeHtml(rep)}</td>
              <td style="font-family:var(--font-mono)">${money}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    directorsTable.querySelectorAll('.clickable-name').forEach(el => {
      el.addEventListener('click', () => expandPersonInGraph(el.dataset.name, el.dataset.name));
    });
    directorsPanel.style.display = 'block';
  } else {
    directorsPanel.style.display = 'none';
  }

  // 經理人
  if (mgrList.length > 0) {
    $('managerCount').textContent = `${mgrList.length} 筆`;
    managersTable.innerHTML = `
      <table class="data-table">
        <thead><tr><th>職稱</th><th>姓名</th></tr></thead>
        <tbody>
          ${mgrList.map(d => `<tr>
            <td>${escapeHtml(d.Title || '經理人')}</td>
            <td><span class="clickable-name" data-name="${escapeHtml(d.Name || '')}" title="點擊展開此人關聯公司">${escapeHtml(d.Name || '—')} <small style="opacity:.4">↗</small></span></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    managersTable.querySelectorAll('.clickable-name').forEach(el => {
      el.addEventListener('click', () => expandPersonInGraph(el.dataset.name, el.dataset.name));
    });
    managersPanel.style.display = 'block';
  } else {
    managersPanel.style.display = 'none';
  }
}

function renderBranches(branches) {
  if (!branches || branches.length === 0) { branchesPanel.style.display = 'none'; return; }
  $('branchCount').textContent = `${branches.length} 筆`;
  branchesTable.innerHTML = `
    <table class="data-table">
      <thead><tr><th>分公司名稱</th><th>統一編號</th><th>地址</th></tr></thead>
      <tbody>
        ${branches.map(b => `<tr>
          <td><span class="clickable-name" data-tax="${escapeHtml(b.Branch_Office_Business_Accounting_NO || '')}">${escapeHtml(b.Branch_Office_Name || '—')}</span></td>
          <td style="font-family:var(--font-mono)">${escapeHtml(b.Branch_Office_Business_Accounting_NO || '—')}</td>
          <td>${escapeHtml(b.Branch_Office_Address || b.Branch_Office_Location || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  branchesTable.querySelectorAll('.clickable-name').forEach(el => {
    if (el.dataset.tax) el.addEventListener('click', () => loadCompanyByTax(el.dataset.tax));
  });
  branchesPanel.style.display = 'block';
}

// ── UI Utilities ──

function showLoading(message) {
  if (message === false) { loadingOverlay.classList.add('hidden'); return; }
  loadingText.textContent = message || '查詢中...';
  loadingOverlay.classList.remove('hidden');
}

function setLoadingText(msg) { loadingText.textContent = msg; }

let errorTimer = null;
function showError(msg) {
  errorToast.textContent = '⚠ ' + msg;
  errorToast.classList.remove('hidden');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => errorToast.classList.add('hidden'), 6000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.search-container')) hideResults();
});
