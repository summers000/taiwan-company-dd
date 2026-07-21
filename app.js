/**
 * app.js — 主程式邏輯
 */

let currentCompany  = null;
let currentDirectors = [];
let currentBranches  = [];
let searchDebounceTimer = null;

const $ = id => document.getElementById(id);
const companyGraph = RelationGraphs.get('company');
const personGraph = RelationGraphs.get('person');

let activeRequestContext = null;
let requestSequence = 0;

function beginRequest(message) {
  activeRequestContext?.controller.abort();
  const context = {
    id: ++requestSequence,
    controller: new AbortController(),
  };
  context.signal = context.controller.signal;
  activeRequestContext = context;
  showLoading(message);
  return context;
}

function isCurrentRequest(context) {
  return Boolean(context && activeRequestContext?.id === context.id && !context.signal.aborted);
}

function finishRequest(context) {
  if (!context || activeRequestContext?.id !== context.id) return;
  activeRequestContext = null;
  showLoading(false);
}

function cancelActiveRequest() {
  activeRequestContext?.controller.abort();
  activeRequestContext = null;
  showLoading(false);
}

function isCancelledError(err) {
  return err?.code === 'ABORTED' || err?.name === 'AbortError';
}

function handleRequestError(context, err) {
  if (isCancelledError(err) || !isCurrentRequest(context)) return;
  showError(err?.message || '查詢失敗。');
}

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
  companyGraph.init();
  personGraph.init();
  DDCore.init();
  setupSearchTabs();
  setupEventListeners();
});

// ── Search Tabs ──
let currentSearchMode = 'company';

function setupSearchTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      cancelActiveRequest();
      clearTimeout(searchDebounceTimer);
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
    cancelActiveRequest();
    clearTimeout(searchDebounceTimer);
    const val = searchInput.value.trim();
    if (currentSearchMode === 'company' && val.length >= 3) {
      // 公司名稱查詢會涵蓋多種公司狀態，稍微延長 debounce，避免連續輸入造成大量請求。
      searchDebounceTimer = setTimeout(doSearch, 900);
    } else if (!val) {
      hideResults();
    }
  });

  addToGraphBtn.addEventListener('click', () => {
    if (!currentCompany) return;
    companyGraph.addCompany(currentCompany, currentDirectors, currentBranches);
    addToGraphBtn.textContent = '✓ 已加入';
    addToGraphBtn.disabled = true;
    setTimeout(() => { addToGraphBtn.textContent = '+ 加入關聯圖'; addToGraphBtn.disabled = false; }, 2000);
  });

  clearGraphBtn.addEventListener('click', () => companyGraph.clear());
  exportGraphBtn.addEventListener('click', () => companyGraph.exportPNG());

  // personGraph buttons (person result page)
  const clearGraphBtn2  = document.getElementById('clearGraphBtn2');
  const exportGraphBtn2 = document.getElementById('exportGraphBtn2');
  if (clearGraphBtn2)  clearGraphBtn2.addEventListener('click',  () => personGraph.clear());
  if (exportGraphBtn2) exportGraphBtn2.addEventListener('click', () => personGraph.exportPNG());

  // 點擊關聯圖節點：依節點的真實角色分流，避免把董事、經理人或法人誤當成負責人反查。
  document.getElementById('graphCanvas').addEventListener('nodeClick', e => handleGraphNodeClick(e.detail, companyGraph));

  const graphCanvas2 = document.getElementById('graphCanvas2');
  if (graphCanvas2) graphCanvas2.addEventListener('nodeClick', e => handleGraphNodeClick(e.detail, personGraph));
}

// ── Search ──
async function doSearch() {
  clearTimeout(searchDebounceTimer);
  const query = searchInput.value.trim();
  if (!query) return;

  const loadingMessages = {
    company: '搜尋公司中...',
    tax: '查詢公司基本資料...',
    person: `查詢 ${query} 的相關公司...`,
  };
  const context = beginRequest(loadingMessages[currentSearchMode] || '查詢中...');

  switch (currentSearchMode) {
    case 'company': await searchByCompanyName(query, context); break;
    case 'tax': await loadCompanyByTax(query, context); break;
    case 'person': await loadCompaniesByPerson(query, true, context); break;
    case 'address':
      finishRequest(context);
      showError('地址搜尋請先查到公司，再透過關聯圖查看同地址公司。');
      break;
  }
}

async function searchByCompanyName(keyword, context = beginRequest('搜尋公司中...')) {
  try {
    const results = await GCISApi.searchCompanyAll(keyword, 20, { signal: context.signal });
    if (!isCurrentRequest(context)) return;
    showResultList(results);
    if (results.partialErrors?.length) {
      showError('已顯示查詢結果，但部分公司狀態資料暫時無法取得。');
    }
  } catch (err) {
    handleRequestError(context, err);
  } finally {
    finishRequest(context);
  }
}

async function loadCompaniesByPerson(name, showFullResult = false, context = beginRequest(`查詢 ${name} 的相關公司...`)) {
  try {
    const results = await GCISApi.searchCompaniesByPerson(name, 50, { signal: context.signal });
    if (!isCurrentRequest(context)) return [];
    if (results.length === 0) {
      showError(`找不到以「${name}」為負責人的公司。`);
      return [];
    }

    if (showFullResult) renderPersonResults(name, results);
    return results;
  } catch (err) {
    handleRequestError(context, err);
    return [];
  } finally {
    finishRequest(context);
  }
}

/**
 * 負責人查詢：渲染所有公司列表並建立「同名負責人」關聯圖。
 * 注意：官方資料僅能證明負責人姓名相同，不能據此確認為同一自然人。
 */
async function renderPersonResults(name, companies) {
  const section   = $('personSection');
  const listEl    = $('personCompanyList');
  const titleEl   = $('personResultTitle');
  const countEl   = $('personResultCount');
  const addAllBtn = $('personAddAllBtn');

  titleEl.textContent = `「${name}」姓名相符的負責人公司`;
  countEl.textContent = `共 ${companies.length} 筆｜姓名相同不代表同一人`;

  listEl.innerHTML = companies.map(c => {
    const status = c.Company_Status || '';
    const badgeClass = status === '01' ? 'badge-active' : (status ? 'badge-inactive' : 'badge-unknown');
    const statusLabel = GCISApi.getStatusLabel(status);
    return `
      <div class="person-company-item" data-tax="${escapeHtml(c.Business_Accounting_NO || '')}">
        <div class="person-company-main">
          <span class="person-company-name">${escapeHtml(c.Company_Name || '未知')}</span>
          <span class="result-badge ${badgeClass}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="person-company-meta">
          <span class="mono" style="color:var(--text-3)">${escapeHtml(c.Business_Accounting_NO || '')}</span>
          ${c.Company_Address || c.Company_Location ? `<span style="color:var(--text-3);margin-left:12px">${escapeHtml(c.Company_Address || c.Company_Location)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.person-company-item').forEach(el => {
    el.addEventListener('click', () => {
      const tax = el.dataset.tax;
      if (tax) {
        section.style.display = 'none';
        loadCompanyByTax(tax);
      }
    });
  });

  const rebuildGraph = () => {
    personGraph.clear();
    personGraph.addNameMatchGroup(name, companies);
  };

  addAllBtn.textContent = '↻ 重建關聯圖';
  addAllBtn.onclick = () => {
    addAllBtn.disabled = true;
    rebuildGraph();
    addAllBtn.textContent = '✓ 已重建';
    setTimeout(() => {
      addAllBtn.disabled = false;
      addAllBtn.textContent = '↻ 重建關聯圖';
    }, 1600);
  };

  $('contentSection').style.display = 'none';
  section.style.display = 'block';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  rebuildGraph();
}

async function handleGraphNodeClick(node, graphInstance = companyGraph) {
  if (!node) return;

  if (node.type === 'company' && node.taxNo) {
    if (graphInstance === personGraph) $('personSection').style.display = 'none';
    await loadCompanyByTax(node.taxNo);
    return;
  }

  if (node.type === 'person') {
    if (node.expandMode === 'responsible') {
      await expandResponsibleInGraph(node.personName || node.label, node.label, graphInstance);
      return;
    }
    if (node.expandMode === 'name-match-group') {
      showError('此節點只代表負責人姓名相同，尚不能確認為同一自然人。');
      return;
    }

    const role = node.role || '此人員角色';
    showError(`目前官方資料源不支援依「${role}」姓名反查其他公司；系統不會將其誤當成負責人關係。`);
    return;
  }

  if (node.type === 'legalEntity') {
    await expandLegalEntityInGraph(node.entityName || node.label);
    return;
  }

  if (node.type === 'address') {
    showError('目前尚未啟用依地址反查公司；此地址節點僅呈現已查得公司的完整登記地址。');
  }
}

/**
 * 依負責人姓名反查公司。新增的是「同名疑似關聯」，不直接認定為同一人。
 */
async function expandResponsibleInGraph(name, label = name, graphInstance = companyGraph) {
  const context = beginRequest(`查詢 ${label} 的同名負責人公司...`);
  try {
    const companies = await GCISApi.searchCompaniesByPerson(name, 50, { signal: context.signal });
    if (!isCurrentRequest(context)) return;
    if (companies.length === 0) {
      showError(`找不到以「${label}」為負責人的其他公司。`);
      return;
    }

    graphInstance.addNameMatchGroup(name, companies);
    showError(`已加入 ${companies.length} 家姓名相符的公司；姓名相同不代表已確認為同一人。`);
  } catch (err) {
    handleRequestError(context, err);
  } finally {
    finishRequest(context);
  }
}

/**
 * 法人節點以法人名稱進行公司名稱查詢，不再誤用負責人姓名 API。
 */
async function expandLegalEntityInGraph(entityName) {
  const context = beginRequest(`查詢法人「${entityName}」...`);
  try {
    const candidates = await GCISApi.searchCompanyAll(entityName, 20, { signal: context.signal });
    if (!isCurrentRequest(context)) return;
    const match = GCISApi.matchCompanyName(entityName, candidates);

    if (match.status === 'matched' && match.company?.Business_Accounting_NO) {
      await loadCompanyByTax(match.company.Business_Accounting_NO, context);
      return;
    }

    if (candidates.length > 0) {
      showResultList(candidates);
      searchInput.value = entityName;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showError('找到多筆法人名稱候選，請從上方結果選擇正確公司，系統不會自動誤配。');
      return;
    }

    showError(`找不到名稱為「${entityName}」的公司登記資料。`);
  } catch (err) {
    handleRequestError(context, err);
  } finally {
    finishRequest(context);
  }
}

async function loadCompanyByTax(taxNo, context = null) {
  const clean = String(taxNo || '').replace(/\D/g, '');
  if (clean.length !== 8) {
    if (context) finishRequest(context);
    showError('統一編號應為 8 碼數字。');
    return;
  }

  const requestContext = context || beginRequest('查詢公司基本資料...');
  hideResults();

  try {
    const company = await GCISApi.fetchCompanyByTaxNo(clean, { signal: requestContext.signal });
    if (!isCurrentRequest(requestContext)) return;
    if (!company) {
      showError(`找不到統一編號 ${clean} 的公司資料。`);
      return;
    }

    const supplementalErrors = [];
    setLoadingText('載入董監事與分公司資料...');

    // 兩項附加資料彼此獨立，同時載入以縮短等待時間。
    const [directorResult, branchResult] = await Promise.allSettled([
      GCISApi.fetchDirectors(clean, { signal: requestContext.signal }),
      GCISApi.fetchBranches(clean, { signal: requestContext.signal }),
    ]);
    if (!isCurrentRequest(requestContext)) return;

    const directors = directorResult.status === 'fulfilled' ? directorResult.value : [];
    const branches = branchResult.status === 'fulfilled' ? branchResult.value : [];
    if (directorResult.status === 'rejected' && !isCancelledError(directorResult.reason)) {
      supplementalErrors.push(`董監事資料查詢失敗：${directorResult.reason?.message || '未知錯誤'}`);
    }
    if (branchResult.status === 'rejected' && !isCancelledError(branchResult.reason)) {
      supplementalErrors.push(`分公司資料查詢失敗：${branchResult.reason?.message || '未知錯誤'}`);
    }

    currentCompany = company;
    currentDirectors = directors;
    currentBranches = branches;

    renderCompanyCard(company);
    renderDirectors(directors);
    renderBranches(branches);

    const warnings = [...(company._apiWarnings || []), ...supplementalErrors];
    DDCore.setCompanyContext(company, directors, branches, {
      retrievedAt: new Date().toISOString(),
      warnings,
    });

    contentSection.style.display = 'block';
    contentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    companyGraph.addCompany(company, directors, branches);

    if (warnings.length > 0) {
      showError(`公司基本資料已載入，但部分附加資料未能取得：${warnings.join('；')}`);
    }
  } catch (err) {
    handleRequestError(requestContext, err);
  } finally {
    finishRequest(requestContext);
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
        <div class="result-meta">統編：${escapeHtml(r.Business_Accounting_NO || '—')}　${escapeHtml(r.Company_Location || r.Company_Address || r.Responsible_Name || '')}</div>
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
    { label: '公司所在地', value: c.Company_Location || c.Company_Address },
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
    el.addEventListener('click', () => expandResponsibleInGraph(el.dataset.val, el.dataset.val, companyGraph));
  });
}

function renderInfoRow(r) {
  let val = '';
  if (r.clickType === 'person' && r.value) {
    val = `<span class="info-value clickable" data-click="person" data-val="${escapeHtml(r.value)}" title="點擊查詢同名負責人公司（姓名相同不代表同一人）">${escapeHtml(r.value)} <small style="opacity:.5;font-size:11px">↗ 查同名</small></span>`;
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
              <td><span class="clickable-name" data-name="${escapeHtml(name)}" data-role="${escapeHtml(title)}" title="官方資料源不支援依董監事姓名反查公司；點擊查看說明">${escapeHtml(name)} <small style="opacity:.4">ⓘ</small></span></td>
              <td>${escapeHtml(rep)}</td>
              <td style="font-family:var(--font-mono)">${money}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    directorsTable.querySelectorAll('.clickable-name').forEach(el => {
      el.addEventListener('click', () => {
        showError(`目前官方資料源不支援依「${el.dataset.role || '董監事'}」姓名反查其他公司，為避免誤判不會改用負責人 API。`);
      });
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
            <td><span class="clickable-name" data-name="${escapeHtml(d.Name || '')}" data-role="${escapeHtml(d.Title || '經理人')}" title="官方資料源不支援依經理人姓名反查公司；點擊查看說明">${escapeHtml(d.Name || '—')} <small style="opacity:.4">ⓘ</small></span></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    managersTable.querySelectorAll('.clickable-name').forEach(el => {
      el.addEventListener('click', () => {
        showError(`目前官方資料源不支援依「${el.dataset.role || '經理人'}」姓名反查其他公司，為避免誤判不會改用負責人 API。`);
      });
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
