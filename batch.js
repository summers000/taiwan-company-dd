/**
 * batch.js — 批次比對模組
 * 固定欄位：統一編號、公司名稱、登記地址、代表人、國家
 * 國家欄位填 TW 才會查詢，其他自動跳過
 */

const Batch = (() => {

  let batchRows    = [];
  let batchResults = [];

  // ── 固定欄位名稱 ──
  const COL = {
    tax:     '統一編號',
    name:    '公司名稱',
    address: '登記地址',
    person:  '代表人',
    country: '國家',
  };

  function init() {
    document.getElementById('batchFileInput').addEventListener('change', onFileChange);
    document.getElementById('batchRunBtn').addEventListener('click', runBatch);
    document.getElementById('batchExportBtn').addEventListener('click', exportCSV);
    document.getElementById('batchClearBtn').addEventListener('click', clearBatch);

    const dz = document.getElementById('batchDropZone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
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
      if (typeof XLSX !== 'undefined') {
        readExcel(file);
      } else {
        showBatchError('請將 Excel 另存為「CSV UTF-8」格式後再上傳（檔案 → 另存新檔 → CSV UTF-8）');
      }
    } else {
      showBatchError('請上傳 CSV 或 Excel 檔案');
    }
  }

  // ── 讀取 CSV（自動偵測 UTF-8 / Big5）──
  function readCSV(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      // 若含亂碼字元，改用 Big5 重讀
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
      } catch (err) {
        showBatchError('Excel 解析失敗，請另存為 CSV 後再試。');
      }
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

  // ── 解析資料，對應固定欄位 ──
  function onDataParsed(rows, fileName) {
    if (rows.length < 2) { showBatchError('檔案內容不足，至少需要標題列和一筆資料。'); return; }

    const headers = rows[0].map(h => String(h).trim());

    // 確認必要欄位存在
    const missing = [];
    if (!headers.includes(COL.tax)  && !headers.includes(COL.name))  missing.push(`「${COL.tax}」或「${COL.name}」`);
    if (missing.length > 0) {
      showBatchError(`找不到必要欄位：${missing.join('、')}。請確認欄位名稱完全相符。`);
      return;
    }

    const idx = {
      tax:     headers.indexOf(COL.tax),
      name:    headers.indexOf(COL.name),
      address: headers.indexOf(COL.address),
      person:  headers.indexOf(COL.person),
      country: headers.indexOf(COL.country),
    };

    const allRows = rows.slice(1).map((row, i) => ({
      _rowNum:  i + 2,
      _tax:     idx.tax     >= 0 ? padTax(String(row[idx.tax]     || '').trim()) : '',
      _name:    idx.name    >= 0 ? String(row[idx.name]    || '').trim() : '',
      _address: idx.address >= 0 ? String(row[idx.address] || '').trim() : '',
      _person:  idx.person  >= 0 ? String(row[idx.person]  || '').trim() : '',
      _country: idx.country >= 0 ? String(row[idx.country] || '').trim().toUpperCase() : 'TW',
    }));

    // 只保留台灣廠商（國家欄位為 TW 或空白）
    const twRows    = allRows.filter(r => r._country === 'TW' || r._country === '台灣' || r._country === '');
    const skipCount = allRows.length - twRows.length;

    batchRows = twRows.filter(r => r._tax || r._name);

    if (batchRows.length === 0) {
      showBatchError('沒有找到台灣廠商（國家=TW）且有統一編號或公司名稱的資料。');
      return;
    }

    // 顯示摘要
    document.getElementById('batchFileName').textContent  = fileName;
    document.getElementById('batchRowCount').textContent  = `${batchRows.length} 筆（已略過 ${skipCount} 筆非台灣廠商）`;
    document.getElementById('batchDetected').textContent  = buildDetectedStr(idx, headers);
    document.getElementById('batchPreviewSection').style.display = 'block';
    document.getElementById('batchResultSection').style.display  = 'none';
    document.getElementById('batchRunBtn').disabled = false;
    document.getElementById('batchStatus').textContent = '';
    document.getElementById('batchProgressBar').style.display = 'none';
    document.getElementById('batchProgressFill').style.width  = '0%';
    batchResults = [];
  }

  // 統編補零（SAP 有時存成數字，開頭 0 會掉）
  function padTax(val) {
    const digits = val.replace(/\D/g, '');
    if (digits.length === 7) return '0' + digits;  // 補前導零
    if (digits.length === 8) return digits;
    return val; // 非數字格式（空白等）原樣回傳
  }

  function buildDetectedStr(idx, headers) {
    const parts = [];
    Object.entries(COL).forEach(([key, label]) => {
      if (idx[key] >= 0) parts.push(`${label}（第${idx[key]+1}欄）`);
    });
    return parts.join('、') || '無';
  }

  // ── 批次查詢 ──
  async function runBatch() {
    if (batchRows.length === 0) return;
    document.getElementById('batchRunBtn').disabled = true;
    document.getElementById('batchExportBtn').style.display = 'none';
    batchResults = [];

    const total       = batchRows.length;
    const progressBar = document.getElementById('batchProgressBar');
    const fillEl      = document.getElementById('batchProgressFill');
    const statusEl    = document.getElementById('batchStatus');
    progressBar.style.display = 'block';

    for (let i = 0; i < batchRows.length; i++) {
      fillEl.style.width = Math.round((i / total) * 100) + '%';
      statusEl.textContent = `查詢中 ${i + 1} / ${total}…`;

      const result = await queryRow(batchRows[i]);
      batchResults.push(result);
      renderResultTable(batchResults);

      await new Promise(r => setTimeout(r, 400));
    }

    fillEl.style.width = '100%';
    const found = batchResults.filter(r => r.found).length;
    const warn  = batchResults.filter(r => r.risk_flags.some(f => f.startsWith('⚠'))).length;
    statusEl.textContent = `完成！${total} 筆　✓ 找到 ${found} 筆　⚠ 有風險 ${warn} 筆　✗ 查無 ${total - found} 筆`;
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
      input_address: row._address,
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

      // 1. 統編精確查
      if (row._tax && row._tax.length === 8) {
        company = await GCISApi.fetchCompanyByTaxNo(row._tax);
        if (company) base.match_type = '統編精確比對';
      }

      // 2. 若無結果，用公司名稱查
      if (!company && row._name) {
        const results = await GCISApi.searchCompanyAll(row._name, 3);
        if (results.length > 0) {
          company = results[0];
          base.match_type = results[0].Company_Name === row._name ? '名稱完全符合' : '名稱模糊比對';
        }
      }

      if (!company) {
        base.risk_flags = ['查無資料'];
        return base;
      }

      base.found         = true;
      base.company_name  = company.Company_Name || '';
      base.tax_no        = company.Business_Accounting_NO || '';
      base.status        = GCISApi.getStatusLabel(company.Company_Status || '');
      base.responsible   = company.Responsible_Name || '';
      base.location      = company.Company_Location || '';
      base.capital       = company.Capital_Stock_Amount_NT
        ? parseInt(company.Capital_Stock_Amount_NT).toLocaleString('zh-TW') : '';
      base.approved_date = GCISApi.rocToAD(company.Date_Approved || '');

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

      const cap = parseInt(company.Capital_Stock_Amount_NT || '0');
      if (cap > 0 && cap < 100000)
        flags.push('ℹ 資本額低於10萬');

      base.risk_flags = flags.length > 0 ? flags : [];
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
      const hasWarn = r.risk_flags.some(f => f.startsWith('⚠'));
      const nameColor = !r.found ? '#e05555' : hasWarn ? '#e8c84a' : '#4ecb7a';
      const flags = r.risk_flags.length > 0
        ? r.risk_flags.map(f => {
            const isWarn = f.startsWith('⚠');
            const isInfo = f.startsWith('ℹ');
            const cls = isWarn ? 'risk-flag' : isInfo ? 'risk-flag risk-info' : 'risk-flag risk-err';
            return `<span class="${cls}">${escapeHtml(f)}</span>`;
          }).join(' ')
        : '<span class="risk-ok">✓ 正常</span>';

      return `<tr>
        <td class="mono">${r._rowNum}</td>
        <td class="mono">${escapeHtml(r.input_tax)}</td>
        <td>${escapeHtml(r.input_name)}</td>
        <td style="color:${nameColor};font-weight:600">${escapeHtml(r.company_name || (r.found ? '' : '查無資料'))}</td>
        <td class="mono">${escapeHtml(r.tax_no)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.responsible)}</td>
        <td>${escapeHtml(r.approved_date)}</td>
        <td class="mono">${escapeHtml(r.capital ? r.capital + ' 元' : '')}</td>
        <td>${flags}</td>
        <td>${escapeHtml(r.match_type)}</td>
      </tr>`;
    }).join('');
    document.getElementById('batchResultSection').style.display = 'block';
  }

  // ── 匯出 CSV ──
  function exportCSV() {
    if (batchResults.length === 0) return;
    const headers = ['列號','輸入統編','輸入公司名','查詢公司名','統一編號','公司狀態','負責人','核准設立日','資本額（元）','風險標註','比對方式'];
    const rows = batchResults.map(r => [
      r._rowNum, r.input_tax, r.input_name,
      r.company_name, r.tax_no, r.status, r.responsible,
      r.approved_date, r.capital,
      r.risk_flags.join(' | '), r.match_type,
    ].map(v => `"${String(v||'').replace(/"/g,'""')}"`));

    const csv = [headers.map(h=>`"${h}"`), ...rows].map(r=>r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `DD比對結果_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clearBatch() {
    batchRows = []; batchResults = [];
    ['batchPreviewSection','batchResultSection'].forEach(id => document.getElementById(id).style.display='none');
    document.getElementById('batchProgressBar').style.display = 'none';
    document.getElementById('batchProgressFill').style.width  = '0%';
    document.getElementById('batchStatus').textContent    = '';
    document.getElementById('batchFileName').textContent  = '';
    document.getElementById('batchFileInput').value       = '';
    document.getElementById('batchRunBtn').disabled       = true;
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
