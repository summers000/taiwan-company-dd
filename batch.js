/**
 * batch.js — 批次比對模組 v3
 * - 固定欄位：統一編號、公司名稱、登記地址、代表人、國家
 * - 查無資料時自動轉查台灣公司網 (twincn.com)
 * - 內部重複性分析
 * - 匯出 Excel (XLSX)
 */

const Batch = (() => {

  let batchRows    = [];
  let batchResults = [];
  let dupAnalysis  = [];

  const COL = {
    tax:     '統一編號',
    name:    '公司名稱',
    address: '登記地址',
    person:  '代表人',
    country: '國家',
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
    if (rows.length < 2) { showBatchError('檔案內容不足。'); return; }

    const headers = rows[0].map(h => String(h).trim());
    if (!headers.includes(COL.tax) && !headers.includes(COL.name)) {
      showBatchError(`找不到「${COL.tax}」或「${COL.name}」欄位，請確認欄位名稱完全相符。`);
      return;
    }

    const idx = {};
    Object.entries(COL).forEach(([k, v]) => { idx[k] = headers.indexOf(v); });

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

  function buildDetectedStr(idx, headers) {
    return Object.entries(COL)
      .filter(([k]) => idx[k] >= 0)
      .map(([k, v]) => `${v}（第${idx[k]+1}欄）`)
      .join('、') || '無';
  }

  // ── 查詢台灣公司網 (twincn.com) ──
  async function queryTwincn(taxNo, name) {
    // 透過 CF Worker 抓 twincn.com 頁面
    const query = taxNo || encodeURIComponent(name);
    const targetUrl = `https://twincn.com/item.aspx?no=${query}`;
    const proxyUrl  = `${CF_WORKER}?url=${encodeURIComponent(targetUrl)}`;

    try {
      const res  = await fetch(proxyUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
      if (!res.ok) return null;
      const html = await res.text();

      // 簡易解析：抓公司名稱、狀態、負責人
      const getName    = m => { const r = html.match(m); return r ? r[1].trim() : ''; };
      const compName   = getName(/<h1[^>]*>([^<]+)<\/h1>/i) ||
                         getName(/公司名稱[^>]*>([^<]+)</i);
      const status     = getName(/營業狀況[^>]*>[^>]*>([^<]+)</i) ||
                         getName(/公司狀態[^>]*>([^<]+)</i);
      const responsible= getName(/代表人[^>]*>[^>]*>([^<]+)</i) ||
                         getName(/負責人[^>]*>[^>]*>([^<]+)</i);
      const taxResult  = getName(/統一編號[^>]*>[^>]*>([^<]+)</i) ||
                         getName(/\b(\d{8})\b/);

      if (!compName && !taxResult) return null;

      return {
        source:      'twincn.com',
        company_name: compName,
        tax_no:       taxResult || taxNo,
        status:       status    || '未知',
        responsible:  responsible || '',
      };
    } catch (e) {
      return null;
    }
  }

  // ── 批次查詢 ──
  async function runBatch() {
    if (batchRows.length === 0) return;
    document.getElementById('batchRunBtn').disabled = true;
    document.getElementById('batchExportBtn').style.display = 'none';
    batchResults = [];

    const total   = batchRows.length;
    const fillEl  = document.getElementById('batchProgressFill');
    const statusEl = document.getElementById('batchStatus');
    document.getElementById('batchProgressBar').style.display = 'block';

    for (let i = 0; i < batchRows.length; i++) {
      fillEl.style.width = Math.round((i / total) * 100) + '%';
      statusEl.textContent = `查詢中 ${i+1} / ${total}…`;

      const result = await queryRow(batchRows[i]);
      batchResults.push(result);
      renderResultTable(batchResults);
      await new Promise(r => setTimeout(r, 400));
    }

    fillEl.style.width = '100%';
    const found  = batchResults.filter(r => r.found).length;
    const warn   = batchResults.filter(r => r.risk_flags.some(f => f.startsWith('⚠'))).length;
    const twincn = batchResults.filter(r => r.source === 'twincn.com').length;
    statusEl.textContent =
      `完成！${total} 筆　✓ 找到 ${found} 筆（含台灣公司網 ${twincn} 筆）　⚠ 風險 ${warn} 筆　✗ 查無 ${total-found} 筆`;

    document.getElementById('batchRunBtn').disabled = false;
    document.getElementById('batchExportBtn').style.display = 'inline-flex';
    document.getElementById('batchResultSection').style.display = 'block';
  }

  async function queryRow(row) {
    const base = {
      _rowNum:       row._rowNum,
      input_tax:     row._tax,
      input_name:    row._name,
      input_person:  row._person,
      found:         false,
      source:        '',
      company_name:  '',
      tax_no:        '',
      status:        '',
      responsible:   '',
      risk_flags:    [],
    };

    try {
      let company = null;

      // 1. 統編精確查（經濟部）
      if (row._tax && row._tax.length === 8) {
        company = await GCISApi.fetchCompanyByTaxNo(row._tax);
        if (company) base.source = '經濟部商工';
      }

      // 2. 公司名稱查（經濟部）
      if (!company && row._name) {
        const results = await GCISApi.searchCompanyAll(row._name, 3);
        if (results.length > 0) { company = results[0]; base.source = '經濟部商工'; }
      }

      // 3. 查無資料 → 改查台灣公司網
      if (!company) {
        const tw = await queryTwincn(row._tax, row._name);
        if (tw) {
          base.found        = true;
          base.source       = 'twincn.com';
          base.company_name = tw.company_name;
          base.tax_no       = tw.tax_no;
          base.status       = tw.status;
          base.responsible  = tw.responsible;
          base.risk_flags   = ['ℹ 資料來自台灣公司網（非官方）'];
          return base;
        }
        base.risk_flags = ['✗ 查無資料'];
        return base;
      }

      base.found        = true;
      base.company_name = company.Company_Name || '';
      base.tax_no       = company.Business_Accounting_NO || '';
      base.status       = GCISApi.getStatusLabel(company.Company_Status || '');
      base.responsible  = company.Responsible_Name || '';

      // ── 風險旗標 ──
      const flags = [];
      if (company.Company_Status && company.Company_Status !== '01')
        flags.push('⚠ 非核准設立（' + base.status + '）');
      if (row._tax && row._tax.length === 8 && base.tax_no && row._tax !== base.tax_no)
        flags.push('⚠ 統編不符');
      if (row._name && base.company_name && row._name !== base.company_name)
        flags.push('ℹ 名稱不完全相符');
      if (row._person && base.responsible && row._person !== base.responsible)
        flags.push(`⚠ 代表人不符（登記：${base.responsible}）`);
      base.risk_flags = flags;
      return base;

    } catch (err) {
      base.risk_flags = [`查詢失敗：${err.message}`];
      return base;
    }
  }

  // ── 結果表格 ──
  function renderResultTable(results) {
    const tbody = document.getElementById('batchResultBody');
    tbody.innerHTML = results.map(r => {
      const hasWarn  = r.risk_flags.some(f => f.startsWith('⚠'));
      const notFound = !r.found;
      const nameColor = notFound ? '#e05555' : hasWarn ? '#e8c84a' : '#4ecb7a';
      const srcBadge  = r.source === 'twincn.com'
        ? '<span class="risk-flag risk-info" style="background:rgba(160,124,245,0.15);color:#c09cf8;border-color:rgba(160,124,245,0.3)">台灣公司網</span>'
        : r.source === '經濟部商工'
        ? '<span class="risk-ok" style="font-size:11px">經濟部</span>' : '';

      const flags = r.risk_flags.length > 0
        ? r.risk_flags.map(f => {
            const cls = f.startsWith('⚠') ? 'risk-flag' : f.startsWith('ℹ') ? 'risk-flag risk-info' : 'risk-flag risk-err';
            return `<span class="${cls}">${escapeHtml(f)}</span>`;
          }).join(' ')
        : '<span class="risk-ok">✓ 正常</span>';

      return `<tr>
        <td class="mono">${r._rowNum}</td>
        <td class="mono">${escapeHtml(r.input_tax)}</td>
        <td>${escapeHtml(r.input_name)}</td>
        <td style="color:${nameColor};font-weight:600">${escapeHtml(r.company_name || (r.found?'':'查無資料'))}</td>
        <td class="mono">${escapeHtml(r.tax_no)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.responsible)}</td>
        <td>${flags}</td>
        <td>${srcBadge}</td>
      </tr>`;
    }).join('');
    document.getElementById('batchResultSection').style.display = 'block';
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

    // 2. 公司名稱重複
    const nameMap = {};
    batchRows.forEach(r => {
      if (!r._name) return;
      if (!nameMap[r._name]) nameMap[r._name] = [];
      nameMap[r._name].push(r._rowNum);
    });
    Object.entries(nameMap).forEach(([name, rows]) => {
      if (rows.length > 1)
        dupAnalysis.push({ type: '公司名稱重複', value: name, rows: rows.join(', '), count: rows.length });
    });

    // 3. 代表人重複（同一人擔任多家供應商代表）
    const personMap = {};
    batchRows.forEach(r => {
      if (!r._person) return;
      if (!personMap[r._person]) personMap[r._person] = [];
      personMap[r._person].push({ row: r._rowNum, name: r._name || r._tax });
    });
    Object.entries(personMap).forEach(([person, entries]) => {
      if (entries.length > 1)
        dupAnalysis.push({
          type:  '代表人重複（同人多家）',
          value: person,
          rows:  entries.map(e => `第${e.row}列(${e.name})`).join(', '),
          count: entries.length,
        });
    });

    // 4. 地址重複（同地址多家供應商）
    const addrMap = {};
    batchRows.forEach(r => {
      if (!r._address || r._address.length < 5) return;
      if (!addrMap[r._address]) addrMap[r._address] = [];
      addrMap[r._address].push({ row: r._rowNum, name: r._name || r._tax });
    });
    Object.entries(addrMap).forEach(([addr, entries]) => {
      if (entries.length > 1)
        dupAnalysis.push({
          type:  '地址重複（同址多家）',
          value: addr,
          rows:  entries.map(e => `第${e.row}列(${e.name})`).join(', '),
          count: entries.length,
        });
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
      const headers = ['列號','輸入統編','輸入公司名','查詢公司名','統一編號','公司狀態','負責人','風險標註','資料來源'];
      const data = batchResults.map(r => [
        r._rowNum, r.input_tax, r.input_name,
        r.company_name, r.tax_no, r.status, r.responsible,
        r.risk_flags.join(' | '), r.source,
      ]);
      const ws1 = XLSX.utils.aoa_to_sheet([headers, ...data]);
      // 設定欄寬
      ws1['!cols'] = [8,14,30,30,14,12,12,40,14].map(w => ({ wch: w }));
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

    // 下載
    XLSX.writeFile(wb, `DD比對結果_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  function clearBatch() {
    batchRows = []; batchResults = []; dupAnalysis = [];
    ['batchPreviewSection','batchResultSection','dupSection'].forEach(id =>
      document.getElementById(id).style.display = 'none');
    document.getElementById('batchProgressBar').style.display = 'none';
    document.getElementById('batchProgressFill').style.width  = '0%';
    document.getElementById('batchStatus').textContent    = '';
    document.getElementById('batchFileName').textContent  = '';
    document.getElementById('batchFileInput').value       = '';
    document.getElementById('batchRunBtn').disabled       = true;
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
