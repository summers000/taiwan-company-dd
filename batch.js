/**
 * batch.js — 批次比對模組
 * 支援上傳 CSV / Excel，批次查詢並輸出結果
 */

const Batch = (() => {

  let batchRows = [];      // 解析後的原始資料列
  let batchResults = [];   // 查詢結果

  // ── 初始化 ──
  function init() {
    document.getElementById('batchFileInput').addEventListener('change', onFileChange);
    document.getElementById('batchRunBtn').addEventListener('click', runBatch);
    document.getElementById('batchExportBtn').addEventListener('click', exportCSV);
    document.getElementById('batchClearBtn').addEventListener('click', clearBatch);
    document.getElementById('batchDropZone').addEventListener('dragover', e => e.preventDefault());
    document.getElementById('batchDropZone').addEventListener('drop', onDrop);
  }

  // ── 檔案處理 ──
  function onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function onFileChange(e) {
    const file = e.target.files[0];
    if (file) handleFile(file);
  }

  function handleFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      readCSV(file);
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      // 嘗試用 SheetJS 解析，若未載入則提示另存 CSV
      if (typeof XLSX !== 'undefined') {
        readExcel(file);
      } else {
        showBatchError('請將 Excel 檔案另存為 CSV 格式後再上傳（檔案 → 另存新檔 → CSV UTF-8）');
      }
    } else {
      showBatchError('請上傳 CSV 或 Excel (.xlsx/.xls) 檔案');
    }
  }

  function readCSV(file) {
    const reader = new FileReader();
    reader.onload = e => {
      // 嘗試 UTF-8，若亂碼再試 Big5
      let text = e.target.result;
      const rows = parseCSV(text);
      onDataParsed(rows, file.name);
    };
    // 先試 UTF-8
    reader.onerror = () => {
      // 改試 Big5
      const r2 = new FileReader();
      r2.onload = e2 => { onDataParsed(parseCSV(e2.target.result), file.name); };
      r2.readAsText(file, 'Big5');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function readExcel(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        onDataParsed(rows, file.name);
      } catch (err) {
        showBatchError('Excel 解析失敗，請另存為 CSV 後再上傳。錯誤：' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function parseCSV(text) {
    return text.split(/\r?\n/).map(line => {
      // 簡易 CSV 解析（支援引號欄位）
      const cells = [];
      let cur = '', inQ = false;
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

  function onDataParsed(rows, fileName) {
    if (rows.length < 2) {
      showBatchError('檔案內容不足，至少需要標題列和一筆資料。');
      return;
    }

    const headers = rows[0].map(h => String(h).trim());
    const dataRows = rows.slice(1);

    // 自動偵測欄位
    const colMap = detectColumns(headers);

    batchRows = dataRows.map((row, i) => {
      const obj = { _rowNum: i + 2 };
      headers.forEach((h, j) => { obj[h] = String(row[j] || '').trim(); });
      // 標準化欄位
      obj._tax     = colMap.tax     !== -1 ? String(row[colMap.tax]     || '').trim().replace(/\D/g, '') : '';
      obj._name    = colMap.name    !== -1 ? String(row[colMap.name]    || '').trim() : '';
      obj._person  = colMap.person  !== -1 ? String(row[colMap.person]  || '').trim() : '';
      obj._address = colMap.address !== -1 ? String(row[colMap.address] || '').trim() : '';
      return obj;
    }).filter(r => r._tax || r._name || r._person);

    if (batchRows.length === 0) {
      showBatchError('找不到可查詢的資料（需要統一編號、公司名稱或負責人姓名）。');
      return;
    }

    // 顯示預覽
    showPreview(headers, colMap, fileName);
  }

  function detectColumns(headers) {
    const map = { tax: -1, name: -1, person: -1, address: -1 };
    const patterns = {
      tax:     /統.?編|統一編號|tax|business.*no|编号/i,
      name:    /公司名|公司名稱|company.*name|名稱|名称/i,
      person:  /負責人|代表人|responsible|person|姓名|人名/i,
      address: /地址|address|所在地/i,
    };
    headers.forEach((h, i) => {
      Object.entries(patterns).forEach(([key, re]) => {
        if (map[key] === -1 && re.test(h)) map[key] = i;
      });
    });
    return map;
  }

  // ── 預覽 ──
  function showPreview(headers, colMap, fileName) {
    const fieldLabels = {
      tax: '統一編號', name: '公司名稱', person: '負責人', address: '地址'
    };
    const detected = Object.entries(colMap)
      .filter(([, v]) => v !== -1)
      .map(([k, v]) => `${fieldLabels[k]}（${headers[v]}）`)
      .join('、');

    document.getElementById('batchFileName').textContent = fileName;
    document.getElementById('batchRowCount').textContent = `${batchRows.length} 筆`;
    document.getElementById('batchDetected').textContent = detected || '未偵測到可查欄位';
    document.getElementById('batchPreviewSection').style.display = 'block';
    document.getElementById('batchResultSection').style.display = 'none';
    document.getElementById('batchRunBtn').disabled = false;
    document.getElementById('batchStatus').textContent = '';
    batchResults = [];
  }

  // ── 批次查詢 ──
  async function runBatch() {
    if (batchRows.length === 0) return;

    document.getElementById('batchRunBtn').disabled = true;
    document.getElementById('batchExportBtn').style.display = 'none';
    batchResults = [];

    const total = batchRows.length;
    const progressBar = document.getElementById('batchProgressBar');
    const progressFill = document.getElementById('batchProgressFill');
    const statusEl = document.getElementById('batchStatus');
    progressBar.style.display = 'block';

    for (let i = 0; i < batchRows.length; i++) {
      const row = batchRows[i];
      const pct = Math.round((i / total) * 100);
      progressFill.style.width = pct + '%';
      statusEl.textContent = `查詢中 ${i + 1} / ${total}…`;

      const result = await queryRow(row);
      batchResults.push(result);

      // 即時更新表格
      renderResultTable(batchResults);

      // 每筆間隔 400ms 避免打爆 API
      await new Promise(r => setTimeout(r, 400));
    }

    progressFill.style.width = '100%';
    statusEl.textContent = `完成！共 ${total} 筆，符合 ${batchResults.filter(r => r.found).length} 筆`;
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
      match_type:    '',
      company_name:  '',
      tax_no:        '',
      status:        '',
      responsible:   '',
      location:      '',
      capital:       '',
      approved_date: '',
      risk_flags:    [],
    };

    try {
      let company = null;

      // 優先用統編查
      if (row._tax && row._tax.length === 8) {
        company = await GCISApi.fetchCompanyByTaxNo(row._tax);
        if (company) base.match_type = '統編精確比對';
      }

      // 若無統編或查無結果，用公司名稱查
      if (!company && row._name) {
        const results = await GCISApi.searchCompanyAll(row._name, 5);
        if (results.length > 0) {
          company = results[0];
          base.match_type = results[0].Company_Name === row._name ? '名稱完全符合' : '名稱模糊比對';
        }
      }

      if (!company) {
        base.found = false;
        base.risk_flags = ['查無資料'];
        return base;
      }

      base.found         = true;
      base.company_name  = company.Company_Name  || '';
      base.tax_no        = company.Business_Accounting_NO || '';
      base.status        = GCISApi.getStatusLabel(company.Company_Status || '');
      base.responsible   = company.Responsible_Name || '';
      base.location      = company.Company_Location || '';
      base.capital       = company.Capital_Stock_Amount_NT
        ? parseInt(company.Capital_Stock_Amount_NT).toLocaleString('zh-TW') : '';
      base.approved_date = GCISApi.rocToAD(company.Date_Approved || '');

      // ── 風險旗標 ──
      const flags = [];

      // 1. 公司非正常營運
      if (company.Company_Status && company.Company_Status !== '01') {
        flags.push('⚠ 非核准設立狀態');
      }

      // 2. 統編不符（輸入有統編但比對結果不同）
      if (row._tax && row._tax.length === 8 && base.tax_no && row._tax !== base.tax_no) {
        flags.push('⚠ 統編不符');
      }

      // 3. 公司名稱不符
      if (row._name && base.company_name && row._name !== base.company_name) {
        flags.push('ℹ 名稱不完全相符');
      }

      // 4. 負責人不符
      if (row._person && base.responsible && row._person !== base.responsible) {
        flags.push(`⚠ 負責人不符（登記：${base.responsible}）`);
      }

      // 5. 資本額極低
      const cap = parseInt(company.Capital_Stock_Amount_NT || '0');
      if (cap > 0 && cap < 100000) {
        flags.push('ℹ 資本額低於10萬');
      }

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
      const statusColor = r.found
        ? (r.risk_flags.some(f => f.startsWith('⚠')) ? '#e8c84a' : '#4ecb7a')
        : '#e05555';
      const flags = r.risk_flags.length > 0
        ? r.risk_flags.map(f => `<span class="risk-flag">${escapeHtml(f)}</span>`).join(' ')
        : '<span class="risk-ok">✓ 正常</span>';

      return `<tr>
        <td class="mono">${r._rowNum}</td>
        <td>${escapeHtml(r.input_tax || r.input_name || r.input_person)}</td>
        <td style="color:${statusColor};font-weight:600">${escapeHtml(r.company_name || (r.found ? '—' : '查無資料'))}</td>
        <td class="mono">${escapeHtml(r.tax_no)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.responsible)}</td>
        <td>${escapeHtml(r.approved_date)}</td>
        <td>${escapeHtml(r.capital ? r.capital + ' 元' : '')}</td>
        <td>${flags}</td>
        <td>${escapeHtml(r.match_type)}</td>
      </tr>`;
    }).join('');

    document.getElementById('batchResultSection').style.display = 'block';
  }

  // ── 匯出 CSV ──
  function exportCSV() {
    if (batchResults.length === 0) return;

    const headers = [
      '列號', '輸入值', '公司名稱', '統一編號', '公司狀態',
      '負責人', '核准設立日期', '資本額（元）', '風險標註', '比對方式'
    ];

    const rows = batchResults.map(r => [
      r._rowNum,
      r.input_tax || r.input_name || r.input_person,
      r.company_name,
      r.tax_no,
      r.status,
      r.responsible,
      r.approved_date,
      r.capital,
      r.risk_flags.join(' | '),
      r.match_type,
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`));

    const csvContent = [headers.map(h => `"${h}"`), ...rows]
      .map(r => r.join(','))
      .join('\n');

    // BOM for Excel UTF-8
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `DD比對結果_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearBatch() {
    batchRows = []; batchResults = [];
    document.getElementById('batchPreviewSection').style.display = 'none';
    document.getElementById('batchResultSection').style.display = 'none';
    document.getElementById('batchProgressBar').style.display = 'none';
    document.getElementById('batchStatus').textContent = '';
    document.getElementById('batchFileName').textContent = '';
    document.getElementById('batchFileInput').value = '';
    document.getElementById('batchRunBtn').disabled = true;
    document.getElementById('batchExportBtn').style.display = 'none';
  }

  function showBatchError(msg) {
    document.getElementById('batchStatus').textContent = '⚠ ' + msg;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init };
})();
