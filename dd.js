/**
 * dd.js — 第三階段 DD 工作台
 *
 * 核心能力：
 * - 可設定的初步風險評分規則（儲存在瀏覽器 localStorage）
 * - 外部查核證據的人工登錄與來源狀態管理
 * - 已確認／疑似關聯統計
 * - 查核軌跡與資料擷取時間
 * - 單一公司 DD 報告匯出
 *
 * 注意：風險分數是篩選與排序指標，不是法律、信用或投資結論。
 */

const DDCore = (() => {
  const STORAGE = {
    rules: 'dd-platform-risk-rules-v1',
    evidence: 'dd-platform-evidence-v1',
    audit: 'dd-platform-audit-v1',
  };

  const DEFAULT_RULES = Object.freeze({
    inactiveStatus: { enabled: true, weight: 35 },
    missingResponsible: { enabled: true, weight: 12 },
    lowCapital: { enabled: true, weight: 8, threshold: 1000000 },
    recentChange: { enabled: true, weight: 6, days: 90 },
    apiWarnings: { enabled: true, weight: 8 },
    manualEvidence: {
      enabled: true,
      low: 5,
      medium: 15,
      high: 30,
      critical: 45,
      unverifiedMultiplier: 0.5,
      cap: 70,
    },
    levels: { moderate: 20, high: 40, critical: 70 },
  });

  const EVIDENCE_TYPES = Object.freeze({
    litigation: '訴訟／裁判書',
    procurement: '政府採購停權／拒絕往來',
    sanctions: '制裁／觀察名單',
    negativeNews: '重大負面新聞',
    regulatory: '主管機關裁罰',
    credit: '信用／財務異常',
    other: '其他查核事項',
  });

  const EVIDENCE_STATUS = Object.freeze({
    confirmed: '已確認',
    unverified: '待確認',
    cleared: '已排除／已釐清',
  });

  const SEVERITY_LABELS = Object.freeze({
    low: '低',
    medium: '中',
    high: '高',
    critical: '重大',
  });

  const providerMap = new Map();
  let currentContext = null;
  let relationStats = { confirmedEdges: 0, suspectedEdges: 0, nodes: 0, edges: 0 };
  let initialized = false;

  const byId = id => document.getElementById(id);

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mergeRules(base, saved) {
    const output = deepClone(base);
    if (!saved || typeof saved !== 'object') return output;
    Object.keys(output).forEach(key => {
      if (output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
        output[key] = { ...output[key], ...(saved[key] || {}) };
      } else if (saved[key] !== undefined) {
        output[key] = saved[key];
      }
    });
    return output;
  }

  function loadJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (err) {
      console.warn(`[DD] localStorage 讀取失敗：${key}`, err);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn(`[DD] localStorage 儲存失敗：${key}`, err);
      return false;
    }
  }

  function getRules() {
    return mergeRules(DEFAULT_RULES, loadJSON(STORAGE.rules, null));
  }

  function saveRules(rules) {
    saveJSON(STORAGE.rules, mergeRules(DEFAULT_RULES, rules));
  }

  function resetRules() {
    saveRules(DEFAULT_RULES);
    renderRuleForm();
    refresh();
    audit('rules_reset', '風險規則已恢復預設值');
  }

  function registerProvider(provider) {
    if (!provider?.id || !provider?.label) throw new Error('DD provider 必須包含 id 與 label。');
    providerMap.set(provider.id, {
      mode: 'manual',
      description: '',
      evidenceType: provider.id,
      ...provider,
    });
  }

  function registerDefaultProviders() {
    registerProvider({
      id: 'companyRegistry',
      label: '公司登記資料',
      mode: 'automatic',
      description: '經濟部商工行政資料開放平臺',
      evidenceType: null,
    });
    registerProvider({ id: 'litigation', label: EVIDENCE_TYPES.litigation, description: '可登錄裁判書、案號與查核結果' });
    registerProvider({ id: 'procurement', label: EVIDENCE_TYPES.procurement, description: '可登錄停權、拒絕往來或採購異常' });
    registerProvider({ id: 'sanctions', label: EVIDENCE_TYPES.sanctions, description: '可登錄國內外制裁、PEP 或觀察名單結果' });
    registerProvider({ id: 'negativeNews', label: EVIDENCE_TYPES.negativeNews, description: '可登錄重大負面新聞與來源連結' });
    registerProvider({ id: 'regulatory', label: EVIDENCE_TYPES.regulatory, description: '可登錄主管機關裁罰與處分' });
    registerProvider({ id: 'credit', label: EVIDENCE_TYPES.credit, description: '可登錄信用、財務或付款異常資訊' });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    registerDefaultProviders();

    byId('ddAddEvidenceBtn')?.addEventListener('click', () => openEvidenceModal());
    byId('ddRuleSettingsBtn')?.addEventListener('click', openRulesModal);
    byId('ddExportReportBtn')?.addEventListener('click', exportReport);
    byId('ddEvidenceForm')?.addEventListener('submit', saveEvidenceFromForm);
    byId('ddRulesForm')?.addEventListener('submit', saveRulesFromForm);
    byId('ddRulesResetBtn')?.addEventListener('click', resetRules);

    document.querySelectorAll('[data-close-modal]').forEach(button => {
      button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(modal => closeModal(modal.id));
    });

    const graphCanvas = byId('graphCanvas');
    graphCanvas?.addEventListener('graphStatsChanged', event => updateRelationshipStats(event.detail));
    renderRuleForm();
  }

  function parseRegistryDate(value) {
    if (!value) return null;
    const clean = String(value).replace(/\D/g, '');
    let year;
    let month;
    let day;
    if (clean.length === 7) {
      year = Number(clean.slice(0, 3)) + 1911;
      month = Number(clean.slice(3, 5));
      day = Number(clean.slice(5, 7));
    } else if (clean.length === 8) {
      year = Number(clean.slice(0, 4));
      month = Number(clean.slice(4, 6));
      day = Number(clean.slice(6, 8));
    } else {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function daysSince(date) {
    if (!date) return null;
    return Math.floor((Date.now() - date.getTime()) / 86400000);
  }

  function getEvidenceStore() {
    const store = loadJSON(STORAGE.evidence, {});
    return store && typeof store === 'object' ? store : {};
  }

  function getEvidence(taxNo) {
    if (!taxNo) return [];
    const store = getEvidenceStore();
    return Array.isArray(store[taxNo]) ? store[taxNo] : [];
  }

  function putEvidence(taxNo, records) {
    const store = getEvidenceStore();
    store[taxNo] = records;
    saveJSON(STORAGE.evidence, store);
  }

  function addEvidence(record) {
    const taxNo = currentContext?.company?.Business_Accounting_NO;
    if (!taxNo) throw new Error('請先查詢一家公司。');
    const records = getEvidence(taxNo);
    const saved = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: record.type,
      title: record.title,
      status: record.status,
      severity: record.severity,
      eventDate: record.eventDate || '',
      sourceUrl: record.sourceUrl || '',
      note: record.note || '',
      createdAt: new Date().toISOString(),
    };
    records.push(saved);
    putEvidence(taxNo, records);
    audit('evidence_added', `${EVIDENCE_TYPES[saved.type] || saved.type}：${saved.title}`, taxNo);
    refresh();
    return saved;
  }

  function deleteEvidence(id) {
    const taxNo = currentContext?.company?.Business_Accounting_NO;
    if (!taxNo) return;
    const records = getEvidence(taxNo);
    const target = records.find(item => item.id === id);
    putEvidence(taxNo, records.filter(item => item.id !== id));
    audit('evidence_deleted', target ? `刪除：${target.title}` : `刪除紀錄 ${id}`, taxNo);
    refresh();
  }

  function audit(action, detail = '', taxNo = currentContext?.company?.Business_Accounting_NO || '') {
    const logs = loadJSON(STORAGE.audit, []);
    const safeLogs = Array.isArray(logs) ? logs : [];
    safeLogs.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taxNo,
      action,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      createdAt: new Date().toISOString(),
    });
    saveJSON(STORAGE.audit, safeLogs.slice(0, 500));
  }

  function getAuditLogs(taxNo, limit = 30) {
    const logs = loadJSON(STORAGE.audit, []);
    return (Array.isArray(logs) ? logs : [])
      .filter(log => !taxNo || log.taxNo === taxNo)
      .slice(0, limit);
  }

  function getRiskLevel(score, rules = getRules()) {
    if (score >= Number(rules.levels.critical)) return { key: 'critical', label: '重大', className: 'risk-level-critical' };
    if (score >= Number(rules.levels.high)) return { key: 'high', label: '高', className: 'risk-level-high' };
    if (score >= Number(rules.levels.moderate)) return { key: 'moderate', label: '中', className: 'risk-level-moderate' };
    return { key: 'low', label: '低', className: 'risk-level-low' };
  }

  function assessCompany(company = {}, evidence = [], context = {}) {
    const rules = context.rules || getRules();
    const findings = [];
    let score = 0;

    function addFinding(id, label, points, source = 'automatic', severity = 'medium') {
      const safePoints = Math.max(0, Number(points) || 0);
      if (safePoints <= 0) return;
      score += safePoints;
      findings.push({ id, label, points: safePoints, source, severity });
    }

    if (rules.inactiveStatus.enabled && company.Company_Status && company.Company_Status !== '01') {
      addFinding(
        'inactive-status',
        `公司狀態為「${window.GCISApi?.getStatusLabel(company.Company_Status) || company.Company_Status}」`,
        rules.inactiveStatus.weight,
        'companyRegistry',
        'high'
      );
    }

    if (rules.missingResponsible.enabled && !String(company.Responsible_Name || '').trim()) {
      addFinding('missing-responsible', '官方資料未提供代表人', rules.missingResponsible.weight, 'companyRegistry', 'medium');
    }

    const capital = Number(company.Capital_Stock_Amount_NT ?? company.Capital_Stock_Amount ?? '');
    if (rules.lowCapital.enabled && Number.isFinite(capital) && capital > 0 && capital < Number(rules.lowCapital.threshold)) {
      addFinding(
        'low-capital',
        `資本額低於設定門檻 ${Number(rules.lowCapital.threshold).toLocaleString('zh-TW')} 元`,
        rules.lowCapital.weight,
        'companyRegistry',
        'low'
      );
    }

    const changeDate = parseRegistryDate(company.Change_Of_Approval_Data || company.Change_Date || '');
    const elapsedDays = daysSince(changeDate);
    if (rules.recentChange.enabled && elapsedDays !== null && elapsedDays >= 0 && elapsedDays <= Number(rules.recentChange.days)) {
      addFinding(
        'recent-change',
        `最近 ${rules.recentChange.days} 日內有公司登記事項核准變更`,
        rules.recentChange.weight,
        'companyRegistry',
        'low'
      );
    }

    const warnings = [...(company._apiWarnings || []), ...(context.warnings || [])];
    if (rules.apiWarnings.enabled && warnings.length > 0) {
      addFinding('api-warning', '部分官方資料來源未能取得，查核完整性受限', rules.apiWarnings.weight, 'system', 'medium');
    }

    if (rules.manualEvidence.enabled) {
      let manualPoints = 0;
      evidence.forEach(item => {
        if (item.status === 'cleared') return;
        const basePoints = Number(rules.manualEvidence[item.severity]) || 0;
        const multiplier = item.status === 'unverified'
          ? Number(rules.manualEvidence.unverifiedMultiplier) || 0
          : 1;
        const points = Math.round(basePoints * multiplier);
        manualPoints += points;
        findings.push({
          id: item.id,
          label: `${EVIDENCE_TYPES[item.type] || item.type}：${item.title}${item.status === 'unverified' ? '（待確認）' : ''}`,
          points,
          source: item.type,
          severity: item.severity,
        });
      });
      const capped = Math.min(manualPoints, Number(rules.manualEvidence.cap) || manualPoints);
      score += capped;
      if (manualPoints > capped) {
        findings.push({ id: 'manual-cap', label: `外部查核事項分數依設定上限計入 ${capped} 分`, points: 0, source: 'system', severity: 'low' });
      }
    }

    score = Math.min(100, Math.max(0, Math.round(score)));
    const level = getRiskLevel(score, rules);
    return { score, level, findings, rules };
  }

  function automaticAssessment(company, context = {}) {
    return assessCompany(company, [], context);
  }

  function setCompanyContext(company, directors = [], branches = [], meta = {}) {
    const retrievedAt = meta.retrievedAt || new Date().toISOString();
    currentContext = {
      company,
      directors: directors || [],
      branches: branches || [],
      meta: { ...meta, retrievedAt },
    };
    relationStats = { confirmedEdges: 0, suspectedEdges: 0, nodes: 0, edges: 0 };
    audit(
      'company_loaded',
      `載入 ${company.Company_Name || company.Business_Accounting_NO || '公司'}；董監事 ${directors.length} 筆；分公司 ${branches.length} 筆`,
      company.Business_Accounting_NO
    );
    refresh();
  }

  function updateRelationshipStats(stats = {}) {
    relationStats = {
      confirmedEdges: Number(stats.confirmedEdges) || 0,
      suspectedEdges: Number(stats.suspectedEdges) || 0,
      nodes: Number(stats.nodes) || 0,
      edges: Number(stats.edges) || 0,
    };
    renderRelationshipSummary();
  }

  function refresh() {
    if (!currentContext?.company) return;
    const workbench = byId('ddWorkbench');
    if (workbench) workbench.style.display = 'block';
    renderRiskAssessment();
    renderProviders();
    renderEvidence();
    renderAudit();
    renderRelationshipSummary();
    renderDataTimestamp();
  }

  function renderRiskAssessment() {
    const company = currentContext.company;
    const evidence = getEvidence(company.Business_Accounting_NO);
    const assessment = assessCompany(company, evidence, { warnings: currentContext.meta.warnings || [] });

    const score = byId('ddRiskScore');
    const level = byId('ddRiskLevel');
    const meter = byId('ddRiskMeterFill');
    const findings = byId('ddRiskFindings');
    if (score) score.textContent = assessment.score;
    if (level) {
      level.textContent = `${assessment.level.label}風險`;
      level.className = `dd-risk-level ${assessment.level.className}`;
    }
    if (meter) meter.style.width = `${assessment.score}%`;
    if (findings) {
      findings.innerHTML = assessment.findings.length
        ? assessment.findings.map(item => `
          <li>
            <span>${escapeHtml(item.label)}</span>
            ${item.points > 0 ? `<strong>+${item.points}</strong>` : ''}
          </li>`).join('')
        : '<li class="dd-no-finding">目前自動規則與已登錄證據未產生風險加分。</li>';
    }
  }

  function renderProviders() {
    const container = byId('ddProviderGrid');
    if (!container || !currentContext?.company) return;
    const evidence = getEvidence(currentContext.company.Business_Accounting_NO);
    container.innerHTML = [...providerMap.values()].map(provider => {
      if (provider.mode === 'automatic') {
        return `
          <div class="dd-provider-card provider-complete">
            <div class="dd-provider-head"><span>${escapeHtml(provider.label)}</span><span class="dd-provider-status">已取得</span></div>
            <p>${escapeHtml(provider.description)}</p>
          </div>`;
      }
      const count = evidence.filter(item => item.type === provider.evidenceType).length;
      const statusClass = count > 0 ? 'provider-recorded' : 'provider-manual';
      const statusText = count > 0 ? `已登錄 ${count} 筆` : '人工查核';
      return `
        <button type="button" class="dd-provider-card ${statusClass}" data-provider="${escapeHtml(provider.id)}">
          <div class="dd-provider-head"><span>${escapeHtml(provider.label)}</span><span class="dd-provider-status">${statusText}</span></div>
          <p>${escapeHtml(provider.description)}</p>
        </button>`;
    }).join('');

    container.querySelectorAll('[data-provider]').forEach(button => {
      button.addEventListener('click', () => openEvidenceModal(button.dataset.provider));
    });
  }

  function renderEvidence() {
    const tbody = byId('ddEvidenceBody');
    const count = byId('ddEvidenceCount');
    if (!tbody || !currentContext?.company) return;
    const evidence = getEvidence(currentContext.company.Business_Accounting_NO);
    if (count) count.textContent = `${evidence.length} 筆`;

    if (evidence.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="dd-empty-cell">尚未登錄外部查核事項。</td></tr>';
      return;
    }

    tbody.innerHTML = [...evidence].reverse().map(item => {
      const sourceLink = safeHttpUrl(item.sourceUrl)
        ? `<a href="${escapeAttribute(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">開啟來源</a>`
        : '—';
      return `
        <tr>
          <td>${escapeHtml(EVIDENCE_TYPES[item.type] || item.type)}</td>
          <td><strong>${escapeHtml(item.title)}</strong>${item.note ? `<div class="dd-cell-note">${escapeHtml(item.note)}</div>` : ''}</td>
          <td><span class="evidence-status status-${escapeHtml(item.status)}">${escapeHtml(EVIDENCE_STATUS[item.status] || item.status)}</span></td>
          <td><span class="evidence-severity severity-${escapeHtml(item.severity)}">${escapeHtml(SEVERITY_LABELS[item.severity] || item.severity)}</span></td>
          <td class="mono">${escapeHtml(item.eventDate || '—')}</td>
          <td>${sourceLink}</td>
          <td><button type="button" class="btn-ghost btn-sm dd-delete-evidence" data-id="${escapeHtml(item.id)}">刪除</button></td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.dd-delete-evidence').forEach(button => {
      button.addEventListener('click', () => {
        if (window.confirm('確定刪除此查核紀錄？')) deleteEvidence(button.dataset.id);
      });
    });
  }

  function renderAudit() {
    const tbody = byId('ddAuditBody');
    if (!tbody || !currentContext?.company) return;
    const logs = getAuditLogs(currentContext.company.Business_Accounting_NO, 20);
    const labels = {
      company_loaded: '公司資料查詢',
      evidence_added: '新增查核紀錄',
      evidence_deleted: '刪除查核紀錄',
      rules_saved: '調整風險規則',
      rules_reset: '重設風險規則',
      report_exported: '匯出 DD 報告',
    };
    tbody.innerHTML = logs.length
      ? logs.map(log => `
        <tr>
          <td class="mono">${escapeHtml(formatDateTime(log.createdAt))}</td>
          <td>${escapeHtml(labels[log.action] || log.action)}</td>
          <td>${escapeHtml(log.detail || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="dd-empty-cell">尚無查核紀錄。</td></tr>';
  }

  function renderRelationshipSummary() {
    const element = byId('ddRelationSummary');
    if (!element) return;
    element.innerHTML = `
      <span><strong>${relationStats.confirmedEdges}</strong> 已確認連線</span>
      <span><strong>${relationStats.suspectedEdges}</strong> 疑似連線</span>
      <span><strong>${relationStats.nodes}</strong> 節點</span>`;
  }

  function renderDataTimestamp() {
    const element = byId('ddDataTimestamp');
    if (!element || !currentContext) return;
    element.textContent = `本次資料擷取時間：${formatDateTime(currentContext.meta.retrievedAt)}。官方資料實際更新日依各資料集為準。`;
  }

  function openEvidenceModal(type = '') {
    if (!currentContext?.company) return;
    const form = byId('ddEvidenceForm');
    form?.reset();
    const typeInput = byId('ddEvidenceType');
    if (typeInput && type && EVIDENCE_TYPES[type]) typeInput.value = type;
    openModal('ddEvidenceModal');
    setTimeout(() => byId('ddEvidenceTitle')?.focus(), 0);
  }

  function saveEvidenceFromForm(event) {
    event.preventDefault();
    const title = byId('ddEvidenceTitle')?.value.trim();
    if (!title) return;
    const sourceUrl = byId('ddEvidenceUrl')?.value.trim() || '';
    if (sourceUrl && !safeHttpUrl(sourceUrl)) {
      window.alert('來源網址僅支援 http 或 https。');
      return;
    }
    addEvidence({
      type: byId('ddEvidenceType').value,
      title,
      status: byId('ddEvidenceStatus').value,
      severity: byId('ddEvidenceSeverity').value,
      eventDate: byId('ddEvidenceDate').value,
      sourceUrl,
      note: byId('ddEvidenceNote').value.trim(),
    });
    closeModal('ddEvidenceModal');
  }

  function openRulesModal() {
    renderRuleForm();
    openModal('ddRulesModal');
  }

  function renderRuleForm() {
    const rules = getRules();
    const setChecked = (id, value) => { const el = byId(id); if (el) el.checked = Boolean(value); };
    const setValue = (id, value) => { const el = byId(id); if (el) el.value = value; };
    setChecked('ruleInactiveEnabled', rules.inactiveStatus.enabled);
    setValue('ruleInactiveWeight', rules.inactiveStatus.weight);
    setChecked('ruleMissingResponsibleEnabled', rules.missingResponsible.enabled);
    setValue('ruleMissingResponsibleWeight', rules.missingResponsible.weight);
    setChecked('ruleLowCapitalEnabled', rules.lowCapital.enabled);
    setValue('ruleLowCapitalWeight', rules.lowCapital.weight);
    setValue('ruleLowCapitalThreshold', rules.lowCapital.threshold);
    setChecked('ruleRecentChangeEnabled', rules.recentChange.enabled);
    setValue('ruleRecentChangeWeight', rules.recentChange.weight);
    setValue('ruleRecentChangeDays', rules.recentChange.days);
    setChecked('ruleApiWarningsEnabled', rules.apiWarnings.enabled);
    setValue('ruleApiWarningsWeight', rules.apiWarnings.weight);
    setChecked('ruleManualEnabled', rules.manualEvidence.enabled);
    setValue('ruleManualLow', rules.manualEvidence.low);
    setValue('ruleManualMedium', rules.manualEvidence.medium);
    setValue('ruleManualHigh', rules.manualEvidence.high);
    setValue('ruleManualCritical', rules.manualEvidence.critical);
    setValue('ruleManualUnverified', rules.manualEvidence.unverifiedMultiplier);
    setValue('ruleManualCap', rules.manualEvidence.cap);
    setValue('ruleLevelModerate', rules.levels.moderate);
    setValue('ruleLevelHigh', rules.levels.high);
    setValue('ruleLevelCritical', rules.levels.critical);
  }

  function numberValue(id, fallback = 0) {
    const value = Number(byId(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function saveRulesFromForm(event) {
    event.preventDefault();
    const rules = {
      inactiveStatus: { enabled: byId('ruleInactiveEnabled').checked, weight: numberValue('ruleInactiveWeight', 35) },
      missingResponsible: { enabled: byId('ruleMissingResponsibleEnabled').checked, weight: numberValue('ruleMissingResponsibleWeight', 12) },
      lowCapital: {
        enabled: byId('ruleLowCapitalEnabled').checked,
        weight: numberValue('ruleLowCapitalWeight', 8),
        threshold: numberValue('ruleLowCapitalThreshold', 1000000),
      },
      recentChange: {
        enabled: byId('ruleRecentChangeEnabled').checked,
        weight: numberValue('ruleRecentChangeWeight', 6),
        days: numberValue('ruleRecentChangeDays', 90),
      },
      apiWarnings: { enabled: byId('ruleApiWarningsEnabled').checked, weight: numberValue('ruleApiWarningsWeight', 8) },
      manualEvidence: {
        enabled: byId('ruleManualEnabled').checked,
        low: numberValue('ruleManualLow', 5),
        medium: numberValue('ruleManualMedium', 15),
        high: numberValue('ruleManualHigh', 30),
        critical: numberValue('ruleManualCritical', 45),
        unverifiedMultiplier: numberValue('ruleManualUnverified', 0.5),
        cap: numberValue('ruleManualCap', 70),
      },
      levels: {
        moderate: numberValue('ruleLevelModerate', 20),
        high: numberValue('ruleLevelHigh', 40),
        critical: numberValue('ruleLevelCritical', 70),
      },
    };

    if (!(rules.levels.moderate < rules.levels.high && rules.levels.high < rules.levels.critical)) {
      window.alert('風險等級門檻必須依序為：中風險 < 高風險 < 重大風險。');
      return;
    }
    saveRules(rules);
    audit('rules_saved', '風險規則已更新');
    closeModal('ddRulesModal');
    refresh();
  }

  function exportReport() {
    if (!currentContext?.company) return;
    const company = currentContext.company;
    const evidence = getEvidence(company.Business_Accounting_NO);
    const assessment = assessCompany(company, evidence, { warnings: currentContext.meta.warnings || [] });
    const logs = getAuditLogs(company.Business_Accounting_NO, 50);
    const providers = [...providerMap.values()];
    const generatedAt = new Date().toISOString();

    const infoRows = [
      ['公司名稱', company.Company_Name || ''],
      ['統一編號', company.Business_Accounting_NO || ''],
      ['公司狀態', window.GCISApi?.getStatusLabel(company.Company_Status) || company.Company_Status || ''],
      ['代表人', company.Responsible_Name || ''],
      ['公司所在地', company.Company_Location || company.Company_Address || ''],
      ['核准設立日', window.GCISApi?.rocToAD(company.Date_Approved) || company.Date_Approved || ''],
      ['最後核准日', window.GCISApi?.rocToAD(company.Change_Of_Approval_Data) || company.Change_Of_Approval_Data || ''],
      ['資本額', window.GCISApi?.formatCapital(company.Capital_Stock_Amount_NT) || company.Capital_Stock_Amount_NT || ''],
      ['組織型態', company.Organization || ''],
    ];

    const report = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DD報告_${escapeHtml(company.Company_Name || company.Business_Accounting_NO)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC",Arial,sans-serif;color:#172033;margin:40px;line-height:1.65}h1{font-size:25px;margin:0}h2{font-size:18px;border-bottom:2px solid #d6b73c;padding-bottom:6px;margin-top:30px}.meta{color:#687184;font-size:12px}.score{display:flex;gap:22px;align-items:center;padding:18px;border:1px solid #d9dde7;border-radius:8px}.score strong{font-size:42px}.badge{padding:5px 12px;border-radius:999px;background:#fff2be;font-weight:700}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}th,td{border:1px solid #d9dde7;padding:7px 9px;text-align:left;vertical-align:top}th{background:#f4f5f8}.finding{display:flex;justify-content:space-between;border-bottom:1px solid #e8eaf0;padding:6px 0}.disclaimer{margin-top:36px;padding:12px;background:#fff8dc;font-size:12px}.muted{color:#70798c}.mono{font-family:ui-monospace,monospace}@media print{body{margin:18mm}.no-print{display:none}}
</style></head><body>
<header><h1>公司盡職調查初步報告</h1><div class="meta">報告產生時間：${escapeHtml(formatDateTime(generatedAt))}｜資料擷取時間：${escapeHtml(formatDateTime(currentContext.meta.retrievedAt))}</div></header>
<h2>一、公司基本資料</h2>
<table><tbody>${infoRows.map(row => `<tr><th style="width:160px">${escapeHtml(row[0])}</th><td>${escapeHtml(row[1])}</td></tr>`).join('')}</tbody></table>
<h2>二、初步風險評分</h2>
<div class="score"><strong>${assessment.score}</strong><span class="badge">${escapeHtml(assessment.level.label)}風險</span><span class="muted">分數用於初步篩選，不代表法律、信用或投資結論。</span></div>
<div>${assessment.findings.length ? assessment.findings.map(item => `<div class="finding"><span>${escapeHtml(item.label)}</span><strong>${item.points > 0 ? `+${item.points}` : ''}</strong></div>`).join('') : '<p>未產生風險加分項目。</p>'}</div>
<h2>三、外部查核事項</h2>
<table><thead><tr><th>類型</th><th>事項</th><th>狀態</th><th>嚴重度</th><th>日期</th><th>來源</th><th>備註</th></tr></thead><tbody>
${evidence.length ? evidence.map(item => `<tr><td>${escapeHtml(EVIDENCE_TYPES[item.type] || item.type)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(EVIDENCE_STATUS[item.status] || item.status)}</td><td>${escapeHtml(SEVERITY_LABELS[item.severity] || item.severity)}</td><td>${escapeHtml(item.eventDate || '')}</td><td>${safeHttpUrl(item.sourceUrl) ? `<a href="${escapeAttribute(item.sourceUrl)}">${escapeHtml(item.sourceUrl)}</a>` : ''}</td><td>${escapeHtml(item.note || '')}</td></tr>`).join('') : '<tr><td colspan="7">尚未登錄外部查核事項。</td></tr>'}
</tbody></table>
<h2>四、資料來源覆蓋</h2>
<table><thead><tr><th>資料來源</th><th>模式</th><th>狀態</th><th>說明</th></tr></thead><tbody>
${providers.map(provider => {
  const count = provider.evidenceType ? evidence.filter(item => item.type === provider.evidenceType).length : 0;
  return `<tr><td>${escapeHtml(provider.label)}</td><td>${provider.mode === 'automatic' ? '自動' : '人工登錄'}</td><td>${provider.mode === 'automatic' ? '已取得' : count ? `已登錄 ${count} 筆` : '尚未登錄'}</td><td>${escapeHtml(provider.description)}</td></tr>`;
}).join('')}
</tbody></table>
<h2>五、關聯與公司組成</h2>
<p>關聯圖：${relationStats.nodes} 個節點、${relationStats.confirmedEdges} 條已確認連線、${relationStats.suspectedEdges} 條疑似連線。</p>
<h3>董監事／經理人</h3><table><thead><tr><th>職稱</th><th>姓名</th><th>所代表法人</th><th>出資額</th></tr></thead><tbody>${currentContext.directors.length ? currentContext.directors.map(item => `<tr><td>${escapeHtml(item.Title || '')}</td><td>${escapeHtml(item.Name || '')}</td><td>${escapeHtml(item.Representative_Name || '')}</td><td>${escapeHtml(String(item.Invest_Money || ''))}</td></tr>`).join('') : '<tr><td colspan="4">未取得資料。</td></tr>'}</tbody></table>
<h3>分公司</h3><table><thead><tr><th>名稱</th><th>統一編號</th><th>地址</th></tr></thead><tbody>${currentContext.branches.length ? currentContext.branches.map(item => `<tr><td>${escapeHtml(item.Branch_Office_Name || '')}</td><td>${escapeHtml(item.Branch_Office_Business_Accounting_NO || '')}</td><td>${escapeHtml(item.Branch_Office_Address || item.Branch_Office_Location || '')}</td></tr>`).join('') : '<tr><td colspan="3">未取得或無分公司資料。</td></tr>'}</tbody></table>
<h2>六、查核軌跡</h2><table><thead><tr><th>時間</th><th>動作</th><th>說明</th></tr></thead><tbody>${logs.length ? logs.map(log => `<tr><td class="mono">${escapeHtml(formatDateTime(log.createdAt))}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.detail || '')}</td></tr>`).join('') : '<tr><td colspan="3">無紀錄。</td></tr>'}</tbody></table>
<div class="disclaimer">本報告依平台當次取得之公開資料、使用者自行登錄之查核事項及當時設定的風險規則產生，僅供初步盡職調查與風險篩選參考。未串接或未登錄的資料來源，不代表已完成查核或未發現風險；重要決策仍應回到官方原始資料並由具權責人員覆核。</div>
</body></html>`;

    const blob = new Blob(['\uFEFF', report], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `DD報告_${sanitizeFileName(company.Company_Name || company.Business_Accounting_NO || 'company')}_${generatedAt.slice(0, 10)}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    audit('report_exported', `匯出風險分數 ${assessment.score} 分之 DD 報告`, company.Business_Accounting_NO);
    renderAudit();
  }

  function openModal(id) {
    byId(id)?.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeModal(id) {
    byId(id)?.classList.add('hidden');
    if (!document.querySelector('.modal-backdrop:not(.hidden)')) document.body.classList.remove('modal-open');
  }

  function safeHttpUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
  }

  function sanitizeFileName(value) {
    return String(value || 'report').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }

  return {
    init,
    registerProvider,
    setCompanyContext,
    updateRelationshipStats,
    assessCompany,
    automaticAssessment,
    getRules,
    getEvidence,
    addEvidence,
    refresh,
    audit,
    getCurrentContext: () => currentContext ? deepClone(currentContext) : null,
  };
})();

if (typeof window !== 'undefined') window.DDCore = DDCore;
