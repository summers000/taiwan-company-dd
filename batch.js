/**
 * batch.js — 批次比對模組 v4（快取與有限並行）
 * - 固定欄位：統一編號、公司名稱、登記地址、代表人、國家
 * - 查無資料時自動轉查台灣公司網 (twincn.com)
 * - 內部重複性分析
 * - 匯出 Excel (XLSX)
 */

const Batch = (() => {

  let batchRows    = [];
  let batchResults = [];
  let dupAnalysis  = [];
  let lastBatchRunAt = '';

  const BATCH_CONCURRENCY = 3;
  const taxLookupCache = new Map();
  const nameLookupCache = new Map();
  const twincnLookupCache = new Map();
  let activeBatchController = null;
  let batchRunSequence = 0;
  let cacheHits = { tax: 0, name: 0, twincn: 0 };

  function resetLookupCaches() {
    taxLookupCache.clear();
    nameLookupCache.clear();
    twincnLookupCache.clear();
    cacheHits = { tax: 0, name: 0, twincn: 0 };
  }

  function cancelBatchRun() {
    activeBatchController?.abort();
    activeBatchController = null;
    batchRunSequence++;
  }

  function cachedLookup(cache, key, loader, hitType) {
    if (!key) return loader();
    if (cache.has(key)) {
      cacheHits[hitType]++;
      return cache.get(key);
    }
    const promise = Promise.resolve().then(loader).catch(err => {
      // 失敗結果不留在快取，避免暫時性錯誤影響後續重試。
      cache.delete(key);
      throw err;
    });
    cache.set(key, promise);
    return promise;
  }

  const FIELD_DEFS = {
    tax: {
      label: '統一編號',
      aliases: ['統一編號', '統編', '公司統編', '公司統一編號', 'BAN'],
    },
    name: {
      label: '公司名稱',
      aliases: ['公司名稱', '廠商名稱', '供應商名稱', '企業名稱'],
    },
    address: {
      label: '登記地址',
      aliases: ['登記地址', '公司地址', '地址', '營業地址'],
    },
    person: {
      label: '代表人',
      aliases: ['代表人', '負責人', '負責人姓名', '公司負責人'],
    },
    country: {
      label: '國家',
      aliases: ['國家', '國別', '國家代碼', 'Country'],
    },
  };

  const CF_WORKER = 'https://gcis-proxy.summers0309.workers.dev';

  // ── Init ──
  function init() {
    document.getElementById('batchFileInput').addEventListener('change', onFileChange);
    document.getElementById('batchRunBtn').addEventListener('click', runBatch);
    document.getElementById('batchExportBtn').addEventListener('click', exportExcel);
    document.getElementById('batchClearBtn').addEventListener('click', clearBatch);
    document.getElementById('dupAnalysisBtn').addEventListener('click', runDupAnalysis);

    const dz = document.getElementById('batchDropZone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('dragover');
      const f = e.dataTransfer.files[0]; if (f) handleFile(f);
    });
  }

  // ── 檔案處理 ──
  function onFileChange(e) { const f = e.target.files[0]; if (f) handleFile(f); }

  function handleFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      readCSV(file);
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      if (typeof XLSX !== 'undefined') readExcel(file);
      else showBatchError('請將 Excel 另存為「CSV UTF-8」格式後再上傳');
    } else {
      showBatchError('請上傳 CSV 或 Excel 檔案');
    }
  }

  function readCSV(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      if (text.includes('\ufffd')) {
        const r2 = new FileReader();
        r2.onload = e2 => onDataParsed(parseCSV(e2.target.result), file.name);
        r2.readAsText(file, 'Big5');
      } else {
        onDataParsed(parseCSV(text), file.name);
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  function readExcel(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        onDataParsed(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }), file.name);
      } catch (err) { showBatchError('Excel 解析失敗，請另存為 CSV 後再試。'); }
    };
    reader.readAsArrayBuffer(file);
  }

  function parseCSV(text) {
    return text.split(/\r?\n/).map(line => {
      const cells = []; let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
        else { cur += c; }
      }
      cells.push(cur.trim());
      return cells;
    }).filter(r => r.some(c => c !== ''));
  }

  // ── 解析欄位 ──
  function onDataParsed(rows, fileName) {
    cancelBatchRun();
    resetLookupCaches();
    if (rows.length < 2) { showBatchError('檔案內容不足。'); return; }

    const headers = rows[0].map(h => String(h).trim());
    const idx = detectColumns(headers);
    if (idx.tax < 0 && idx.name < 0) {
      showBatchError('找不到統一編號或公司名稱欄位。可接受「統編、公司統編、廠商名稱、供應商名稱」等常用欄位名稱。');
      return;
    }

    const allRows = rows.slice(1).map((row, i) => ({
      _rowNum:  i + 2,
      _tax:     idx.tax     >= 0 ? padTax(String(row[idx.tax]     || '').trim()) : '',
      _name:    idx.name    >= 0 ? String(row[idx.name]    || '').trim() : '',
      _address: idx.address >= 0 ? String(row[idx.address] || '').trim() : '',
      _person:  idx.person  >= 0 ? String(row[idx.person]  || '').trim() : '',
      _country: idx.country >= 0 ? String(row[idx.country] || '').trim().toUpperCase() : 'TW',
    }));

    const twRows    = allRows.filter(r => ['TW','台灣','TAIWAN',''].includes(r._country));
    const skipCount = allRows.length - twRows.length;
    batchRows = twRows.filter(r => r._tax || r._name);

    if (batchRows.length === 0) { showBatchError('沒有找到台灣廠商資料。'); return; }

    document.getElementById('batchFileName').textContent  = fileName;
    document.getElementById('batchRowCount').textContent  = `${batchRows.length} 筆（略過 ${skipCount} 筆非台灣廠商）`;
    document.getElementById('batchDetected').textContent  = buildDetectedStr(idx, headers);
    document.getElementById('batchPreviewSection').style.display = 'block';
    document.getElementById('batchResultSection').style.display  = 'none';
    document.getElementById('dupSection').style.display          = 'none';
    document.getElementById('batchRunBtn').disabled    = false;
    document.getElementById('dupAnalysisBtn').disabled = false;
    document.getElementById('batchStatus').textContent = '';
    document.getElementById('batchProgressFill').style.width = '0%';
    document.getElementById('batchProgressBar').style.display = 'none';
    batchResults = []; dupAnalysis = [];
  }

  function padTax(val) {
    const digits = val.replace(/\D/g, '');
    if (digits.length === 7) return '0' + digits;
    if (digits.length === 8) return digits;
    return val;
  }

  function normalizeHeader(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\s\u3000_\-]/g, '')
      .replace(/[（）()]/g, '')
      .toLowerCase();
  }

  function detectColumns(headers) {
    const normalizedHeaders = headers.map(normalizeHeader);
    const idx = {};
    Object.entries(FIELD_DEFS).forEach(([key, def]) => {
      const aliases = def.aliases.map(normalizeHeader);
      idx[key] = normalizedHeaders.findIndex(header => aliases.includes(header));
    });
    return idx;
  }

  function buildDetectedStr(idx, headers) {
    return Object.entries(FIELD_DEFS)
      .filter(([key]) => idx[key] >= 0)
      .map(([key, def]) => `${def.label}←${headers[idx[key]]}（第${idx[key] + 1}欄）`)
      .join('、') || '無';
  }

  // ── 查詢台灣公司網 (twincn.com) ──
  async function queryTwincn(taxNo, name, signal) {
    const cacheKey = taxNo || `name:${GCISApi.normalizeCompanyName(name)}`;
    return cachedLookup(twincnLookupCache, cacheKey, async () => {
      const query = taxNo || encodeURIComponent(name);
      const targetUrl = `https://twincn.com/item.aspx?no=${query}`;
      const proxyUrl = `${CF_WORKER}?url=${encodeURIComponent(targetUrl)}`;

      const controller = new AbortController();
      let timedOut = false;
      const abortFromRun = () => controller.abort();
      if (signal?.aborted) throw new GCISApi.GCISError('ABORTED', '批次查詢已取消。');
      signal?.addEventListener('abort', abortFromRun, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 12000);

      try {
        const res = await fetch(proxyUrl, { signal: controller.signal });
        if (!res.ok) {
          return { status: 'error', data: null, error: `台灣公司網查詢失敗（HTTP ${res.status}）` };
        }
        const html = await res.text();
        const getName = pattern => {
          const match = html.match(pattern);
          return match ? match[1].trim() : '';
        };
        const companyName = getName(/<h1[^>]*>([^<]+)<\/h1>/i) ||
          getName(/公司名稱[^>]*>([^<]+)</i);
        const status = getName(/營業狀況[^>]*>[^>]*>([^<]+)</i) ||
          getName(/公司狀態[^>]*>([^<]+)</i);
        const responsible = getName(/代表人[^>]*>[^>]*>([^<]+)</i) ||
          getName(/負責人[^>]*>[^>]*>([^<]+)</i);
        const taxResult = getName(/統一編號[^>]*>[^>]*>([^<]+)</i) ||
          getName(/\b(\d{8})\b/);

        if (!companyName && !taxResult) return { status: 'not_found', data: null, error: '' };
        return {
          status: 'found',
          data: {
            source: 'twincn.com',
            company_name: companyName,
            tax_no: taxResult || taxNo,
            status: status || '未知',
            responsible: responsible || '',
          },
          error: '',
        };
      } catch (err) {
        if (signal?.aborted && !timedOut) {
          throw new GCISApi.GCISError('ABORTED', '批次查詢已取消。');
        }
        const message = err?.name === 'AbortError' ? '台灣公司網查詢逾時' : `台灣公司網查詢失敗：${err.message}`;
        return { status: 'error', data: null, error: message };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromRun);
      }
    }, 'twincn');
  }

  // ── 批次查詢 ──
  async function runBatch() {
    if (batchRows.length === 0) return;

    cancelBatchRun();
    resetLookupCaches();
    const runId = batchRunSequence;
    const controller = new AbortController();
    activeBatchController = controller;

    const runBtn = document.getElementById('batchRunBtn');
    const exportBtn = document.getElementById('batchExportBtn');
    const fillEl = document.getElementById('batchProgressFill');
    const statusEl = document.getElementById('batchStatus');
    const total = batchRows.length;
    lastBatchRunAt = new Date().toISOString();

    runBtn.disabled = true;
    runBtn.textContent = '比對中...';
    exportBtn.style.display = 'inline-flex';
    exportBtn.disabled = true;
    document.getElementById('batchProgressBar').style.display = 'block';
    document.getElementById('batchResultSection').style.display = 'block';

    batchResults = new Array(total);
    prepareResultTable(batchRows);

    let cursor = 0;
    let completed = 0;
    const workerCount = Math.min(BATCH_CONCURRENCY, total);

    const updateProgress = () => {
      const percent = Math.round((completed / total) * 100);
      fillEl.style.width = `${percent}%`;
      statusEl.textContent = `查詢中 ${completed} / ${total}（同時最多 ${workerCount} 筆）…`;
    };
    updateProgress();

    async function worker() {
      while (true) {
        if (controller.signal.aborted || runId !== batchRunSequence) return;
        const index = cursor++;
        if (index >= total) return;

        try {
          const result = await queryRow(batchRows[index], controller.signal);
          if (controller.signal.aborted || runId !== batchRunSequence) return;
          result.queried_at = new Date().toISOString();
          batchResults[index] = result;
          renderResultRow(result, index);
          completed++;
          updateProgress();
        } catch (err) {
          if (err?.code === 'ABORTED' || controller.signal.aborted) return;
          const fallback = createBaseResult(batchRows[index]);
          fallback.lookup_status = 'error';
          fallback.queried_at = new Date().toISOString();
          fallback.risk_flags = [`✕ 批次處理失敗：${err.message}`];
          batchResults[index] = fallback;
          renderResultRow(fallback, index);
          completed++;
          updateProgress();
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (controller.signal.aborted || runId !== batchRunSequence) return;

    batchResults = batchResults.filter(Boolean);
    fillEl.style.width = '100%';
    const found = batchResults.filter(r => r.lookup_status === 'found').length;
    const ambiguous = batchResults.filter(r => r.lookup_status === 'ambiguous').length;
    const notFound = batchResults.filter(r => r.lookup_status === 'not_found').length;
    const errors = batchResults.filter(r => r.lookup_status === 'error').length;
    const warn = batchResults.filter(r => r.risk_flags.some(f => f.startsWith('⚠'))).length;
    const twincn = batchResults.filter(r => r.source === 'twincn.com').length;
    const totalCacheHits = cacheHits.tax + cacheHits.name + cacheHits.twincn;
    const highRisk = batchResults.filter(r => ['high', 'critical'].includes(r.risk_level_key)).length;

    statusEl.textContent =
      `完成！${total} 筆　✓ 確認 ${found} 筆（台灣公司網 ${twincn}）　⚠ 高風險以上 ${highRisk} 筆　風險標註 ${warn} 筆　? 待確認 ${ambiguous} 筆　✗ 查無 ${notFound} 筆　! 查詢失敗 ${errors} 筆　｜快取命中 ${totalCacheHits} 次`;

    activeBatchController = null;
    runBtn.disabled = false;
    runBtn.textContent = '▶ 重新比對';
    exportBtn.disabled = false;
  }

  function createBaseResult(row) {
    return {
      _rowNum: row._rowNum,
      input_tax: row._tax,
      input_name: row._name,
      input_person: row._person,
      found: false,
      lookup_status: 'not_found',
      source: '',
      company_name: '',
      tax_no: '',
      status: '',
      responsible: '',
      match_score: null,
      risk_score: null,
      risk_level: '',
      risk_level_key: '',
      queried_at: '',
      risk_flags: [],
    };
  }

  async function queryRow(row, signal) {
    const base = createBaseResult(row);

    try {
      let company = null;
      let nameMatch = null;

      // 1. 統編精確查：官方 API 失敗時直接標示 error，不得當成查無。
      if (row._tax && row._tax.length === 8) {
        company = await cachedLookup(
          taxLookupCache,
          row._tax,
          () => GCISApi.fetchCompanyByTaxNo(row._tax, { signal }),
          'tax'
        );
        if (company) base.source = '經濟部商工';
      }

      // 2. 統編查無或未提供統編時，再以公司名稱查詢所有公司狀態。
      if (!company && row._name) {
        const nameKey = GCISApi.normalizeCompanyName(row._name);
        const candidates = await cachedLookup(
          nameLookupCache,
          nameKey,
          () => GCISApi.searchCompanyAll(row._name, 20, { signal }),
          'name'
        );
        if (candidates.length > 0) {
          nameMatch = GCISApi.matchCompanyName(row._name, candidates, row._person);
          if (nameMatch.status === 'matched') {
            company = nameMatch.company;
            base.source = '經濟部商工';
            base.match_score = nameMatch.score;
          } else {
            const top = nameMatch.ranked?.[0];
            base.lookup_status = 'ambiguous';
            base.source = '經濟部商工';
            base.company_name = top?.company?.Company_Name || '';
            base.tax_no = top?.company?.Business_Accounting_NO || '';
            base.status = top?.company ? GCISApi.getStatusLabel(top.company.Company_Status || '') : '';
            base.responsible = top?.company?.Responsible_Name || '';
            base.match_score = top?.score ?? null;
            base.risk_flags = [
              `⚠ 公司名稱有候選結果，但不足以自動確認${top ? `（最高相似度 ${top.score}）` : ''}`,
              'ℹ 請人工確認候選公司，不會直接取第一筆資料',
            ];
            return base;
          }
        }
      }

      // 3. 官方確定查無後，才使用非官方來源補充；官方查詢失敗不會進入此步驟。
      if (!company) {
        const twResult = await queryTwincn(row._tax, row._name, signal);
        if (twResult.status === 'found') {
          const tw = twResult.data;
          base.found = true;
          base.lookup_status = 'found';
          base.source = 'twincn.com';
          base.company_name = tw.company_name;
          base.tax_no = tw.tax_no;
          base.status = tw.status;
          base.responsible = tw.responsible;
          base.risk_flags = ['ℹ 資料來自台灣公司網（非官方），請再以官方資料確認'];
          return base;
        }
        if (twResult.status === 'error') {
          base.lookup_status = 'error';
          base.risk_flags = [`✕ 官方查無資料，且非官方補充來源失敗：${twResult.error}`];
          return base;
        }
        base.lookup_status = 'not_found';
        base.risk_flags = ['✗ 官方及補充來源皆查無資料'];
        return base;
      }

      base.found = true;
      base.lookup_status = 'found';
      base.company_name = company.Company_Name || '';
      base.tax_no = company.Business_Accounting_NO || '';
      base.status = GCISApi.getStatusLabel(company.Company_Status || '');
      base.responsible = company.Responsible_Name || '';
      const automaticRisk = DDCore.automaticAssessment(company, {
        warnings: company._apiWarnings || [],
      });
      base.risk_score = automaticRisk.score;
      base.risk_level = automaticRisk.level.label;
      base.risk_level_key = automaticRisk.level.key;

      const flags = [];
      if (company.Company_Status && company.Company_Status !== '01') {
        flags.push(`⚠ 非核准設立（${base.status}）`);
      }
      if (row._tax && row._tax.length === 8 && base.tax_no && row._tax !== base.tax_no) {
        flags.push(`⚠ 輸入統編與名稱配對結果不符（登記統編：${base.tax_no}）`);
      }
      if (row._name && base.company_name &&
          GCISApi.normalizeCompanyName(row._name) !== GCISApi.normalizeCompanyName(base.company_name)) {
        flags.push(`ℹ 名稱未完全相同${nameMatch?.score ? `（配對分數 ${nameMatch.score}）` : ''}`);
      }
      if (row._person && base.responsible &&
          GCISApi.normalizePersonName(row._person) !== GCISApi.normalizePersonName(base.responsible)) {
        flags.push(`⚠ 代表人不符（登記：${base.responsible}）`);
      }
      if (company._apiWarnings?.length) {
        flags.push('ℹ 部分官方基本資料來源暫時無法取得');
      }
      base.risk_flags = flags;
      return base;
    } catch (err) {
      if (err?.code === 'ABORTED' || signal?.aborted) throw err;
      base.lookup_status = 'error';
      base.found = false;
      base.risk_flags = [`✕ 官方資料查詢失敗：${err.message}`];
      return base;
    }
  }

  // ── 結果表格 ──
  function prepareResultTable(rows) {
    const tbody = document.getElementById('batchResultBody');
    tbody.innerHTML = rows.map((row, index) => `
      <tr id="batch-result-row-${index}" class="batch-row-pending">
        <td class="mono">${row._rowNum}</td>
        <td class="mono">${escapeHtml(row._tax)}</td>
        <td>${escapeHtml(row._name)}</td>
        <td colspan="7" style="color:var(--text-3)">等待查詢…</td>
      </tr>`).join('');
  }

  function buildResultCells(r) {
    const hasWarn = r.risk_flags.some(f => f.startsWith('⚠'));
    const isError = r.lookup_status === 'error';
    const isAmbiguous = r.lookup_status === 'ambiguous';
    const isNotFound = r.lookup_status === 'not_found';
    const nameColor = isError || isNotFound ? '#e05555' : (isAmbiguous || hasWarn) ? '#e8c84a' : '#4ecb7a';
    const fallbackLabel = isError ? '查詢失敗' : isAmbiguous ? '需人工確認' : isNotFound ? '查無資料' : '';
    const srcBadge = r.source === 'twincn.com'
      ? '<span class="risk-flag risk-info" style="background:rgba(160,124,245,0.15);color:#c09cf8;border-color:rgba(160,124,245,0.3)">台灣公司網</span>'
      : r.source === '經濟部商工'
      ? '<span class="risk-ok" style="font-size:11px">經濟部</span>' : '';

    const flags = r.risk_flags.length > 0
      ? r.risk_flags.map(flag => {
          const cls = flag.startsWith('⚠') ? 'risk-flag' : flag.startsWith('ℹ') ? 'risk-flag risk-info' : 'risk-flag risk-err';
          return `<span class="${cls}">${escapeHtml(flag)}</span>`;
        }).join(' ')
      : '<span class="risk-ok">✓ 正常</span>';

    const riskBadge = r.risk_score === null || r.risk_score === undefined
      ? '<span class="risk-score-badge risk-score-na">未評分</span>'
      : `<span class="risk-score-badge risk-score-${escapeHtml(r.risk_level_key || 'low')}"><strong>${r.risk_score}</strong> ${escapeHtml(r.risk_level || '')}</span>`;

    return `
      <td class="mono">${r._rowNum}</td>
      <td class="mono">${escapeHtml(r.input_tax)}</td>
      <td>${escapeHtml(r.input_name)}</td>
      <td style="color:${nameColor};font-weight:600">${escapeHtml(r.company_name || fallbackLabel)}</td>
      <td class="mono">${escapeHtml(r.tax_no)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.responsible)}</td>
      <td>${riskBadge}</td>
      <td>${flags}</td>
      <td>${srcBadge}</td>`;
  }

  function renderResultRow(result, index) {
    const row = document.getElementById(`batch-result-row-${index}`);
    if (!row) return;
    row.classList.remove('batch-row-pending');
    row.innerHTML = buildResultCells(result);
  }

  // ── 重複性分析 ──
  function runDupAnalysis() {
    if (batchRows.length === 0) return;
    dupAnalysis = [];

    // 1. 統編重複
    const taxMap = {};
    batchRows.forEach(r => {
      if (!r._tax) return;
      if (!taxMap[r._tax]) taxMap[r._tax] = [];
      taxMap[r._tax].push(r._rowNum);
    });
    Object.entries(taxMap).forEach(([tax, rows]) => {
      if (rows.length > 1)
        dupAnalysis.push({ type: '統編重複', value: tax, rows: rows.join(', '), count: rows.length });
    });

    // 2. 公司名稱重複（先做字形、空白與標點正規化）
    const nameMap = {};
    batchRows.forEach(r => {
      if (!r._name) return;
      const key = GCISApi.normalizeCompanyName(r._name);
      if (!key) return;
      if (!nameMap[key]) nameMap[key] = { display: r._name, rows: [] };
      nameMap[key].rows.push(r._rowNum);
    });
    Object.values(nameMap).forEach(entry => {
      if (entry.rows.length > 1) {
        dupAnalysis.push({
          type: '公司名稱重複',
          value: entry.display,
          rows: entry.rows.join(', '),
          count: entry.rows.length,
        });
      }
    });

    // 3. 代表人姓名重複：僅表示同名，不能直接認定為同一自然人。
    const personMap = {};
    batchRows.forEach(r => {
      if (!r._person) return;
      const key = GCISApi.normalizePersonName(r._person);
      if (!key) return;
      if (!personMap[key]) personMap[key] = { display: r._person, entries: [] };
      personMap[key].entries.push({ row: r._rowNum, name: r._name || r._tax });
    });
    Object.values(personMap).forEach(group => {
      if (group.entries.length > 1) {
        dupAnalysis.push({
          type: '代表人姓名重複（同名待確認）',
          value: group.display,
          rows: group.entries.map(e => `第${e.row}列(${e.name})`).join(', '),
          count: group.entries.length,
        });
      }
    });

    // 4. 地址重複：使用完整正規化地址，不截斷地址字串。
    const addrMap = {};
    batchRows.forEach(r => {
      if (!r._address || r._address.length < 5) return;
      const key = GCISApi.normalizeAddress(r._address);
      if (!key) return;
      if (!addrMap[key]) addrMap[key] = { display: r._address, entries: [] };
      addrMap[key].entries.push({ row: r._rowNum, name: r._name || r._tax });
    });
    Object.values(addrMap).forEach(group => {
      if (group.entries.length > 1) {
        dupAnalysis.push({
          type: '完整地址重複（同址多家）',
          value: group.display,
          rows: group.entries.map(e => `第${e.row}列(${e.name})`).join(', '),
          count: group.entries.length,
        });
      }
    });

    renderDupTable(dupAnalysis);
  }

  function renderDupTable(results) {
    const section = document.getElementById('dupSection');
    const tbody   = document.getElementById('dupResultBody');
    const count   = document.getElementById('dupCount');

    if (results.length === 0) {
      count.textContent = '未發現重複';
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--green);padding:24px">✓ 無重複資料</td></tr>';
    } else {
      count.textContent = `發現 ${results.length} 項`;
      tbody.innerHTML = results.map(r => {
        const typeColor = r.type.includes('統編') ? '#e8c84a'
          : r.type.includes('名稱') ? '#5b9cf6'
          : r.type.includes('代表人') ? '#ff9960'
          : '#4ecb7a';
        return `<tr>
          <td><span class="risk-flag" style="background:rgba(0,0,0,0.2);color:${typeColor};border-color:${typeColor}44">${escapeHtml(r.type)}</span></td>
          <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.value)}</td>
          <td class="mono" style="color:#e05555;font-weight:700">${r.count} 筆</td>
          <td style="font-size:12px;color:var(--text-2)">${escapeHtml(r.rows)}</td>
        </tr>`;
      }).join('');
    }
    section.style.display = 'block';
  }

  // ── 匯出 Excel ──
  function exportExcel() {
    if (batchResults.length === 0 && dupAnalysis.length === 0) return;

    // 建立 workbook
    const wb = XLSX.utils.book_new();

    // Sheet 1：比對結果
    if (batchResults.length > 0) {
      const headers = ['列號','輸入統編','輸入公司名','查詢公司名','統一編號','公司狀態','負責人','初步風險分數','風險等級','風險標註','資料來源','查詢時間'];
      const data = batchResults.map(r => [
        r._rowNum, r.input_tax, r.input_name,
        r.company_name, r.tax_no, r.status, r.responsible,
        r.risk_score ?? '', r.risk_level || '', r.risk_flags.join(' | '), r.source, r.queried_at || '',
      ]);
      const ws1 = XLSX.utils.aoa_to_sheet([headers, ...data]);
      // 設定欄寬
      ws1['!cols'] = [8,14,30,30,14,12,12,12,10,40,14,22].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws1, '比對結果');
    }

    // Sheet 2：重複分析
    if (dupAnalysis.length > 0) {
      const headers2 = ['重複類型','重複值','重複筆數','涉及列號'];
      const data2 = dupAnalysis.map(r => [r.type, r.value, r.count, r.rows]);
      const ws2 = XLSX.utils.aoa_to_sheet([headers2, ...data2]);
      ws2['!cols'] = [20, 35, 10, 60].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws2, '重複分析');
    }

    // Sheet 3：查核設定與資料時間，確保評分結果可回溯。
    const rules = DDCore.getRules();
    const metadata = [
      ['項目', '設定值'],
      ['批次開始時間', lastBatchRunAt || ''],
      ['匯出時間', new Date().toISOString()],
      ['同時查詢數', BATCH_CONCURRENCY],
      ['非核准設立加分', rules.inactiveStatus.enabled ? rules.inactiveStatus.weight : '未啟用'],
      ['未提供代表人加分', rules.missingResponsible.enabled ? rules.missingResponsible.weight : '未啟用'],
      ['低資本額加分', rules.lowCapital.enabled ? rules.lowCapital.weight : '未啟用'],
      ['低資本額門檻', rules.lowCapital.threshold],
      ['近期變更加分', rules.recentChange.enabled ? rules.recentChange.weight : '未啟用'],
      ['近期變更天數', rules.recentChange.days],
      ['資料不完整加分', rules.apiWarnings.enabled ? rules.apiWarnings.weight : '未啟用'],
      ['中風險門檻', rules.levels.moderate],
      ['高風險門檻', rules.levels.high],
      ['重大風險門檻', rules.levels.critical],
      ['評分說明', '初步風險分數僅供篩選與排序；非官方來源及未自動串接資料仍需人工覆核。'],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(metadata);
    ws3['!cols'] = [{ wch: 24 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws3, '查核設定');

    // 下載
    XLSX.writeFile(wb, `DD比對結果_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  function clearBatch() {
    cancelBatchRun();
    resetLookupCaches();
    batchRows = []; batchResults = []; dupAnalysis = []; lastBatchRunAt = '';
    ['batchPreviewSection','batchResultSection','dupSection'].forEach(id =>
      document.getElementById(id).style.display = 'none');
    document.getElementById('batchProgressBar').style.display = 'none';
    document.getElementById('batchProgressFill').style.width  = '0%';
    document.getElementById('batchStatus').textContent    = '';
    document.getElementById('batchFileName').textContent  = '';
    document.getElementById('batchFileInput').value       = '';
    document.getElementById('batchRunBtn').disabled       = true;
    document.getElementById('batchRunBtn').textContent      = '▶ 開始比對';
    document.getElementById('dupAnalysisBtn').disabled    = true;
    document.getElementById('batchExportBtn').style.display = 'none';
  }

  function showBatchError(msg) {
    document.getElementById('batchStatus').textContent = '⚠ ' + msg;
    document.getElementById('batchPreviewSection').style.display = 'block';
  }

  function escapeHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init };
})();
