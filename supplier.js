/**
 * supplier.js — 供應商績效貢獻與稽核異常分析（累計月報版）
 *
 * 資料特性：
 * - 每個檔案代表一個報表月份。
 * - 欄位為「本年度截至該月累計」與「前一年度同期累計」。
 * - 上傳連續月份後，系統以本月累計減前月累計，還原單月發生額。
 * - 所有檔案只在瀏覽器記憶體中解析，不上傳伺服器。
 */

const SupplierPerformance = (() => {
  'use strict';

  const METRICS = ['sales', 'pur', 'gp', 'tt', 'pd', 'bi', 'oi', 'total'];
  const RATE_METRICS = ['gpRate', 'ttRate', 'pdRate', 'biRate', 'oiRate', 'totalRate'];
  const AMOUNT_LABELS = {
    sales: 'Sales', pur: 'Pur', gp: 'GP$', tt: 'TT$', pd: 'PD$',
    bi: 'BI$', oi: 'OI$', total: 'GP+BI+OI 總計',
  };

  const state = {
    fileEntries: [],
    snapshots: [],
    charts: new Map(),
    selectedMonth: '',
    selectedGrp: '',
    selectedSec: '',
    selectedVendor: '',
    viewMode: 'audit',
    riskEntries: [],
    selectedDetailKey: '',
    initialized: false,
  };

  const el = id => document.getElementById(id);

  function init() {
    if (state.initialized || !el('supplierFileInput')) return;
    state.initialized = true;

    el('supplierFileInput').addEventListener('change', event => {
      addFiles(Array.from(event.target.files || []));
      event.target.value = '';
    });

    const dropZone = el('supplierDropZone');
    dropZone.addEventListener('dragover', event => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', event => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
      addFiles(Array.from(event.dataTransfer.files || []));
    });

    el('supplierAnalyzeBtn').addEventListener('click', analyzeFiles);
    el('supplierDemoBtn').addEventListener('click', loadDemoData);
    el('supplierClearBtn').addEventListener('click', clearAll);
    el('supplierExportBtn').addEventListener('click', exportExceptionsCsv);
    el('supplierPrintBtn').addEventListener('click', () => window.print());

    ['supplierMonthFilter', 'supplierGrpFilter', 'supplierSecFilter', 'supplierVendorFilter']
      .forEach(id => el(id).addEventListener('change', onFilterChange));

    document.querySelectorAll('[data-supplier-view]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-supplier-view]').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        state.viewMode = button.dataset.supplierView;
        renderRiskTable();
        renderModeText();
      });
    });

    el('supplierRiskBody').addEventListener('click', event => {
      const row = event.target.closest('tr[data-vendor-key]');
      if (!row) return;
      state.selectedDetailKey = row.dataset.vendorKey;
      state.selectedVendor = row.dataset.vendorKey;
      el('supplierVendorFilter').value = state.selectedVendor;
      renderDashboard();
      el('supplierDetailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    el('supplierDetailCloseBtn').addEventListener('click', () => {
      state.selectedDetailKey = '';
      el('supplierDetailPanel').classList.add('hidden');
    });
  }

  // ─────────────────────────────────────────────────────────────
  // File ingestion
  // ─────────────────────────────────────────────────────────────

  async function addFiles(files) {
    const accepted = files.filter(file => /\.(xlsx|xls|csv)$/i.test(file.name));
    if (!accepted.length) {
      setMessage('請選擇 Excel 或 CSV 檔案。', 'error');
      return;
    }

    await waitForXlsx();
    setMessage(`正在解析 ${accepted.length} 個檔案…`, 'info');

    for (const file of accepted) {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        name: file.name,
        reportMonth: '',
        status: 'loading',
        message: '解析中',
        snapshot: null,
      };
      state.fileEntries.push(entry);
      renderFileEntries();

      try {
        const snapshot = await parseFile(file);
        entry.snapshot = snapshot;
        entry.reportMonth = inferReportMonth(file.name, snapshot.currentYear);
        entry.status = snapshot.fatalErrors.length ? 'error' : 'ready';
        entry.message = snapshot.fatalErrors.length
          ? snapshot.fatalErrors.join('；')
          : `${snapshot.rows.length.toLocaleString('zh-TW')} 筆｜${snapshot.currentYear}/${snapshot.priorYear}`;
      } catch (error) {
        entry.status = 'error';
        entry.message = error.message || '檔案解析失敗';
      }
      renderFileEntries();
    }

    setMessage('檔案解析完成。請確認每個檔案的報表月份，再開始分析。', 'success');
  }

  async function waitForXlsx(timeoutMs = 12000) {
    const started = Date.now();
    while (typeof XLSX === 'undefined') {
      if (Date.now() - started > timeoutMs) {
        throw new Error('Excel 解析元件尚未載入，請重新整理頁面後再試。');
      }
      await delay(100);
    }
  }

  async function parseFile(file) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, raw: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('檔案中沒有可讀取的工作表。');
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    if (rows.length < 2) throw new Error('工作表沒有足夠的資料列。');
    return normalizeSnapshot(rows, { fileName: file.name, sheetName });
  }

  function normalizeSnapshot(rawRows, meta = {}) {
    const headers = rawRows[0].map(value => String(value ?? '').trim());
    const mapping = buildColumnMapping(headers);
    const fatalErrors = [];

    ['grp', 'sec', 'sup', 'vendorName'].forEach(field => {
      if (mapping.base[field] < 0) fatalErrors.push(`缺少 ${baseLabel(field)} 欄位`);
    });
    if (!mapping.currentYear || !mapping.priorYear) {
      fatalErrors.push('無法從欄位辨識本期及前期年度');
    }

    ['sales', 'pur', 'gp', 'bi', 'oi', 'total'].forEach(metric => {
      if (mapping.current[metric] < 0) fatalErrors.push(`缺少 ${mapping.currentYear || '本期'} ${AMOUNT_LABELS[metric]} 欄位`);
      if (mapping.prior[metric] < 0) fatalErrors.push(`缺少 ${mapping.priorYear || '前期'} ${AMOUNT_LABELS[metric]} 欄位`);
    });

    if (fatalErrors.length) {
      return {
        ...meta,
        headers,
        mapping,
        currentYear: mapping.currentYear,
        priorYear: mapping.priorYear,
        rows: [],
        qualityIssues: [],
        fatalErrors,
      };
    }

    const aggregateMap = new Map();
    const qualityIssues = [];

    rawRows.slice(1).forEach((raw, offset) => {
      if (!raw.some(cell => String(cell ?? '').trim() !== '')) return;
      const rowNumber = offset + 2;
      const grp = textCell(raw[mapping.base.grp]);
      const sec = textCell(raw[mapping.base.sec]);
      const sup = textCell(raw[mapping.base.sup]);
      const vendorName = textCell(raw[mapping.base.vendorName]);

      if (!sup && !vendorName) {
        qualityIssues.push(issue('missing-id', 'high', rowNumber, '', '供應商代碼與名稱皆為空白'));
        return;
      }

      const key = vendorKey(grp, sec, sup, vendorName);
      const currentRaw = readMetricSet(raw, mapping.current);
      const priorRaw = readMetricSet(raw, mapping.prior);
      validateRawRow(currentRaw, mapping.current, raw, mapping.currentYear, rowNumber, vendorName, qualityIssues);
      validateRawRow(priorRaw, mapping.prior, raw, mapping.priorYear, rowNumber, vendorName, qualityIssues);

      let item = aggregateMap.get(key);
      if (!item) {
        item = {
          key, grp, sec, sup, vendorName,
          current: emptyMetricSet(),
          prior: emptyMetricSet(),
          sourceRows: [],
          qualityIssues: [],
        };
        aggregateMap.set(key, item);
      } else {
        const duplicateMessage = `同一 Grp／Sec／Sup 在檔案中出現多列，系統已加總（第 ${rowNumber} 列）`;
        item.qualityIssues.push({ code: 'duplicate-row', severity: 'low', message: duplicateMessage });
        qualityIssues.push(issue('duplicate-row', 'low', rowNumber, vendorName, duplicateMessage));
      }

      item.sourceRows.push(rowNumber);
      addMetricSet(item.current, currentRaw);
      addMetricSet(item.prior, priorRaw);
    });

    const rows = Array.from(aggregateMap.values());
    rows.forEach(item => {
      finalizeMetricSet(item.current);
      finalizeMetricSet(item.prior);
      item.qualityIssues.push(...qualityIssues
        .filter(entry => entry.vendorName === item.vendorName && entry.rowNumber && item.sourceRows.includes(entry.rowNumber))
        .map(entry => ({ code: entry.code, severity: entry.severity, message: entry.message })));
    });

    return {
      ...meta,
      headers,
      mapping,
      currentYear: mapping.currentYear,
      priorYear: mapping.priorYear,
      rows,
      qualityIssues,
      fatalErrors,
      reportMonth: '',
    };
  }

  function buildColumnMapping(headers) {
    const canonical = headers.map(canonicalHeader);
    const fourDigitYears = new Set();
    canonical.forEach(header => {
      const match = header.match(/^(20\d{2})(?:SALES|PUR|GP\$|TT\$|PD\$|BI\$|OI\$|GP\+BI\+OI總計)/);
      if (match) fourDigitYears.add(Number(match[1]));
    });
    const years = Array.from(fourDigitYears).sort((a, b) => b - a);
    const currentYear = years[0] || null;
    const priorYear = years[1] || (currentYear ? currentYear - 1 : null);

    const base = {
      grp: findHeader(canonical, ['GRP']),
      sec: findHeader(canonical, ['SEC']),
      sup: findHeader(canonical, ['SUP']),
      vendorName: findHeader(canonical, ['VENDORNAME', 'VENDOR', '供應商名稱', '廠商名稱']),
    };

    return {
      currentYear,
      priorYear,
      base,
      current: buildYearMetricMapping(canonical, currentYear),
      prior: buildYearMetricMapping(canonical, priorYear),
    };
  }

  function buildYearMetricMapping(canonicalHeaders, year) {
    if (!year) return emptyMapping();
    const shortYear = String(year).slice(-2);
    return {
      sales: findHeader(canonicalHeaders, [`${year}SALES`]),
      pur: findHeader(canonicalHeaders, [`${year}PUR`]),
      gp: findHeader(canonicalHeaders, [`${year}GP$`]),
      gpRate: findHeader(canonicalHeaders, [`${year}GP%`, `${shortYear}GP%`]),
      tt: findHeader(canonicalHeaders, [`${year}TT$`]),
      ttRate: findHeader(canonicalHeaders, [`${year}TT%`, `${shortYear}TT%`]),
      pd: findHeader(canonicalHeaders, [`${year}PD$`]),
      pdRate: findHeader(canonicalHeaders, [`${year}PD%`, `${shortYear}PD%`]),
      bi: findHeader(canonicalHeaders, [`${year}BI$`]),
      biRate: findHeader(canonicalHeaders, [`${year}BI%`, `${shortYear}BI%`]),
      oi: findHeader(canonicalHeaders, [`${year}OI$`]),
      oiRate: findHeader(canonicalHeaders, [`${year}OI%`, `${shortYear}OI%`]),
      total: findHeader(canonicalHeaders, [`${year}GP+BI+OI總計`, `${year}TOTAL$`]),
      totalRate: findHeader(canonicalHeaders, [`${year}總計%`, `${shortYear}總計%`, `${year}TOTAL%`]),
    };
  }

  function emptyMapping() {
    return Object.fromEntries([...METRICS, ...RATE_METRICS].map(key => [key, -1]));
  }

  function readMetricSet(raw, mapping) {
    const result = emptyMetricSet();
    METRICS.forEach(metric => {
      result[metric] = numberCell(mapping[metric] >= 0 ? raw[mapping[metric]] : null);
    });
    RATE_METRICS.forEach(metric => {
      result[`source_${metric}`] = percentCell(mapping[metric] >= 0 ? raw[mapping[metric]] : null);
    });
    return result;
  }

  function emptyMetricSet() {
    return {
      sales: 0, pur: 0, gp: 0, tt: 0, pd: 0, bi: 0, oi: 0, total: 0,
      gpRate: null, ttRate: null, pdRate: null, biRate: null, oiRate: null, totalRate: null,
      source_gpRate: null, source_ttRate: null, source_pdRate: null,
      source_biRate: null, source_oiRate: null, source_totalRate: null,
    };
  }

  function addMetricSet(target, source) {
    METRICS.forEach(metric => { target[metric] += source[metric] || 0; });
  }

  function finalizeMetricSet(set) {
    set.gpRate = safeDivide(set.gp, set.sales);
    set.ttRate = safeDivide(set.tt, set.pur);
    set.pdRate = safeDivide(set.pd, set.pur);
    set.biRate = safeDivide(set.bi, set.pur);
    set.oiRate = safeDivide(set.oi, set.pur);
    set.totalRate = safeDivide(set.total, set.pur);
  }

  function validateRawRow(set, mapping, raw, year, rowNumber, vendorName, qualityIssues) {
    const expectedTotal = set.gp + set.bi + set.oi;
    const totalTolerance = Math.max(10, Math.abs(expectedTotal) * 0.001);
    if (Math.abs(set.total - expectedTotal) > totalTolerance) {
      qualityIssues.push(issue(
        'total-mismatch', 'high', rowNumber, vendorName,
        `${year} 總計與 GP+BI+OI 不一致（差額 ${formatMoney(set.total - expectedTotal)}）`,
      ));
    }

    const rateChecks = [
      ['gpRate', safeDivide(set.gp, set.sales), 'GP%'],
      ['ttRate', safeDivide(set.tt, set.pur), 'TT%'],
      ['pdRate', safeDivide(set.pd, set.pur), 'PD%'],
      ['biRate', safeDivide(set.bi, set.pur), 'BI%'],
      ['oiRate', safeDivide(set.oi, set.pur), 'OI%'],
      ['totalRate', safeDivide(set.total, set.pur), '總計%'],
    ];
    rateChecks.forEach(([rateKey, recalculated, label]) => {
      const source = set[`source_${rateKey}`];
      if (source === null || recalculated === null) return;
      if (Math.abs(source - recalculated) > 0.003) {
        qualityIssues.push(issue(
          'rate-mismatch', 'medium', rowNumber, vendorName,
          `${year} ${label} 與系統重算差異超過 0.3 個百分點`,
        ));
      }
    });

    METRICS.forEach(metric => {
      const columnIndex = mapping[metric];
      if (columnIndex < 0) return;
      const original = raw[columnIndex];
      if (original !== '' && original !== null && original !== undefined && !isNumericLike(original)) {
        qualityIssues.push(issue(
          'invalid-number', 'high', rowNumber, vendorName,
          `${year} ${AMOUNT_LABELS[metric]} 無法辨識為數值`,
        ));
      }
    });
  }

  function renderFileEntries() {
    const section = el('supplierFileSection');
    const body = el('supplierFileBody');
    section.classList.toggle('hidden', state.fileEntries.length === 0);

    body.innerHTML = state.fileEntries.map(entry => `
      <tr data-entry-id="${escapeHtml(entry.id)}">
        <td class="supplier-file-name">${escapeHtml(entry.name)}</td>
        <td>${entry.snapshot ? escapeHtml(entry.snapshot.sheetName || '第一工作表') : '—'}</td>
        <td>${entry.snapshot?.currentYear || '—'} / ${entry.snapshot?.priorYear || '—'}</td>
        <td><input class="supplier-month-input" type="month" value="${escapeHtml(entry.reportMonth)}" ${entry.status === 'error' ? 'disabled' : ''}></td>
        <td><span class="supplier-status supplier-status-${entry.status}">${escapeHtml(entry.message)}</span></td>
        <td><button type="button" class="btn-ghost btn-sm supplier-remove-file">移除</button></td>
      </tr>
    `).join('');

    body.querySelectorAll('tr').forEach(row => {
      const entry = state.fileEntries.find(item => item.id === row.dataset.entryId);
      row.querySelector('.supplier-month-input')?.addEventListener('change', event => {
        entry.reportMonth = event.target.value;
      });
      row.querySelector('.supplier-remove-file')?.addEventListener('click', () => {
        state.fileEntries = state.fileEntries.filter(item => item.id !== entry.id);
        renderFileEntries();
      });
    });

    el('supplierAnalyzeBtn').disabled = !state.fileEntries.some(entry => entry.status === 'ready');
  }

  // ─────────────────────────────────────────────────────────────
  // Analysis model
  // ─────────────────────────────────────────────────────────────

  function analyzeFiles() {
    const ready = state.fileEntries.filter(entry => entry.status === 'ready');
    if (!ready.length) {
      setMessage('沒有可分析的檔案。', 'error');
      return;
    }
    const missingMonth = ready.find(entry => !entry.reportMonth);
    if (missingMonth) {
      setMessage(`請指定「${missingMonth.name}」的報表月份。`, 'error');
      return;
    }

    const monthSet = new Set();
    for (const entry of ready) {
      if (monthSet.has(entry.reportMonth)) {
        setMessage(`報表月份 ${entry.reportMonth} 重複，請只保留一個檔案。`, 'error');
        return;
      }
      monthSet.add(entry.reportMonth);
    }

    const years = new Set(ready.map(entry => entry.snapshot.currentYear));
    if (years.size > 1) {
      setMessage('目前第一版一次只分析同一個本年度的月報，請分年度上傳。', 'error');
      return;
    }

    state.snapshots = ready.map(entry => ({
      ...entry.snapshot,
      reportMonth: entry.reportMonth,
      sourceName: entry.name,
    })).sort((a, b) => a.reportMonth.localeCompare(b.reportMonth));

    deriveMonthlyAmounts(state.snapshots);
    openDashboard();
    setMessage(`已完成 ${state.snapshots.length} 個月份的分析。`, 'success');
  }

  function deriveMonthlyAmounts(snapshots) {
    snapshots.forEach((snapshot, index) => {
      const previous = snapshots[index - 1] || null;
      const isJanuary = Number(snapshot.reportMonth.slice(5, 7)) === 1;
      const consecutive = previous ? monthDifference(previous.reportMonth, snapshot.reportMonth) === 1 : false;
      const previousMap = new Map((previous?.rows || []).map(row => [row.key, row]));

      snapshot.monthlyAvailable = isJanuary || consecutive;
      snapshot.monthlyNote = snapshot.monthlyAvailable
        ? ''
        : previous
          ? `前一個檔案為 ${previous.reportMonth}，與本月不連續，無法精確還原單月數。`
          : '缺少前月累計檔案，無法精確還原單月數。';

      if (!snapshot.monthlyAvailable) {
        snapshot.qualityIssues.push(issue('missing-prior-snapshot', 'medium', 0, '', snapshot.monthlyNote));
      }

      snapshot.rows.forEach(row => {
        row.monthly = { current: emptyMetricSet(), prior: emptyMetricSet(), available: snapshot.monthlyAvailable };
        if (!snapshot.monthlyAvailable) {
          METRICS.forEach(metric => {
            row.monthly.current[metric] = null;
            row.monthly.prior[metric] = null;
          });
          finalizeMetricSet(row.monthly.current);
          finalizeMetricSet(row.monthly.prior);
          return;
        }

        const previousRow = previousMap.get(row.key);
        METRICS.forEach(metric => {
          const previousCurrent = isJanuary ? 0 : (previousRow?.current?.[metric] || 0);
          const previousPrior = isJanuary ? 0 : (previousRow?.prior?.[metric] || 0);
          row.monthly.current[metric] = row.current[metric] - previousCurrent;
          row.monthly.prior[metric] = row.prior[metric] - previousPrior;
        });
        finalizeMetricSet(row.monthly.current);
        finalizeMetricSet(row.monthly.prior);
      });
    });
  }

  function openDashboard() {
    const latest = state.snapshots[state.snapshots.length - 1];
    state.selectedMonth = latest.reportMonth;
    state.selectedGrp = '';
    state.selectedSec = '';
    state.selectedVendor = '';
    state.selectedDetailKey = '';
    el('supplierDashboard').classList.remove('hidden');
    populateFilterOptions();
    renderDashboard();
    el('supplierDashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onFilterChange(event) {
    const map = {
      supplierMonthFilter: 'selectedMonth',
      supplierGrpFilter: 'selectedGrp',
      supplierSecFilter: 'selectedSec',
      supplierVendorFilter: 'selectedVendor',
    };
    state[map[event.target.id]] = event.target.value;

    if (event.target.id === 'supplierMonthFilter') {
      state.selectedGrp = '';
      state.selectedSec = '';
      state.selectedVendor = '';
      populateFilterOptions();
    } else if (event.target.id === 'supplierGrpFilter') {
      state.selectedSec = '';
      state.selectedVendor = '';
      populateDependentFilters();
    } else if (event.target.id === 'supplierSecFilter') {
      state.selectedVendor = '';
      populateVendorFilter();
    }

    renderDashboard();
  }

  function populateFilterOptions() {
    const monthSelect = el('supplierMonthFilter');
    monthSelect.innerHTML = state.snapshots.map(snapshot =>
      `<option value="${snapshot.reportMonth}">${formatMonth(snapshot.reportMonth)}</option>`
    ).join('');
    monthSelect.value = state.selectedMonth;
    populateDependentFilters();
  }

  function populateDependentFilters() {
    const snapshot = getSelectedSnapshot();
    const groups = uniqueSorted(snapshot.rows.map(row => row.grp).filter(Boolean));
    fillSelect(el('supplierGrpFilter'), groups, '全部 Grp', state.selectedGrp);

    const rows = snapshot.rows.filter(row => !state.selectedGrp || row.grp === state.selectedGrp);
    const sections = uniqueSorted(rows.map(row => row.sec).filter(Boolean));
    fillSelect(el('supplierSecFilter'), sections, '全部 Sec', state.selectedSec);
    populateVendorFilter();
  }

  function populateVendorFilter() {
    const snapshot = getSelectedSnapshot();
    const rows = snapshot.rows.filter(row =>
      (!state.selectedGrp || row.grp === state.selectedGrp) &&
      (!state.selectedSec || row.sec === state.selectedSec)
    );
    const options = rows
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'zh-TW'))
      .map(row => ({ value: row.key, label: `${row.vendorName || row.sup}（${row.sup || '無代碼'}）` }));
    fillObjectSelect(el('supplierVendorFilter'), options, '全部供應商', state.selectedVendor);
  }

  function renderDashboard() {
    const snapshot = getSelectedSnapshot();
    if (!snapshot) return;
    const rows = getFilteredRows(snapshot);
    state.riskEntries = buildRiskEntries(snapshot, rows);

    renderModeText();
    renderSummaryMeta(snapshot, rows);
    renderQualitySummary(snapshot);
    renderKpis(snapshot, rows);
    renderCharts(snapshot, rows);
    renderRiskTable();
    renderSupplierDetail();
  }

  function renderModeText() {
    const audit = state.viewMode === 'audit';
    el('supplierRiskTitle').textContent = audit ? '稽核優先查核清單' : '顯著變動與待說明事項';
    el('supplierRiskSubtitle').textContent = audit
      ? '依風險分數排序，供稽核規劃與抽樣使用。'
      : '以中性文字呈現，適合與受查單位進行事實確認。';
  }

  function renderSummaryMeta(snapshot, rows) {
    const first = state.snapshots[0]?.reportMonth;
    const currentYear = snapshot.currentYear;
    const month = Number(snapshot.reportMonth.slice(5, 7));
    const monthlyText = snapshot.monthlyAvailable ? '已可還原單月數' : '本月單月數尚不可還原';
    el('supplierDashboardMeta').textContent =
      `資料期間 ${formatMonth(first)}～${formatMonth(snapshot.reportMonth)}｜` +
      `${currentYear} 年截至 ${month} 月累計 vs ${snapshot.priorYear} 年同期｜` +
      `${rows.length.toLocaleString('zh-TW')} 筆供應商／部門組合｜${monthlyText}`;
  }

  function renderQualitySummary(snapshot) {
    const issues = snapshot.qualityIssues || [];
    const severe = issues.filter(item => ['high', 'critical'].includes(item.severity)).length;
    const unavailable = state.snapshots.filter(item => !item.monthlyAvailable).length;
    const box = el('supplierQualitySummary');

    if (!issues.length && !unavailable) {
      box.className = 'supplier-quality supplier-quality-good';
      box.innerHTML = '<strong>資料品質檢查通過</strong><span>總計公式與主要比率未發現顯著差異。</span>';
      return;
    }

    box.className = severe ? 'supplier-quality supplier-quality-alert' : 'supplier-quality supplier-quality-warn';
    box.innerHTML = `
      <strong>資料品質提醒：${issues.length} 項</strong>
      <span>高風險 ${severe} 項；${unavailable ? `${unavailable} 個月份無法精確還原單月數。` : '月份資料可連續換算。'}</span>
      <button type="button" id="supplierQualityDetailBtn" class="btn-ghost btn-sm">查看明細</button>
    `;
    el('supplierQualityDetailBtn')?.addEventListener('click', () => showQualityDetails(snapshot));
  }

  function renderKpis(snapshot, rows) {
    const current = aggregateRows(rows, 'current');
    const prior = aggregateRows(rows, 'prior');
    const highRisk = state.riskEntries.filter(item => ['high', 'critical'].includes(item.severity)).length;
    const vendors = new Set(rows.map(row => row.sup || row.vendorName)).size;
    const cards = [
      { label: '供應商數', value: formatInteger(vendors), sub: `${rows.length.toLocaleString('zh-TW')} 個部門組合` },
      { label: `${snapshot.currentYear} YTD Sales`, value: formatMoneyCompact(current.sales), sub: growthLabel(current.sales, prior.sales, '去年同期') },
      { label: `${snapshot.currentYear} YTD GP$`, value: formatMoneyCompact(current.gp), sub: growthLabel(current.gp, prior.gp, '去年同期') },
      { label: 'YTD GP%', value: formatPercent(current.gpRate), sub: percentagePointLabel(current.gpRate, prior.gpRate) },
      { label: 'YTD BI + OI', value: formatMoneyCompact(current.bi + current.oi), sub: growthLabel(current.bi + current.oi, prior.bi + prior.oi, '去年同期') },
      { label: 'YTD 總貢獻', value: formatMoneyCompact(current.total), sub: growthLabel(current.total, prior.total, '去年同期') },
      { label: 'YTD 總貢獻率', value: formatPercent(current.totalRate), sub: percentagePointLabel(current.totalRate, prior.totalRate) },
      { label: state.viewMode === 'audit' ? '高風險供應商' : '優先釐清項目', value: formatInteger(highRisk), sub: `共 ${state.riskEntries.length} 家觸發規則` },
    ];

    el('supplierKpiGrid').innerHTML = cards.map(card => `
      <article class="supplier-kpi-card">
        <span class="supplier-kpi-label">${escapeHtml(card.label)}</span>
        <strong class="supplier-kpi-value">${escapeHtml(card.value)}</strong>
        <span class="supplier-kpi-sub">${escapeHtml(card.sub)}</span>
      </article>
    `).join('');
  }

  // ─────────────────────────────────────────────────────────────
  // Charts
  // ─────────────────────────────────────────────────────────────

  function renderCharts(snapshot, rows) {
    if (typeof Chart === 'undefined') {
      setMessage('圖表元件尚未載入，請確認網路連線後重新整理。', 'error');
      return;
    }
    Chart.defaults.color = '#222222';
    Chart.defaults.font.family = "'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    Chart.defaults.font.size = 12;

    renderSalesTrendChart();
    renderRateTrendChart();
    renderTopSupplierChart(snapshot, rows);
    renderScatterChart(snapshot, rows);
    renderGroupChart(snapshot, rows);
    renderRiskChart();
  }

  function renderSalesTrendChart() {
    const labels = state.snapshots.map(snapshot => formatShortMonth(snapshot.reportMonth));
    const current = [];
    const prior = [];
    state.snapshots.forEach(snapshot => {
      const rows = getFilteredRows(snapshot, { ignoreMonth: true });
      if (!snapshot.monthlyAvailable) {
        current.push(null);
        prior.push(null);
      } else {
        current.push(sumRows(rows, 'monthly.current', 'sales'));
        prior.push(sumRows(rows, 'monthly.prior', 'sales'));
      }
    });

    createChart('supplierSalesTrendChart', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '本年度單月 Sales', data: current, borderColor: '#3478c9', backgroundColor: 'rgba(52,120,201,.12)', tension: .25, spanGaps: false, pointRadius: 3 },
          { label: '前年度同月 Sales', data: prior, borderColor: '#8a8f9a', backgroundColor: 'rgba(138,143,154,.08)', borderDash: [6, 4], tension: .25, spanGaps: false, pointRadius: 3 },
        ],
      },
      options: commonChartOptions({
        title: '單月 Sales 趨勢',
        moneyAxis: true,
      }),
    });
  }

  function renderRateTrendChart() {
    const labels = state.snapshots.map(snapshot => formatShortMonth(snapshot.reportMonth));
    const current = [];
    const prior = [];
    state.snapshots.forEach(snapshot => {
      const rows = getFilteredRows(snapshot, { ignoreMonth: true });
      if (!snapshot.monthlyAvailable) {
        current.push(null);
        prior.push(null);
        return;
      }
      const currentSales = sumRows(rows, 'monthly.current', 'sales');
      const currentGp = sumRows(rows, 'monthly.current', 'gp');
      const priorSales = sumRows(rows, 'monthly.prior', 'sales');
      const priorGp = sumRows(rows, 'monthly.prior', 'gp');
      current.push(toPercentPoint(safeDivide(currentGp, currentSales)));
      prior.push(toPercentPoint(safeDivide(priorGp, priorSales)));
    });

    createChart('supplierRateTrendChart', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '本年度單月 GP%', data: current, borderColor: '#218653', tension: .25, pointRadius: 3 },
          { label: '前年度同月 GP%', data: prior, borderColor: '#8a8f9a', borderDash: [6, 4], tension: .25, pointRadius: 3 },
        ],
      },
      options: commonChartOptions({ title: '單月 GP% 趨勢', percentAxis: true }),
    });
  }

  function renderTopSupplierChart(snapshot, rows) {
    const top = [...rows].sort((a, b) => b.current.total - a.current.total).slice(0, 10);
    createChart('supplierTopChart', {
      type: 'bar',
      data: {
        labels: top.map(row => shortVendorName(row.vendorName || row.sup, 16)),
        datasets: [{
          label: `${snapshot.currentYear} YTD 總貢獻`,
          data: top.map(row => row.current.total),
          backgroundColor: 'rgba(52,120,201,.72)',
          borderColor: '#3478c9',
          borderWidth: 1,
          vendorKeys: top.map(row => row.key),
        }],
      },
      options: {
        ...commonChartOptions({ title: 'Top 10 供應商總貢獻', moneyAxis: true, horizontal: true }),
        indexAxis: 'y',
        onClick: (_event, elements, chart) => {
          if (!elements.length) return;
          const key = chart.data.datasets[0].vendorKeys[elements[0].index];
          selectVendor(key);
        },
      },
    });
  }

  function renderScatterChart(snapshot, rows) {
    const riskMap = new Map(state.riskEntries.map(entry => [entry.key, entry]));
    const maxTotal = Math.max(...rows.map(row => Math.abs(row.current.total)), 1);
    const points = rows.map(row => {
      const risk = riskMap.get(row.key);
      return {
        x: row.current.sales,
        y: toPercentPoint(row.current.gpRate),
        r: 4 + Math.sqrt(Math.abs(row.current.total) / maxTotal) * 12,
        vendor: row.vendorName || row.sup,
        key: row.key,
        risk: risk?.severity || 'none',
        total: row.current.total,
      };
    });
    const colors = points.map(point => severityColor(point.risk, .68));

    createChart('supplierScatterChart', {
      type: 'bubble',
      data: {
        datasets: [{
          label: `${snapshot.currentYear} YTD 供應商`,
          data: points,
          backgroundColor: colors,
          borderColor: colors.map(color => color.replace(/0?\.68\)/, '1)')),
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        onClick: (_event, elements, chart) => {
          if (!elements.length) return;
          selectVendor(chart.data.datasets[0].data[elements[0].index].key);
        },
        plugins: {
          title: chartTitle('Sales 與 GP% 四象限'),
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: context => {
                const point = context.raw;
                return [
                  point.vendor,
                  `Sales：${formatMoney(point.x)}`,
                  `GP%：${formatPercent(point.y / 100)}`,
                  `總貢獻：${formatMoney(point.total)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'YTD Sales' }, ticks: { callback: compactNumber }, grid: lightGrid() },
          y: { title: { display: true, text: 'YTD GP%' }, ticks: { callback: value => `${value}%` }, grid: lightGrid() },
        },
      },
    });
  }

  function renderGroupChart(snapshot, rows) {
    const map = new Map();
    rows.forEach(row => {
      const key = row.grp || '未分類';
      if (!map.has(key)) map.set(key, { current: 0, prior: 0 });
      map.get(key).current += row.current.total;
      map.get(key).prior += row.prior.total;
    });
    const groups = Array.from(map.entries()).sort((a, b) => b[1].current - a[1].current);

    createChart('supplierGroupChart', {
      type: 'bar',
      data: {
        labels: groups.map(([name]) => `Grp ${name}`),
        datasets: [
          { label: `${snapshot.currentYear} YTD`, data: groups.map(([, value]) => value.current), backgroundColor: 'rgba(199,155,0,.72)' },
          { label: `${snapshot.priorYear} 同期`, data: groups.map(([, value]) => value.prior), backgroundColor: 'rgba(138,143,154,.45)' },
        ],
      },
      options: commonChartOptions({ title: 'Grp 別總貢獻比較', moneyAxis: true }),
    });
  }

  function renderRiskChart() {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    state.riskEntries.forEach(entry => { counts[entry.severity] += 1; });
    createChart('supplierRiskChart', {
      type: 'doughnut',
      data: {
        labels: state.viewMode === 'audit'
          ? ['重大', '高', '中', '低']
          : ['優先釐清', '建議釐清', '留意', '一般提醒'],
        datasets: [{
          data: [counts.critical, counts.high, counts.medium, counts.low],
          backgroundColor: ['#9b1c1c', '#d34c4c', '#d79b1e', '#4b86c6'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: chartTitle(state.viewMode === 'audit' ? '稽核風險分布' : '待說明項目分布'),
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16 } },
          tooltip: { callbacks: { label: context => `${context.label}：${context.raw} 家` } },
        },
      },
    });
  }

  function createChart(canvasId, config) {
    const canvas = el(canvasId);
    if (!canvas) return;
    state.charts.get(canvasId)?.destroy();
    state.charts.set(canvasId, new Chart(canvas, config));
  }

  function commonChartOptions({ title, moneyAxis = false, percentAxis = false, horizontal = false } = {}) {
    const valueAxis = horizontal ? 'x' : 'y';
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        title: chartTitle(title),
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16 } },
        tooltip: {
          callbacks: {
            label: context => {
              const value = horizontal ? context.parsed.x : context.parsed.y;
              if (value === null || value === undefined) return `${context.dataset.label}：無法換算`;
              if (moneyAxis) return `${context.dataset.label}：${formatMoney(value)}`;
              if (percentAxis) return `${context.dataset.label}：${Number(value).toFixed(1)}%`;
              return `${context.dataset.label}：${value}`;
            },
          },
        },
      },
      scales: {
        x: { grid: lightGrid(), ticks: horizontal && moneyAxis ? { callback: compactNumber } : {} },
        y: { grid: lightGrid(), ticks: !horizontal && moneyAxis ? { callback: compactNumber } : percentAxis ? { callback: value => `${value}%` } : {} },
      },
    };
  }

  function chartTitle(text) {
    return { display: true, text, color: '#111111', font: { size: 15, weight: '600' }, padding: { bottom: 14 } };
  }

  function lightGrid() {
    return { color: 'rgba(24,32,51,.08)', drawBorder: false };
  }

  // ─────────────────────────────────────────────────────────────
  // Audit rules
  // ─────────────────────────────────────────────────────────────

  function buildRiskEntries(snapshot, rows) {
    const secSales = new Map();
    rows.forEach(row => {
      const key = `${row.grp}|${row.sec}`;
      secSales.set(key, (secSales.get(key) || 0) + row.current.sales);
    });

    const currentRanks = rankMap(rows, row => row.current.sales);
    const priorRanks = rankMap(rows, row => row.prior.sales);

    return rows.map(row => {
      const findings = [];
      let score = 0;
      const salesGrowth = growth(row.current.sales, row.prior.sales);
      const totalGrowth = growth(row.current.total, row.prior.total);
      const gpRateChange = difference(row.current.gpRate, row.prior.gpRate);
      const concentration = safeDivide(row.current.sales, secSales.get(`${row.grp}|${row.sec}`) || 0);
      const currentRank = currentRanks.get(row.key);
      const priorRank = priorRanks.get(row.key);

      const add = (points, code, severity, auditLabel, communicationLabel, auditQuestion, communicationQuestion) => {
        score += points;
        findings.push({ code, severity, auditLabel, communicationLabel, auditQuestion, communicationQuestion });
      };

      if (row.current.gp < 0) {
        add(35, 'negative-gp', 'high', '本期累計毛利為負', '本期累計毛利呈負值',
          '查核負毛利交易、售價、進價及相關調整是否合理。', '請說明負毛利形成原因及改善措施。');
      }
      if (salesGrowth !== null && salesGrowth > .30) {
        add(12, 'sales-up', 'medium', `Sales 較去年同期增加 ${formatPercent(salesGrowth)}`, `Sales 較去年同期顯著增加 ${formatPercent(salesGrowth)}`,
          '確認交易量、價格、促銷條件及供應商核准程序。', '請補充本期業績成長原因及主要交易條件。');
      }
      if (salesGrowth !== null && salesGrowth < -.30) {
        add(12, 'sales-down', 'medium', `Sales 較去年同期下降 ${formatPercent(Math.abs(salesGrowth))}`, `Sales 較去年同期顯著下降 ${formatPercent(Math.abs(salesGrowth))}`,
          '確認交易縮減、停止合作、商品組合及資料完整性。', '請說明本期業績下降原因及後續安排。');
      }
      if (gpRateChange !== null && gpRateChange < -.03) {
        add(25, 'gp-rate-drop', 'high', `GP% 較去年同期下降 ${formatPercentagePoints(Math.abs(gpRateChange))}`, `GP% 較去年同期明顯下降 ${formatPercentagePoints(Math.abs(gpRateChange))}`,
          '查核進售價、促銷、折讓、成本歸屬及毛利認列。', '請說明毛利率下降原因，並補充進售價或促銷條件變動。');
      }
      if (salesGrowth !== null && salesGrowth > .10 && totalGrowth !== null && totalGrowth < 0) {
        add(25, 'sales-up-total-down', 'high', 'Sales 成長但總貢獻下降', 'Sales 成長但整體貢獻未同步提升',
          '查核 GP、BI、OI 的認列完整性與商業條件是否惡化。', '請說明業績成長與整體貢獻變動不一致的原因。');
      }
      if (concentration !== null && concentration > .40 && rows.length > 1) {
        add(20, 'concentration', 'high', `占該 Sec Sales ${formatPercent(concentration)}`, `占該 Sec Sales 比重達 ${formatPercent(concentration)}`,
          '評估供應商集中、替代性、議價條件與舞弊風險。', '請補充此供應商占比較高的商業原因及替代方案。');
      }
      if (currentRank && priorRank && Math.abs(currentRank - priorRank) >= 10) {
        add(10, 'rank-change', 'medium', `Sales 排名由 ${priorRank} 變為 ${currentRank}`, `Sales 排名較去年同期有明顯變動（${priorRank} → ${currentRank}）`,
          '確認排名跳動是否由一次性交易、供應商切換或分類調整造成。', '請說明供應商排名顯著變動的主要原因。');
      }
      if (row.monthly?.available && row.monthly.current.sales < 0) {
        add(25, 'negative-monthly-sales', 'high', '本月累計差額為負，可能有沖回或調整', '本月換算數為負值，請確認是否有沖回或調整',
          '查核退貨、沖銷、跨期調整及截止性。', '請補充本月負值的交易或會計調整明細。');
      }
      if (row.monthly?.available && row.monthly.current.gp < 0) {
        add(18, 'negative-monthly-gp', 'medium', '本月換算 GP$ 為負', '本月換算 GP$ 呈負值',
          '查核當月負毛利交易、成本回沖及促銷折讓。', '請說明本月負毛利的主要原因。');
      }

      const anomaly = detectMonthlyAnomaly(row.key, snapshot.reportMonth, 'sales');
      if (anomaly) {
        add(15, 'monthly-spike', 'medium', anomaly.audit, anomaly.communication,
          '查核異常月份交易明細、合約條件及認列時點。', '請補充該月份顯著變動的原因及明細。');
      }

      row.qualityIssues.forEach(quality => {
        const points = quality.severity === 'high' ? 20 : 8;
        add(points, quality.code, quality.severity === 'high' ? 'high' : 'medium',
          `資料品質：${quality.message}`, `資料需確認：${quality.message}`,
          '先完成來源資料勾稽，再判斷績效異常。', '請確認原始報表欄位與計算結果。');
      });

      if (row.prior.sales === 0 && row.current.sales > 0) {
        add(5, 'new-vendor', 'low', '去年同期無 Sales，可能為新供應商或新交易', '去年同期無 Sales，可能為新增合作',
          '確認新增供應商核准、比價、合約及首次交易程序。', '請補充新增合作背景與核准程序。');
      }

      if (!findings.length) return null;
      score = Math.min(100, score);
      return {
        key: row.key,
        row,
        score,
        severity: score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low',
        findings,
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.row.current.sales - a.row.current.sales);
  }

  function detectMonthlyAnomaly(key, reportMonth, metric) {
    const index = state.snapshots.findIndex(snapshot => snapshot.reportMonth === reportMonth);
    const currentSnapshot = state.snapshots[index];
    const currentRow = currentSnapshot?.rows.find(row => row.key === key);
    const currentValue = currentRow?.monthly?.available ? currentRow.monthly.current[metric] : null;
    if (currentValue === null || currentValue === undefined) return null;

    const history = [];
    for (let i = Math.max(0, index - 3); i < index; i++) {
      const row = state.snapshots[i].rows.find(item => item.key === key);
      const value = row?.monthly?.available ? row.monthly.current[metric] : null;
      if (value !== null && value !== undefined) history.push(value);
    }
    if (history.length < 2) return null;
    const average = history.reduce((sum, value) => sum + value, 0) / history.length;
    if (Math.abs(average) < 100000) return null;
    const change = (currentValue - average) / Math.abs(average);
    if (Math.abs(change) <= .50 || Math.abs(currentValue - average) < 100000) return null;
    const direction = change > 0 ? '增加' : '下降';
    return {
      audit: `本月 Sales 較近 ${history.length} 月平均${direction} ${formatPercent(Math.abs(change))}`,
      communication: `本月 Sales 較近期平均有顯著${direction}（${formatPercent(Math.abs(change))}）`,
    };
  }

  function renderRiskTable() {
    const audit = state.viewMode === 'audit';
    const body = el('supplierRiskBody');
    el('supplierRiskCount').textContent = `${state.riskEntries.length} 家`;

    if (!state.riskEntries.length) {
      body.innerHTML = `<tr><td colspan="9" class="supplier-empty-cell">目前篩選範圍未觸發異常規則。</td></tr>`;
      return;
    }

    body.innerHTML = state.riskEntries.map(entry => {
      const primary = entry.findings.slice(0, 3);
      const labels = primary.map(finding => audit ? finding.auditLabel : finding.communicationLabel);
      const questions = unique(primary.map(finding => audit ? finding.auditQuestion : finding.communicationQuestion));
      const row = entry.row;
      return `
        <tr data-vendor-key="${escapeHtml(entry.key)}">
          <td><span class="supplier-risk-badge risk-${entry.severity}">${audit ? severityLabel(entry.severity) : communicationSeverityLabel(entry.severity)}</span><strong class="supplier-risk-score">${entry.score}</strong></td>
          <td>${escapeHtml(row.grp || '—')}</td>
          <td>${escapeHtml(row.sec || '—')}</td>
          <td><strong>${escapeHtml(row.vendorName || row.sup)}</strong><small>${escapeHtml(row.sup || '')}</small></td>
          <td>${formatMoney(row.current.sales)}<small>${growthLabel(row.current.sales, row.prior.sales, 'YoY')}</small></td>
          <td>${formatPercent(row.current.gpRate)}<small>${percentagePointLabel(row.current.gpRate, row.prior.gpRate)}</small></td>
          <td>${formatMoney(row.current.total)}<small>${growthLabel(row.current.total, row.prior.total, 'YoY')}</small></td>
          <td><ul class="supplier-finding-list">${labels.map(label => `<li>${escapeHtml(label)}</li>`).join('')}</ul>${entry.findings.length > 3 ? `<small>另有 ${entry.findings.length - 3} 項</small>` : ''}</td>
          <td>${questions.map(question => `<p>${escapeHtml(question)}</p>`).join('')}</td>
        </tr>
      `;
    }).join('');
  }

  // ─────────────────────────────────────────────────────────────
  // Supplier detail
  // ─────────────────────────────────────────────────────────────

  function renderSupplierDetail() {
    const key = state.selectedDetailKey || state.selectedVendor;
    const panel = el('supplierDetailPanel');
    if (!key) {
      panel.classList.add('hidden');
      return;
    }
    const snapshot = getSelectedSnapshot();
    const row = snapshot.rows.find(item => item.key === key);
    if (!row) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    state.selectedDetailKey = key;
    el('supplierDetailTitle').textContent = row.vendorName || row.sup;
    el('supplierDetailMeta').textContent = `Grp ${row.grp || '—'}｜Sec ${row.sec || '—'}｜Sup ${row.sup || '—'}`;

    const metrics = [
      ['YTD Sales', row.current.sales, row.prior.sales, 'money'],
      ['YTD GP$', row.current.gp, row.prior.gp, 'money'],
      ['YTD GP%', row.current.gpRate, row.prior.gpRate, 'percent'],
      ['YTD BI$', row.current.bi, row.prior.bi, 'money'],
      ['YTD OI$', row.current.oi, row.prior.oi, 'money'],
      ['YTD 總貢獻', row.current.total, row.prior.total, 'money'],
    ];
    el('supplierDetailKpis').innerHTML = metrics.map(([label, current, prior, type]) => `
      <div class="supplier-detail-kpi">
        <span>${label}</span>
        <strong>${type === 'money' ? formatMoneyCompact(current) : formatPercent(current)}</strong>
        <small>${type === 'money' ? growthLabel(current, prior, 'YoY') : percentagePointLabel(current, prior)}</small>
      </div>
    `).join('');

    const history = state.snapshots.map(item => {
      const historyRow = item.rows.find(value => value.key === key);
      return { snapshot: item, row: historyRow };
    }).filter(item => item.row);
    el('supplierDetailBody').innerHTML = history.map(({ snapshot: item, row: historyRow }) => `
      <tr>
        <td>${formatMonth(item.reportMonth)}</td>
        <td>${historyRow.monthly?.available ? formatMoney(historyRow.monthly.current.sales) : '—'}</td>
        <td>${historyRow.monthly?.available ? formatMoney(historyRow.monthly.current.gp) : '—'}</td>
        <td>${historyRow.monthly?.available ? formatPercent(historyRow.monthly.current.gpRate) : '—'}</td>
        <td>${formatMoney(historyRow.current.sales)}</td>
        <td>${formatMoney(historyRow.current.total)}</td>
        <td>${formatPercent(historyRow.current.totalRate)}</td>
      </tr>
    `).join('');
  }

  function selectVendor(key) {
    state.selectedVendor = key;
    state.selectedDetailKey = key;
    el('supplierVendorFilter').value = key;
    renderDashboard();
  }

  // ─────────────────────────────────────────────────────────────
  // Demo data
  // ─────────────────────────────────────────────────────────────

  function loadDemoData() {
    clearAll({ preserveMessage: true });
    state.snapshots = buildDemoSnapshots();
    deriveMonthlyAmounts(state.snapshots);
    openDashboard();
    el('supplierFileSection').classList.remove('hidden');
    el('supplierFileBody').innerHTML = state.snapshots.map(snapshot => `
      <tr>
        <td class="supplier-file-name">示範月報_${snapshot.reportMonth}.xlsx</td>
        <td>Vendor Performance</td>
        <td>${snapshot.currentYear} / ${snapshot.priorYear}</td>
        <td>${snapshot.reportMonth}</td>
        <td><span class="supplier-status supplier-status-ready">${snapshot.rows.length} 筆｜示範資料</span></td>
        <td>—</td>
      </tr>
    `).join('');
    setMessage('已載入示範資料，可直接操作篩選、圖表與異常清單。', 'success');
  }

  function buildDemoSnapshots() {
    const random = mulberry32(20250723);
    const vendors = Array.from({ length: 24 }, (_, index) => {
      const group = String(1 + (index % 4));
      const section = String(10 + (index % 8));
      return {
        key: vendorKey(group, section, String(7001 + index), `示範供應商 ${String.fromCharCode(65 + index)}`),
        grp: group,
        sec: section,
        sup: String(7001 + index),
        vendorName: `示範供應商 ${String.fromCharCode(65 + index)}`,
        baseSales: 500000 + random() * 4200000,
        priorGpRate: .12 + random() * .13,
        purchaseRate: .70 + random() * .12,
        biRate: .02 + random() * .055,
        oiRate: .015 + random() * .065,
        growth: -.08 + random() * .22,
      };
    });

    const cumulative = new Map(vendors.map(vendor => [vendor.key, { current: emptyMetricSet(), prior: emptyMetricSet() }]));
    const snapshots = [];
    for (let month = 1; month <= 6; month++) {
      const rows = [];
      vendors.forEach((vendor, index) => {
        const season = 1 + Math.sin((month + index % 3) / 2) * .10;
        let priorSales = vendor.baseSales * season * (.85 + random() * .30);
        let currentSales = priorSales * (1 + vendor.growth + (random() - .5) * .12);
        let currentGpRate = vendor.priorGpRate + (random() - .5) * .018;

        if (index === 2 && month === 6) { currentSales *= 1.75; currentGpRate -= .065; }
        if (index === 6 && month === 5) currentSales = -320000;
        if (index === 9 && month >= 4) currentGpRate -= .045;
        if (index === 0) currentSales *= 2.8;

        const priorPur = priorSales * vendor.purchaseRate;
        const currentPur = currentSales * vendor.purchaseRate;
        const priorGp = priorSales * vendor.priorGpRate;
        const currentGp = currentSales * currentGpRate;
        const priorBi = priorPur * vendor.biRate;
        const currentBi = currentPur * vendor.biRate * (1 + (random() - .5) * .1);
        const priorOi = priorPur * vendor.oiRate;
        const currentOi = currentPur * vendor.oiRate * (1 + (random() - .5) * .18);
        const priorPd = index % 4 === 0 ? priorPur * .007 : 0;
        const currentPd = index % 4 === 0 ? currentPur * .007 : 0;
        const priorTt = priorPd + priorBi;
        const currentTt = currentPd + currentBi;

        const cumulativeItem = cumulative.get(vendor.key);
        const currentMonth = {
          sales: currentSales, pur: currentPur, gp: currentGp, tt: currentTt, pd: currentPd,
          bi: currentBi, oi: currentOi, total: currentGp + currentBi + currentOi,
        };
        const priorMonth = {
          sales: priorSales, pur: priorPur, gp: priorGp, tt: priorTt, pd: priorPd,
          bi: priorBi, oi: priorOi, total: priorGp + priorBi + priorOi,
        };
        METRICS.forEach(metric => {
          cumulativeItem.current[metric] += currentMonth[metric];
          cumulativeItem.prior[metric] += priorMonth[metric];
        });
        finalizeMetricSet(cumulativeItem.current);
        finalizeMetricSet(cumulativeItem.prior);

        rows.push({
          ...vendor,
          current: cloneMetricSet(cumulativeItem.current),
          prior: cloneMetricSet(cumulativeItem.prior),
          sourceRows: [index + 2],
          qualityIssues: index === 14 && month === 6
            ? [{ code: 'rate-mismatch', severity: 'medium', message: '示範：總計% 與系統重算差異超過 0.3 個百分點' }]
            : [],
        });
      });

      snapshots.push({
        fileName: `示範月報_2025-${String(month).padStart(2, '0')}.xlsx`,
        sourceName: `示範月報_2025-${String(month).padStart(2, '0')}.xlsx`,
        sheetName: 'Vendor Performance',
        reportMonth: `2025-${String(month).padStart(2, '0')}`,
        currentYear: 2025,
        priorYear: 2024,
        rows,
        qualityIssues: [],
        fatalErrors: [],
      });
    }
    return snapshots;
  }

  // ─────────────────────────────────────────────────────────────
  // Export / quality detail / clear
  // ─────────────────────────────────────────────────────────────

  function exportExceptionsCsv() {
    if (!state.riskEntries.length) {
      setMessage('目前沒有可匯出的異常清單。', 'error');
      return;
    }
    const audit = state.viewMode === 'audit';
    const headers = ['風險等級', '風險分數', 'Grp', 'Sec', 'Sup', 'Vendorname', 'YTD Sales', 'YTD GP%', 'YTD 總貢獻', audit ? '異常事項' : '顯著變動', audit ? '建議查核方向' : '建議補充資料'];
    const rows = state.riskEntries.map(entry => {
      const findings = entry.findings.map(item => audit ? item.auditLabel : item.communicationLabel).join('；');
      const questions = unique(entry.findings.map(item => audit ? item.auditQuestion : item.communicationQuestion)).join('；');
      return [
        audit ? severityLabel(entry.severity) : communicationSeverityLabel(entry.severity),
        entry.score,
        entry.row.grp,
        entry.row.sec,
        entry.row.sup,
        entry.row.vendorName,
        entry.row.current.sales,
        entry.row.current.gpRate,
        entry.row.current.total,
        findings,
        questions,
      ];
    });
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    downloadBlob(csv, `供應商${audit ? '稽核異常' : '待說明事項'}_${state.selectedMonth}.csv`, 'text/csv;charset=utf-8');
  }

  function showQualityDetails(snapshot) {
    const issues = snapshot.qualityIssues || [];
    const lines = issues.slice(0, 80).map(item => `${item.rowNumber ? `第 ${item.rowNumber} 列｜` : ''}${item.vendorName ? `${item.vendorName}｜` : ''}${item.message}`);
    if (issues.length > 80) lines.push(`另有 ${issues.length - 80} 項未顯示。`);
    alert(lines.length ? lines.join('\n') : '沒有資料品質異常。');
  }

  function clearAll({ preserveMessage = false } = {}) {
    state.fileEntries = [];
    state.snapshots = [];
    state.selectedMonth = '';
    state.selectedGrp = '';
    state.selectedSec = '';
    state.selectedVendor = '';
    state.selectedDetailKey = '';
    state.riskEntries = [];
    state.charts.forEach(chart => chart.destroy());
    state.charts.clear();
    renderFileEntries();
    el('supplierFileBody').innerHTML = '';
    el('supplierFileSection').classList.add('hidden');
    el('supplierDashboard').classList.add('hidden');
    el('supplierDetailPanel').classList.add('hidden');
    if (!preserveMessage) setMessage('資料已清除。', 'info');
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  function getSelectedSnapshot() {
    return state.snapshots.find(snapshot => snapshot.reportMonth === state.selectedMonth) || state.snapshots[state.snapshots.length - 1];
  }

  function getFilteredRows(snapshot, { ignoreMonth = false } = {}) {
    if (!snapshot) return [];
    return snapshot.rows.filter(row =>
      (!state.selectedGrp || row.grp === state.selectedGrp) &&
      (!state.selectedSec || row.sec === state.selectedSec) &&
      (!state.selectedVendor || row.key === state.selectedVendor)
    );
  }

  function aggregateRows(rows, period) {
    const aggregate = emptyMetricSet();
    rows.forEach(row => {
      const source = period.split('.').reduce((value, key) => value?.[key], row);
      if (!source) return;
      METRICS.forEach(metric => { aggregate[metric] += source[metric] || 0; });
    });
    finalizeMetricSet(aggregate);
    return aggregate;
  }

  function sumRows(rows, path, metric) {
    return rows.reduce((sum, row) => {
      const source = path.split('.').reduce((value, key) => value?.[key], row);
      const value = source?.[metric];
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function rankMap(rows, accessor) {
    const sorted = [...rows].sort((a, b) => accessor(b) - accessor(a));
    return new Map(sorted.map((row, index) => [row.key, index + 1]));
  }

  function cloneMetricSet(set) {
    return { ...set };
  }

  function vendorKey(grp, sec, sup, vendorName) {
    return [grp, sec, sup || '', normalizeName(vendorName)].join('|');
  }

  function canonicalHeader(value) {
    return String(value ?? '')
      .trim()
      .replace(/[\s　]+/g, '')
      .replace(/％/g, '%')
      .replace(/＄/g, '$')
      .toUpperCase();
  }

  function findHeader(canonicalHeaders, variants) {
    const normalized = variants.map(canonicalHeader);
    return canonicalHeaders.findIndex(header => normalized.includes(header));
  }

  function inferReportMonth(fileName, currentYear) {
    const name = String(fileName || '');
    let match = name.match(/(20\d{2})[^0-9]?(0?[1-9]|1[0-2])(?:月)?/);
    if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
    match = name.match(/(20\d{2})(0[1-9]|1[0-2])/);
    if (match) return `${match[1]}-${match[2]}`;
    match = name.match(/(?:^|[^0-9])(0?[1-9]|1[0-2])月/);
    if (match && currentYear) return `${currentYear}-${String(Number(match[1])).padStart(2, '0')}`;
    return '';
  }

  function monthDifference(from, to) {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    return (ty * 12 + tm) - (fy * 12 + fm);
  }

  function textCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value).replace(/\.0$/, '');
    return String(value).trim();
  }

  function numberCell(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined || value === '') return 0;
    let text = String(value).trim();
    if (!text || /^[-—–]$/.test(text)) return 0;
    let negative = false;
    if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
    text = text.replace(/[,，\s　$＄]/g, '');
    const number = Number(text);
    if (!Number.isFinite(number)) return 0;
    return negative ? -number : number;
  }

  function percentCell(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return Math.abs(value) <= 1.5 ? value : value / 100;
    }
    const text = String(value).trim().replace(/[,，\s　]/g, '');
    if (!text) return null;
    const hasPercent = /[%％]$/.test(text);
    const number = Number(text.replace(/[%％]/g, ''));
    if (!Number.isFinite(number)) return null;
    return hasPercent || Math.abs(number) > 1.5 ? number / 100 : number;
  }

  function isNumericLike(value) {
    if (typeof value === 'number') return Number.isFinite(value);
    const text = String(value ?? '').trim();
    if (!text || /^[-—–]$/.test(text)) return true;
    return /^\(?[-+]?[$＄]?[\d,，.\s　]+\)?$/.test(text);
  }

  function safeDivide(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }

  function growth(current, prior) {
    if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
    return (current - prior) / Math.abs(prior);
  }

  function difference(current, prior) {
    if (current === null || prior === null || !Number.isFinite(current) || !Number.isFinite(prior)) return null;
    return current - prior;
  }

  function toPercentPoint(value) {
    return value === null || value === undefined ? null : value * 100;
  }

  function issue(code, severity, rowNumber, vendorName, message) {
    return { code, severity, rowNumber, vendorName, message };
  }

  function baseLabel(field) {
    return ({ grp: 'Grp', sec: 'Sec', sup: 'Sup', vendorName: 'Vendorname' })[field];
  }

  function normalizeName(value) {
    return String(value || '').replace(/[\s　]+/g, '').toUpperCase();
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString('zh-TW');
  }

  function formatMoneyCompact(value) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 億`;
    if (abs >= 1e4) return `${(value / 1e4).toFixed(1)} 萬`;
    return Math.round(value).toLocaleString('zh-TW');
  }

  function compactNumber(value) {
    const number = Number(value);
    const abs = Math.abs(number);
    if (abs >= 1e8) return `${(number / 1e8).toFixed(1)}億`;
    if (abs >= 1e4) return `${(number / 1e4).toFixed(0)}萬`;
    return number.toLocaleString('zh-TW');
  }

  function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
  }

  function formatPercentagePoints(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(1)} 個百分點`;
  }

  function growthLabel(current, prior, prefix) {
    const value = growth(current, prior);
    if (value === null) return prior === 0 && current !== 0 ? `${prefix}：前期為 0` : `${prefix}：—`;
    return `${prefix} ${value >= 0 ? '▲' : '▼'} ${formatPercent(Math.abs(value))}`;
  }

  function percentagePointLabel(current, prior) {
    const value = difference(current, prior);
    if (value === null) return '較去年同期：—';
    return `較去年同期 ${value >= 0 ? '▲' : '▼'} ${formatPercentagePoints(Math.abs(value))}`;
  }

  function formatInteger(value) {
    return Number(value || 0).toLocaleString('zh-TW');
  }

  function formatMonth(value) {
    if (!value) return '—';
    const [year, month] = value.split('-');
    return `${year} 年 ${Number(month)} 月`;
  }

  function formatShortMonth(value) {
    if (!value) return '';
    const [, month] = value.split('-');
    return `${Number(month)}月`;
  }

  function shortVendorName(value, max = 16) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function severityLabel(severity) {
    return ({ critical: '重大', high: '高', medium: '中', low: '低' })[severity] || '—';
  }

  function communicationSeverityLabel(severity) {
    return ({ critical: '優先釐清', high: '建議釐清', medium: '留意', low: '一般提醒' })[severity] || '—';
  }

  function severityColor(severity, alpha = 1) {
    const colors = {
      critical: [155, 28, 28], high: [211, 76, 76], medium: [215, 155, 30], low: [75, 134, 198], none: [82, 126, 161],
    };
    const [r, g, b] = colors[severity] || colors.none;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function fillSelect(select, values, allLabel, selected) {
    select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + values.map(value =>
      `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
    ).join('');
    select.value = selected || '';
  }

  function fillObjectSelect(select, options, allLabel, selected) {
    select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + options.map(option =>
      `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    ).join('');
    select.value = selected || '';
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values)).sort((a, b) => String(a).localeCompare(String(b), 'zh-TW', { numeric: true }));
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function setMessage(message, type = 'info') {
    const box = el('supplierMessage');
    if (!box) return;
    box.textContent = message;
    box.className = `supplier-message supplier-message-${type}`;
    box.classList.remove('hidden');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadBlob(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function mulberry32(seed) {
    return function random() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  return { init, clearAll, loadDemoData };
})();
