/**
 * graph.js — DD 關聯圖引擎
 *
 * 本版重點：
 * - 總覽／公司與分公司／人員／法人／地址／全部等分層模式。
 * - 依節點類型分區排列，不再完全依賴自由力導向佈局。
 * - 公司、分公司、法人、地址與人員使用不同形狀。
 * - 文字以 Canvas measureText 實測後自動換行、縮放及省略。
 * - 線條標籤只在滑鼠移入或選取節點時顯示。
 * - 選取節點後淡化無關內容，方便追蹤單一路徑。
 */

function createRelationGraph({
  canvasId,
  emptyId,
  infoId,
  exportFileName,
  modeBarId,
  fitButtonId,
  focusButtonId,
}) {
  const NODE_STYLE = {
    company: {
      fill: '#dcecff',
      fillStrong: '#b9d8ff',
      stroke: '#2f73c5',
      text: '#111111',
    },
    branch: {
      fill: '#eef6ff',
      fillStrong: '#d8eaff',
      stroke: '#6e9fd4',
      text: '#111111',
    },
    person: {
      fill: '#fff4c7',
      fillStrong: '#ffe58b',
      stroke: '#a77d00',
      text: '#111111',
    },
    address: {
      fill: '#e1f6e9',
      fillStrong: '#c6efd6',
      stroke: '#258452',
      text: '#111111',
    },
    legalEntity: {
      fill: '#eee7ff',
      fillStrong: '#d9cbff',
      stroke: '#7150ba',
      text: '#111111',
    },
    summary: {
      fill: '#f6f7fa',
      fillStrong: '#e8ebf1',
      stroke: '#5d6677',
      text: '#111111',
    },
  };

  const EDGE_COLOR = {
    代表人: '#9b7600',
    董事長: '#9b7600',
    董事: '#397fc6',
    獨立董事: '#c66c15',
    監察人: '#8751aa',
    經理人: '#268653',
    地址: '#258452',
    法人代表: '#b6522f',
    分公司: '#5f94c9',
    同名負責人: '#9b7600',
    同一登記地址: '#258452',
    地址相符: '#45a76c',
    登記人員: '#9b7600',
    公司關聯: '#397fc6',
    人員關聯: '#9b7600',
    法人關聯: '#7150ba',
    地址關聯: '#258452',
    default: '#778195',
  };

  const MODE_LABELS = {
    overview: '總覽',
    companies: '公司／分公司',
    people: '人員',
    legal: '法人',
    address: '地址',
    all: '全部',
  };

  const CATEGORY_ORDER = ['companies', 'people', 'legal', 'address'];
  const FONT_FAMILY = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';

  let canvas;
  let ctx;
  let tooltip;
  const nodeMap = new Map();
  const edgeMap = new Map();
  let visibleNodes = [];
  let visibleEdges = [];
  let visibleNodeMap = new Map();
  let rootNodeId = null;
  let viewMode = 'overview';
  let selectedNodeId = null;
  let hoveredNode = null;
  let animFrame = null;
  let simTick = 0;
  let isDragging = false;
  let dragNode = null;
  let dragOffX = 0;
  let dragOffY = 0;
  let panStart = null;
  let mouseDownPos = null;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let pendingFit = false;

  const byId = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const normalizeBasic = value => String(value || '')
    .normalize('NFKC')
    .replace(/臺/g, '台')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、．,.()（）\-—_\/\\]/g, '')
    .toLowerCase();

  const normalizePerson = value => window.GCISApi?.normalizePersonName
    ? GCISApi.normalizePersonName(value)
    : normalizeBasic(value);

  const normalizeAddress = value => window.GCISApi?.normalizeAddress
    ? GCISApi.normalizeAddress(value)
    : normalizeBasic(value);

  const normalizeCompany = value => window.GCISApi?.normalizeCompanyName
    ? GCISApi.normalizeCompanyName(value)
    : normalizeBasic(value);

  function init() {
    canvas = byId(canvasId);
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    canvas.parentElement.appendChild(tooltip);

    bindModeControls();
    resize();
    new ResizeObserver(resize).observe(canvas.parentElement);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', () => {
      onMouseUp({});
      hoveredNode = null;
      hideTooltip();
      draw();
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', event => {
      event.preventDefault();
      onMouseDown(touchEvt(event));
    }, { passive: false });
    canvas.addEventListener('touchmove', event => {
      event.preventDefault();
      onMouseMove(touchEvt(event));
    }, { passive: false });
    canvas.addEventListener('touchend', () => onMouseUp({}));

    refreshView({ fit: true, animate: false });
  }

  function bindModeControls() {
    const modeBar = byId(modeBarId);
    if (modeBar) {
      modeBar.querySelectorAll('[data-graph-mode]').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.graphMode));
      });
    }
    const fitButton = byId(fitButtonId);
    if (fitButton) fitButton.addEventListener('click', () => fitToView());
    const focusButton = byId(focusButtonId);
    if (focusButton) focusButton.addEventListener('click', resetFocus);
    updateModeControls();
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    canvas._cssWidth = width;
    canvas._cssHeight = height;
    rebuildLayout();
    fitToView(false);
    draw();
  }

  function touchEvt(event) {
    const touch = event.touches[0];
    return { clientX: touch.clientX, clientY: touch.clientY, _isFake: true };
  }

  function nodeId(type, key) {
    return `${type}:${key}`;
  }

  function scopedPersonKey(name, taxNo, role, representedEntity = '') {
    return [normalizePerson(name), taxNo || 'unknown-company', normalizeBasic(role), normalizeCompany(representedEntity)].join('|');
  }

  function scopedLegalEntityKey(name, taxNo) {
    return `${normalizeCompany(name)}|${taxNo || 'unknown-company'}`;
  }

  function getOrCreate(type, key, label, extra = {}) {
    const id = nodeId(type, key);
    let node = nodeMap.get(id);
    if (!node) {
      node = {
        id,
        type,
        key,
        label,
        x: 0,
        y: 0,
        targetX: 0,
        targetY: 0,
        vx: 0,
        vy: 0,
        pinned: false,
        ...extra,
      };
      nodeMap.set(id, node);
    } else {
      Object.assign(node, extra);
      if (label) node.label = label;
    }
    return node;
  }

  function getOrCreateEdge(source, target, label, extra = {}) {
    const key = `${source}→${target}:${label}`;
    const certainty = extra.certainty || (extra.uncertain ? 'suspected' : 'confirmed');
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { key, source, target, label, certainty, uncertain: certainty !== 'confirmed', ...extra };
      edgeMap.set(key, edge);
    } else {
      Object.assign(edge, extra, { certainty, uncertain: certainty !== 'confirmed' });
    }
    return edge;
  }

  function addAddress(companyNode, address) {
    if (!address) return;
    const addressKey = normalizeAddress(address);
    if (!addressKey) return;
    const addressNode = getOrCreate('address', addressKey, address, {
      fullAddress: address,
      expandMode: 'address',
    });
    getOrCreateEdge(companyNode.id, addressNode.id, '地址');
  }

  function addCompany(data, directors = [], branches = []) {
    if (!canvas || !data) return;
    const taxNo = String(data.Business_Accounting_NO || '').trim();
    const name = data.Company_Name || taxNo || '未知公司';
    const companyKey = taxNo || `name:${normalizeCompany(name)}`;

    const companyNode = getOrCreate('company', companyKey, name, {
      taxNo,
      fullData: data,
      expandMode: 'company',
      isBranch: false,
    });

    // addCompany 只會用於使用者載入的完整公司，因此將其設為目前圖形主體。
    rootNodeId = companyNode.id;
    selectedNodeId = null;
    viewMode = 'overview';

    const responsible = data.Responsible_Name;
    if (responsible) {
      const personNode = getOrCreate(
        'person',
        scopedPersonKey(responsible, taxNo, '代表人'),
        responsible,
        {
          role: '代表人',
          personName: responsible,
          companyTaxNo: taxNo,
          expandMode: 'person',
          identityStatus: 'name-only',
        }
      );
      getOrCreateEdge(companyNode.id, personNode.id, '代表人');
    }

    addAddress(companyNode, data.Company_Location || data.Company_Address || '');

    directors.forEach(director => {
      const personName = director.Name;
      const role = director.Title || '董事';
      if (!personName || personName === '—') return;

      const representedEntity = director.Representative_Name || '';
      if (representedEntity && representedEntity !== personName) {
        const legalNode = getOrCreate(
          'legalEntity',
          scopedLegalEntityKey(representedEntity, taxNo),
          representedEntity,
          {
            role,
            entityName: representedEntity,
            companyTaxNo: taxNo,
            expandMode: 'legalEntity',
          }
        );
        getOrCreateEdge(companyNode.id, legalNode.id, role);

        const representativeNode = getOrCreate(
          'person',
          scopedPersonKey(personName, taxNo, '法人代表', representedEntity),
          personName,
          {
            role: '法人代表',
            personName,
            companyTaxNo: taxNo,
            representedEntity,
            expandMode: 'person',
            identityStatus: 'name-only',
          }
        );
        getOrCreateEdge(legalNode.id, representativeNode.id, '法人代表');
      } else {
        const personNode = getOrCreate(
          'person',
          scopedPersonKey(personName, taxNo, role),
          personName,
          {
            role,
            personName,
            companyTaxNo: taxNo,
            expandMode: 'person',
            identityStatus: 'name-only',
          }
        );
        getOrCreateEdge(companyNode.id, personNode.id, role);
      }
    });

    branches.forEach(branch => {
      const branchTaxNo = String(branch.Branch_Office_Business_Accounting_NO || '').trim();
      const branchName = branch.Branch_Office_Name || branchTaxNo;
      if (!branchTaxNo || !branchName) return;
      const branchNode = getOrCreate('company', branchTaxNo, branchName, {
        taxNo: branchTaxNo,
        isBranch: true,
        expandMode: 'company',
      });
      getOrCreateEdge(companyNode.id, branchNode.id, '分公司');
    });

    showGraph();
    refreshView({ fit: true, animate: true });
  }

  /**
   * 依任何公司登記人員姓名建立查詢群組。
   * 每一筆角色來自官方登記，但跨公司是否為同一自然人仍屬待確認。
   */
  function addPersonMatchGroup(name, companies = []) {
    if (!canvas || !name) return;
    const matchNode = getOrCreate(
      'person',
      `person-search:${normalizePerson(name)}`,
      name,
      {
        role: '公司登記人員（同名待確認）',
        personName: name,
        expandMode: 'person-match-group',
        identityStatus: 'unverified-name-match',
        uncertain: true,
      }
    );

    if (!rootNodeId) {
      rootNodeId = matchNode.id;
      viewMode = 'overview';
    }

    companies.forEach(company => {
      const taxNo = String(company.Business_Accounting_NO || '').trim();
      const companyName = company.Company_Name || taxNo || '未知公司';
      const companyKey = taxNo || `name:${normalizeCompany(companyName)}`;
      const companyNode = getOrCreate('company', companyKey, companyName, {
        taxNo,
        fullData: company,
        expandMode: 'company',
        isBranch: false,
      });
      const roles = [...new Set((company._matchRoles || ['登記人員']).filter(Boolean))];
      const label = roles.length > 0 ? roles.join('／') : '登記人員';
      getOrCreateEdge(companyNode.id, matchNode.id, label, {
        certainty: 'suspected',
        matchRoles: roles,
      });
      addAddress(companyNode, company.Company_Location || company.Company_Address || '');
    });

    showGraph();
    refreshView({ fit: true, animate: true });
  }

  const addNameMatchGroup = addPersonMatchGroup;

  /**
   * 依地址查詢建立群組。完整正規化地址相同列為已確認；部分相符列為疑似。
   */
  function addAddressMatchGroup(address, companies = []) {
    if (!canvas || !address) return;
    const queryKey = normalizeAddress(address);
    if (!queryKey) return;

    const addressNode = getOrCreate('address', `address-search:${queryKey}`, address, {
      fullAddress: address,
      expandMode: 'address-search-group',
      searchAddress: address,
    });

    if (!rootNodeId) {
      rootNodeId = addressNode.id;
      viewMode = 'overview';
    }

    companies.forEach(company => {
      const taxNo = String(company.Business_Accounting_NO || '').trim();
      const companyName = company.Company_Name || taxNo || '未知公司';
      const companyKey = taxNo || `name:${normalizeCompany(companyName)}`;
      const companyNode = getOrCreate('company', companyKey, companyName, {
        taxNo,
        fullData: company,
        expandMode: 'company',
        isBranch: false,
      });
      const registeredAddress = company.Company_Location || company.Company_Address || company._matchedAddress || '';
      const exact = Boolean(registeredAddress && normalizeAddress(registeredAddress) === queryKey);
      getOrCreateEdge(companyNode.id, addressNode.id, exact ? '同一登記地址' : '地址相符', {
        certainty: exact ? 'confirmed' : 'suspected',
        registeredAddress,
      });
    });

    showGraph();
    refreshView({ fit: true, animate: true });
  }

  function showGraph() {
    const empty = byId(emptyId);
    if (empty) empty.style.display = 'none';
  }

  function clear() {
    nodeMap.clear();
    edgeMap.clear();
    visibleNodes = [];
    visibleEdges = [];
    visibleNodeMap.clear();
    rootNodeId = null;
    selectedNodeId = null;
    hoveredNode = null;
    viewMode = 'overview';
    panX = 0;
    panY = 0;
    scale = 1;
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    simTick = 0;
    const empty = byId(emptyId);
    if (empty) empty.style.display = 'flex';
    updateInfo();
    updateModeControls();
    draw();
  }

  function getStats() {
    let confirmedEdges = 0;
    let suspectedEdges = 0;
    edgeMap.forEach(edge => {
      if (edge.certainty === 'suspected' || edge.uncertain) suspectedEdges++;
      else confirmedEdges++;
    });
    return {
      nodes: nodeMap.size,
      edges: edgeMap.size,
      confirmedEdges,
      suspectedEdges,
      visibleNodes: visibleNodes.filter(node => !node.virtual).length,
      summaryNodes: visibleNodes.filter(node => node.virtual).length,
      displayNodes: visibleNodes.length,
      visibleEdges: visibleEdges.filter(edge => !edge.virtual).length,
      mode: viewMode,
      animating: Boolean(animFrame),
    };
  }

  function emitStatsChanged() {
    if (!canvas) return;
    canvas.dispatchEvent(new CustomEvent('graphStatsChanged', { detail: getStats() }));
  }

  function categoryOf(node) {
    if (!node) return '';
    if (node.type === 'company') return 'companies';
    if (node.type === 'person') return 'people';
    if (node.type === 'legalEntity') return 'legal';
    if (node.type === 'address') return 'address';
    return '';
  }

  function categoryCounts() {
    const counts = { companies: 0, people: 0, legal: 0, address: 0 };
    nodeMap.forEach(node => {
      if (node.id === rootNodeId) return;
      const category = categoryOf(node);
      if (category) counts[category]++;
    });
    return counts;
  }

  function updateInfo() {
    const info = byId(infoId);
    const stats = getStats();
    if (info) {
      if (nodeMap.size === 0) {
        info.textContent = '';
      } else {
        const counts = { company: 0, branch: 0, person: 0, address: 0, legalEntity: 0 };
        nodeMap.forEach(node => {
          if (node.type === 'company') {
            if (node.isBranch) counts.branch++;
            else counts.company++;
          } else if (Object.prototype.hasOwnProperty.call(counts, node.type)) {
            counts[node.type]++;
          }
        });
        const visibleText = stats.summaryNodes > 0
          ? `顯示 ${stats.visibleNodes} 個資料節點＋${stats.summaryNodes} 個分類摘要`
          : `顯示 ${stats.visibleNodes}/${nodeMap.size} 個節點`;
        info.textContent = `${MODE_LABELS[viewMode]}模式｜${visibleText}｜公司 ${counts.company}｜分公司 ${counts.branch}｜人員 ${counts.person}｜法人 ${counts.legalEntity}｜地址 ${counts.address}｜已確認 ${stats.confirmedEdges}｜疑似 ${stats.suspectedEdges}`;
      }
    }
    emitStatsChanged();
  }

  function setMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(MODE_LABELS, mode)) return;
    viewMode = mode;
    selectedNodeId = null;
    hoveredNode = null;
    nodeMap.forEach(node => { node.pinned = false; });
    refreshView({ fit: true, animate: true });
  }

  function resetFocus() {
    selectedNodeId = null;
    hoveredNode = null;
    hideTooltip();
    updateModeControls();
    draw();
  }

  function updateModeControls() {
    const modeBar = byId(modeBarId);
    const counts = categoryCounts();
    if (modeBar) {
      modeBar.querySelectorAll('[data-graph-mode]').forEach(button => {
        const mode = button.dataset.graphMode;
        button.classList.toggle('active', mode === viewMode);
        if (mode === 'companies') button.disabled = counts.companies === 0;
        else if (mode === 'people') button.disabled = counts.people === 0;
        else if (mode === 'legal') button.disabled = counts.legal === 0;
        else if (mode === 'address') button.disabled = counts.address === 0;
        else button.disabled = nodeMap.size === 0;
      });
    }
    const focusButton = byId(focusButtonId);
    if (focusButton) focusButton.disabled = !selectedNodeId;
  }

  function refreshView({ fit = false, animate = true } = {}) {
    buildVisibleGraph();
    rebuildLayout();
    updateInfo();
    updateModeControls();
    if (fit) {
      fitToView(false);
      pendingFit = true;
    }
    if (animate) startSim(120);
    else {
      visibleNodes.forEach(node => {
        node.x = node.targetX;
        node.y = node.targetY;
        node.vx = 0;
        node.vy = 0;
      });
      if (fit) fitToView(false);
      draw();
    }
  }

  function buildVisibleGraph() {
    const root = nodeMap.get(rootNodeId) || nodeMap.values().next().value || null;
    if (root && !rootNodeId) rootNodeId = root.id;

    if (!root) {
      visibleNodes = [];
      visibleEdges = [];
      visibleNodeMap = new Map();
      return;
    }

    if (viewMode === 'overview') {
      const counts = categoryCounts();
      const summaries = CATEGORY_ORDER
        .filter(category => counts[category] > 0)
        .map(category => createSummaryNode(category, counts[category]));
      visibleNodes = [root, ...summaries];
      visibleEdges = summaries.map(summary => ({
        key: `${root.id}→${summary.id}`,
        source: root.id,
        target: summary.id,
        label: summary.edgeLabel,
        certainty: 'confirmed',
        virtual: true,
      }));
      visibleNodeMap = new Map(visibleNodes.map(node => [node.id, node]));
      return;
    }

    if (viewMode === 'all') {
      visibleNodes = [...nodeMap.values()];
      visibleEdges = [...edgeMap.values()];
      visibleNodeMap = new Map(visibleNodes.map(node => [node.id, node]));
      return;
    }

    const includeIds = collectCategoryPaths(root.id, viewMode);
    includeIds.add(root.id);
    visibleNodes = [...includeIds].map(id => nodeMap.get(id)).filter(Boolean);
    visibleNodeMap = new Map(visibleNodes.map(node => [node.id, node]));
    visibleEdges = [...edgeMap.values()].filter(edge => includeIds.has(edge.source) && includeIds.has(edge.target));
  }

  function createSummaryNode(category, count) {
    const root = nodeMap.get(rootNodeId);
    const companyNodes = [...nodeMap.values()].filter(node => node.type === 'company' && node.id !== rootNodeId);
    const branchCount = companyNodes.filter(node => node.isBranch).length;
    const relatedCompanyCount = companyNodes.length - branchCount;
    let title;
    let edgeLabel;

    if (category === 'companies') {
      if (branchCount > 0 && relatedCompanyCount === 0) title = '分公司';
      else if (branchCount > 0) title = '公司／分公司';
      else title = root?.type === 'person' || root?.type === 'address' ? '關聯公司' : '公司關聯';
      edgeLabel = '公司關聯';
    } else if (category === 'people') {
      title = '登記人員';
      edgeLabel = '人員關聯';
    } else if (category === 'legal') {
      title = '法人關係';
      edgeLabel = '法人關聯';
    } else {
      title = '地址關係';
      edgeLabel = '地址關聯';
    }

    return {
      id: `summary:${category}`,
      type: 'summary',
      category,
      summaryMode: category,
      label: `${title}\n${count}`,
      title,
      count,
      edgeLabel,
      virtual: true,
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  }

  function collectCategoryPaths(rootId, category) {
    const adjacency = new Map();
    nodeMap.forEach((_, id) => adjacency.set(id, []));
    edgeMap.forEach(edge => {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
      adjacency.get(edge.source).push(edge.target);
      adjacency.get(edge.target).push(edge.source);
    });

    const queue = [rootId];
    const parent = new Map([[rootId, null]]);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const next of adjacency.get(current) || []) {
        if (parent.has(next)) continue;
        parent.set(next, current);
        queue.push(next);
      }
    }

    const targetIds = [...nodeMap.values()]
      .filter(node => node.id !== rootId && categoryOf(node) === category)
      .map(node => node.id);

    const include = new Set([rootId]);
    targetIds.forEach(targetId => {
      if (!parent.has(targetId)) {
        include.add(targetId);
        return;
      }
      let cursor = targetId;
      while (cursor) {
        include.add(cursor);
        cursor = parent.get(cursor);
      }
    });
    return include;
  }

  function rebuildLayout() {
    if (!visibleNodes.length) return;
    const root = visibleNodeMap.get(rootNodeId) || visibleNodes[0];
    if (root) setTarget(root, 0, 0);

    if (viewMode === 'overview') {
      layoutOverview(root);
    } else if (viewMode === 'all') {
      layoutAll(root);
    } else {
      layoutCategory(root, viewMode);
    }
  }

  function setTarget(node, x, y) {
    node.targetX = x;
    node.targetY = y;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      node.x = x;
      node.y = y;
    }
  }

  function layoutOverview(root) {
    const positions = {
      companies: { x: 330, y: 0 },
      people: { x: -300, y: -160 },
      legal: { x: -300, y: 160 },
      address: { x: 0, y: 280 },
    };
    visibleNodes.forEach(node => {
      if (node === root) return;
      const position = positions[node.category] || { x: 280, y: 0 };
      setTarget(node, position.x, position.y);
    });
  }

  function layoutAll(root) {
    const groups = {
      companies: [],
      people: [],
      legal: [],
      address: [],
    };
    visibleNodes.forEach(node => {
      if (node === root) return;
      const category = categoryOf(node);
      if (groups[category]) groups[category].push(node);
    });

    // 公司／分公司置於右側，人員置於左上，法人置於左下，地址置於下方。
    placeGrid(groups.companies, { centerX: 420, centerY: 0, columns: maxColumns(groups.companies.length, 4), gapX: 200, gapY: 88 });
    placeGrid(groups.people, { centerX: -390, centerY: -260, columns: maxColumns(groups.people.length, 4), gapX: 100, gapY: 92 });
    placeGrid(groups.legal, { centerX: -390, centerY: 230, columns: maxColumns(groups.legal.length, 3), gapX: 190, gapY: 88 });
    placeGrid(groups.address, { centerX: 0, centerY: 390, columns: maxColumns(groups.address.length, 3), gapX: 230, gapY: 82 });
  }

  function layoutCategory(root, category) {
    const targetNodes = visibleNodes.filter(node => node !== root && categoryOf(node) === category);
    const connectorNodes = visibleNodes.filter(node => node !== root && categoryOf(node) !== category);

    setTarget(root, -330, 0);
    placeGrid(targetNodes, {
      centerX: 260,
      centerY: 0,
      columns: maxColumns(targetNodes.length, category === 'people' ? 5 : 4),
      gapX: category === 'people' ? 110 : 205,
      gapY: category === 'people' ? 92 : 84,
    });
    placeGrid(connectorNodes, {
      centerX: -40,
      centerY: 0,
      columns: Math.min(2, Math.max(1, connectorNodes.length)),
      gapX: 150,
      gapY: 96,
    });
  }

  function maxColumns(count, preferred) {
    if (count <= 0) return 1;
    return Math.max(1, Math.min(preferred, Math.ceil(Math.sqrt(count))));
  }

  function placeGrid(nodes, { centerX, centerY, columns, gapX, gapY }) {
    if (!nodes.length) return;
    const cols = Math.max(1, Math.min(columns, nodes.length));
    const rows = Math.ceil(nodes.length / cols);
    nodes.forEach((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const rowCount = Math.min(cols, nodes.length - row * cols);
      const x = centerX + (col - (rowCount - 1) / 2) * gapX;
      const y = centerY + (row - (rows - 1) / 2) * gapY;
      setTarget(node, x, y);
    });
  }

  function startSim(ticks = 100) {
    simTick = Math.max(simTick, ticks);
    if (!animFrame) animFrame = requestAnimationFrame(loop);
  }

  function loop() {
    if (simTick <= 0) {
      animFrame = null;
      if (pendingFit) {
        pendingFit = false;
        fitToView(false);
      }
      draw();
      return;
    }

    const energy = simulate();
    simTick--;
    draw();

    const stableThreshold = Math.max(0.12, visibleNodes.length * 0.025);
    if (!isDragging && energy < stableThreshold) simTick = 0;

    if (simTick > 0) animFrame = requestAnimationFrame(loop);
    else {
      animFrame = null;
      if (pendingFit) {
        pendingFit = false;
        fitToView(false);
      }
      draw();
    }
  }

  function simulate() {
    let energy = 0;
    const movable = visibleNodes.filter(node => !node.virtual || true);

    movable.forEach(node => {
      if (node === dragNode || node.pinned) return;
      node.vx += (node.targetX - node.x) * 0.075;
      node.vy += (node.targetY - node.y) * 0.075;
    });

    // 只做近距離碰撞排斥，避免不同形狀互相重疊；分類位置仍由 target 決定。
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        const a = movable[i];
        const b = movable[j];
        const ga = getNodeGeometry(a);
        const gb = getNodeGeometry(b);
        const minDistance = collisionRadius(ga) + collisionRadius(gb) + 12;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (!distance) {
          dx = 1;
          dy = 0;
          distance = 1;
        }
        if (distance >= minDistance) continue;
        const push = (minDistance - distance) * 0.035;
        const ux = dx / distance;
        const uy = dy / distance;
        if (a !== dragNode && !a.pinned) {
          a.vx -= ux * push;
          a.vy -= uy * push;
        }
        if (b !== dragNode && !b.pinned) {
          b.vx += ux * push;
          b.vy += uy * push;
        }
      }
    }

    movable.forEach(node => {
      if (node === dragNode) return;
      node.vx *= 0.7;
      node.vy *= 0.7;
      node.x += node.vx;
      node.y += node.vy;
      energy += Math.abs(node.vx) + Math.abs(node.vy);
    });
    return energy;
  }

  function collisionRadius(geometry) {
    if (geometry.shape === 'circle') return geometry.radius;
    return Math.sqrt(geometry.width * geometry.width + geometry.height * geometry.height) * 0.36;
  }

  function cssWidth() {
    return canvas?._cssWidth || canvas?.clientWidth || 1;
  }

  function cssHeight() {
    return canvas?._cssHeight || canvas?.clientHeight || 1;
  }

  function worldToScreen(x, y) {
    return { sx: x * scale + panX, sy: y * scale + panY };
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - panX) / scale, y: (sy - panY) / scale };
  }

  function fitToView(redraw = true) {
    if (!canvas || !visibleNodes.length) return;
    const bounds = calculateBounds(true);
    const padding = 54;
    const availableWidth = Math.max(100, cssWidth() - padding * 2);
    const availableHeight = Math.max(100, cssHeight() - padding * 2);
    const width = Math.max(100, bounds.maxX - bounds.minX);
    const height = Math.max(100, bounds.maxY - bounds.minY);
    scale = clamp(Math.min(availableWidth / width, availableHeight / height), 0.18, 1.25);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    panX = cssWidth() / 2 - centerX * scale;
    panY = cssHeight() / 2 - centerY * scale;
    if (redraw) draw();
  }

  function calculateBounds(useTargets = false) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    visibleNodes.forEach(node => {
      const geometry = getNodeGeometry(node);
      const x = useTargets ? node.targetX : node.x;
      const y = useTargets ? node.targetY : node.y;
      const halfWidth = geometry.shape === 'circle' ? geometry.radius : geometry.width / 2;
      const halfHeight = geometry.shape === 'circle' ? geometry.radius : geometry.height / 2;
      minX = Math.min(minX, x - halfWidth);
      maxX = Math.max(maxX, x + halfWidth);
      minY = Math.min(minY, y - halfHeight);
      maxY = Math.max(maxY, y + halfHeight);
    });
    return { minX, minY, maxX, maxY };
  }

  function draw() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, cssWidth(), cssHeight());
    drawDots();
    visibleEdges.forEach(drawEdge);
    visibleNodes.forEach(drawNode);
  }

  function themeColor(variableName, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
      return value || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function drawDots() {
    ctx.save();
    ctx.fillStyle = themeColor('--graph-dot', 'rgba(17,17,17,0.07)');
    const spacing = Math.max(12, 42 * scale);
    const offsetX = ((panX % spacing) + spacing) % spacing;
    const offsetY = ((panY % spacing) + spacing) % spacing;
    for (let x = offsetX; x < cssWidth(); x += spacing) {
      for (let y = offsetY; y < cssHeight(); y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function activeNodeId() {
    return hoveredNode?.id || selectedNodeId || null;
  }

  function relatedNodeIds(activeId) {
    const ids = new Set(activeId ? [activeId] : []);
    if (!activeId) return ids;
    visibleEdges.forEach(edge => {
      if (edge.source === activeId) ids.add(edge.target);
      if (edge.target === activeId) ids.add(edge.source);
    });
    return ids;
  }

  function drawEdge(edge) {
    const source = visibleNodeMap.get(edge.source);
    const target = visibleNodeMap.get(edge.target);
    if (!source || !target) return;

    const activeId = activeNodeId();
    const isActive = !activeId || edge.source === activeId || edge.target === activeId;
    const suspected = edge.certainty === 'suspected' || edge.uncertain;
    const color = EDGE_COLOR[edge.label] || EDGE_COLOR.default;
    const endpoints = edgeEndpoints(source, target);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = activeId ? (isActive ? 0.9 : 0.09) : (suspected ? 0.62 : 0.38);
    ctx.lineWidth = activeId && isActive ? 2.4 : (suspected ? 2 : 1.5);
    ctx.setLineDash(suspected ? [5, 7] : []);
    ctx.beginPath();
    ctx.moveTo(endpoints.x1, endpoints.y1);
    ctx.lineTo(endpoints.x2, endpoints.y2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 線條名稱預設隱藏，只有選取或滑入相關節點時顯示。
    if (activeId && isActive && scale >= 0.35) {
      const middleX = (endpoints.x1 + endpoints.x2) / 2;
      const middleY = (endpoints.y1 + endpoints.y2) / 2;
      const fontSize = clamp(Math.round(12 * Math.min(scale, 1.15)), 10, 13);
      ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
      const textWidth = ctx.measureText(edge.label).width + 12;
      ctx.globalAlpha = 0.98;
      ctx.fillStyle = themeColor('--edge-label-bg', 'rgba(255,255,255,0.96)');
      roundedRectPath(ctx, middleX - textWidth / 2, middleY - fontSize, textWidth, fontSize * 2, 5);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#111111';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(edge.label, middleX, middleY);
    }
    ctx.restore();
  }

  function edgeEndpoints(source, target) {
    const sourceGeometry = getNodeGeometry(source);
    const targetGeometry = getNodeGeometry(target);
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const angle = Math.atan2(dy, dx);
    const sourceRadius = boundaryDistance(sourceGeometry, angle);
    const targetRadius = boundaryDistance(targetGeometry, angle + Math.PI);
    const sourcePoint = worldToScreen(source.x + Math.cos(angle) * sourceRadius, source.y + Math.sin(angle) * sourceRadius);
    const targetPoint = worldToScreen(target.x - Math.cos(angle) * targetRadius, target.y - Math.sin(angle) * targetRadius);
    return { x1: sourcePoint.sx, y1: sourcePoint.sy, x2: targetPoint.sx, y2: targetPoint.sy };
  }

  function boundaryDistance(geometry, angle) {
    if (geometry.shape === 'circle') return geometry.radius;
    const halfWidth = geometry.width / 2;
    const halfHeight = geometry.height / 2;
    const cos = Math.abs(Math.cos(angle)) || 0.0001;
    const sin = Math.abs(Math.sin(angle)) || 0.0001;
    return Math.min(halfWidth / cos, halfHeight / sin);
  }

  function displayLabel(node) {
    const raw = String(node.label || '').trim();
    if (node.type === 'summary') return raw;
    if (node.type === 'company') {
      return raw
        .replace(/股份有限公司/g, '')
        .replace(/有限公司/g, '')
        .replace(/股份公司/g, '')
        .replace(/有限合夥/g, '')
        .trim() || raw;
    }
    return raw;
  }

  function getNodeGeometry(node) {
    const label = displayLabel(node);
    if (node.type === 'person') {
      const measured = measureLabel(label, 15);
      const radius = clamp(measured / 2 + 16, 30, 43);
      return { shape: 'circle', radius, width: radius * 2, height: radius * 2, styleKey: 'person', maxLines: 2, maxFont: 16, minFont: 10 };
    }
    if (node.type === 'summary') {
      return { shape: 'circle', radius: 49, width: 98, height: 98, styleKey: 'summary', maxLines: 2, maxFont: 16, minFont: 11 };
    }
    if (node.type === 'address') {
      const width = clamp(measureLabel(label, 13) + 34, 160, 245);
      return { shape: 'capsule', width, height: 62, radius: 18, styleKey: 'address', maxLines: 3, maxFont: 14, minFont: 9 };
    }
    if (node.type === 'legalEntity') {
      const width = clamp(measureLabel(label, 14) + 34, 130, 205);
      return { shape: 'hex', width, height: 66, radius: 12, styleKey: 'legalEntity', maxLines: 3, maxFont: 15, minFont: 10 };
    }
    if (node.type === 'company') {
      const isRoot = node.id === rootNodeId;
      const isBranch = Boolean(node.isBranch);
      const minWidth = isRoot ? 175 : (isBranch ? 115 : 130);
      const maxWidth = isRoot ? 245 : (isBranch ? 180 : 205);
      const width = clamp(measureLabel(label, isRoot ? 16 : 14) + 38, minWidth, maxWidth);
      const height = isRoot ? 82 : (isBranch ? 60 : 66);
      return {
        shape: 'roundRect',
        width,
        height,
        radius: isRoot ? 16 : 12,
        styleKey: isBranch ? 'branch' : 'company',
        maxLines: isRoot ? 3 : 3,
        maxFont: isRoot ? 18 : 15,
        minFont: isRoot ? 11 : 9,
      };
    }
    return { shape: 'roundRect', width: 150, height: 62, radius: 12, styleKey: 'company', maxLines: 3, maxFont: 15, minFont: 9 };
  }

  function measureLabel(label, fontSize) {
    if (!ctx) return String(label || '').length * fontSize;
    ctx.save();
    ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
    const width = ctx.measureText(String(label || '')).width;
    ctx.restore();
    return width;
  }

  function drawNode(node) {
    const { sx, sy } = worldToScreen(node.x, node.y);
    const geometry = getNodeGeometry(node);
    const style = NODE_STYLE[geometry.styleKey] || NODE_STYLE.company;
    const isHovered = node === hoveredNode;
    const isSelected = node.id === selectedNodeId;
    const isRoot = node.id === rootNodeId;
    const activeId = activeNodeId();
    const related = relatedNodeIds(activeId);
    const isRelated = !activeId || related.has(node.id);

    ctx.save();
    ctx.globalAlpha = isRelated ? 1 : 0.16;
    if (isHovered || isSelected || isRoot) {
      ctx.shadowColor = style.stroke;
      ctx.shadowBlur = isRoot ? 15 : 11;
    }

    drawShapePath(sx, sy, geometry);
    ctx.fillStyle = isHovered || isSelected ? style.fillStrong : style.fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = isRoot ? 3.2 : (isSelected ? 3 : 2);
    if (node.uncertain) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isRoot && node.type === 'company') {
      ctx.fillStyle = style.stroke;
      ctx.font = `700 10px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const badge = '查詢主體';
      const badgeWidth = ctx.measureText(badge).width + 14;
      const top = sy - geometry.height * scale / 2 - 9;
      roundedRectPath(ctx, sx - badgeWidth / 2, top - 9, badgeWidth, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(badge, sx, top);
    }

    if (shouldShowNodeLabel(node)) {
      drawAdaptiveLabel(node, sx, sy, geometry, style.text);
    }
    ctx.restore();
  }

  function shouldShowNodeLabel(node) {
    if (node.id === rootNodeId || node.type === 'summary' || node.id === selectedNodeId || node === hoveredNode) return true;
    return scale >= 0.58;
  }

  function drawAdaptiveLabel(node, sx, sy, geometry, color) {
    const label = displayLabel(node);
    if (!label) return;
    const fitted = node.type === 'summary'
      ? { lines: [node.title, String(node.count)], fontSize: 15, lineHeight: 19, truncated: false }
      : fitTextToGeometry(label, geometry);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fitted.fontSize * Math.min(scale, 1.08)}px ${FONT_FAMILY}`;
    const lineHeight = fitted.lineHeight * Math.min(scale, 1.08);
    const totalHeight = lineHeight * fitted.lines.length;
    fitted.lines.forEach((line, index) => {
      ctx.fillText(line, sx, sy - totalHeight / 2 + lineHeight * (index + 0.5));
    });
  }

  function fitTextToGeometry(text, geometry) {
    const maxLines = geometry.maxLines || 3;
    for (let fontSize = geometry.maxFont; fontSize >= geometry.minFont; fontSize--) {
      ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
      const lineHeight = fontSize * 1.24;
      const possibleLines = Math.min(maxLines, Math.max(1, Math.floor((geometry.height - 14) / lineHeight)));
      for (let lineCount = 1; lineCount <= possibleLines; lineCount++) {
        const widths = lineWidthsForGeometry(geometry, lineCount, lineHeight);
        const lines = balancedWrap(text, widths);
        if (lines) return { lines, fontSize, lineHeight, truncated: false };
      }
    }

    const fontSize = geometry.minFont;
    ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
    const lineHeight = fontSize * 1.24;
    const lineCount = Math.min(maxLines, Math.max(1, Math.floor((geometry.height - 12) / lineHeight)));
    const widths = lineWidthsForGeometry(geometry, lineCount, lineHeight);
    return {
      lines: truncateWrap(text, widths),
      fontSize,
      lineHeight,
      truncated: true,
    };
  }

  function lineWidthsForGeometry(geometry, lineCount, lineHeight) {
    if (geometry.shape !== 'circle') {
      return Array(lineCount).fill(Math.max(24, geometry.width - 24));
    }
    const innerRadius = geometry.radius - 8;
    const totalHeight = lineCount * lineHeight;
    return Array.from({ length: lineCount }, (_, index) => {
      const yOffset = -totalHeight / 2 + lineHeight * (index + 0.5);
      return Math.max(18, 2 * Math.sqrt(Math.max(0, innerRadius * innerRadius - yOffset * yOffset)) - 6);
    });
  }

  function balancedWrap(text, widths) {
    const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
    if (!chars.length) return [''];
    const memo = new Map();

    function solve(index, lineIndex) {
      const key = `${index}:${lineIndex}`;
      if (memo.has(key)) return memo.get(key);
      if (index >= chars.length) return { lines: [], score: 0 };
      if (lineIndex >= widths.length) return null;

      let best = null;
      let piece = '';
      for (let end = index; end < chars.length; end++) {
        piece += chars[end];
        const measured = ctx.measureText(piece).width;
        if (measured > widths[lineIndex]) break;
        const rest = solve(end + 1, lineIndex + 1);
        if (!rest) continue;
        const unused = widths[lineIndex] - measured;
        const lastLine = end === chars.length - 1;
        const penalty = lastLine ? unused * unused * 0.08 : unused * unused;
        const score = penalty + rest.score;
        if (!best || score < best.score) {
          best = { lines: [piece.trim(), ...rest.lines], score };
        }
      }
      memo.set(key, best);
      return best;
    }

    return solve(0, 0)?.lines || null;
  }

  function truncateWrap(text, widths) {
    const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
    const lines = [];
    let cursor = 0;
    widths.forEach((width, index) => {
      if (cursor >= chars.length) return;
      const isLast = index === widths.length - 1;
      let line = '';
      while (cursor < chars.length) {
        const suffix = isLast && cursor < chars.length - 1 ? '…' : '';
        const candidate = line + chars[cursor] + suffix;
        if (ctx.measureText(candidate).width > width) break;
        line += chars[cursor];
        cursor++;
      }
      if (isLast && cursor < chars.length) {
        while (line && ctx.measureText(`${line}…`).width > width) line = line.slice(0, -1);
        line = `${line}…`;
        cursor = chars.length;
      }
      lines.push(line || '…');
    });
    return lines;
  }

  function drawShapePath(sx, sy, geometry) {
    const width = geometry.width * scale;
    const height = geometry.height * scale;
    if (geometry.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(sx, sy, geometry.radius * scale, 0, Math.PI * 2);
      return;
    }
    if (geometry.shape === 'hex') {
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      const inset = Math.min(18 * scale, width * 0.16);
      ctx.beginPath();
      ctx.moveTo(sx - halfWidth + inset, sy - halfHeight);
      ctx.lineTo(sx + halfWidth - inset, sy - halfHeight);
      ctx.lineTo(sx + halfWidth, sy);
      ctx.lineTo(sx + halfWidth - inset, sy + halfHeight);
      ctx.lineTo(sx - halfWidth + inset, sy + halfHeight);
      ctx.lineTo(sx - halfWidth, sy);
      ctx.closePath();
      return;
    }
    const radius = geometry.shape === 'capsule' ? height / 2 : geometry.radius * scale;
    roundedRectPath(ctx, sx - width / 2, sy - height / 2, width, height, radius);
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function mousePosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nodeAt(screenX, screenY) {
    const world = screenToWorld(screenX, screenY);
    for (let index = visibleNodes.length - 1; index >= 0; index--) {
      const node = visibleNodes[index];
      const geometry = getNodeGeometry(node);
      const dx = world.x - node.x;
      const dy = world.y - node.y;
      if (geometry.shape === 'circle') {
        if (Math.sqrt(dx * dx + dy * dy) <= geometry.radius + 5) return node;
      } else if (Math.abs(dx) <= geometry.width / 2 + 5 && Math.abs(dy) <= geometry.height / 2 + 5) {
        return node;
      }
    }
    return null;
  }

  function onMouseDown(event) {
    const { x, y } = mousePosition(event);
    mouseDownPos = { x, y };
    const node = nodeAt(x, y);
    if (node) {
      isDragging = true;
      dragNode = node;
      const world = screenToWorld(x, y);
      dragOffX = node.x - world.x;
      dragOffY = node.y - world.y;
      node.vx = 0;
      node.vy = 0;
      startSim(60);
    } else {
      panStart = { x, y, px: panX, py: panY };
    }
  }

  function onMouseMove(event) {
    const { x, y } = mousePosition(event);
    if (isDragging && dragNode) {
      const world = screenToWorld(x, y);
      dragNode.x = world.x + dragOffX;
      dragNode.y = world.y + dragOffY;
      dragNode.targetX = dragNode.x;
      dragNode.targetY = dragNode.y;
      dragNode.pinned = true;
      startSim(30);
      return;
    }

    if (panStart) {
      panX = panStart.px + (x - panStart.x);
      panY = panStart.py + (y - panStart.y);
      draw();
      return;
    }

    const node = nodeAt(x, y);
    if (node !== hoveredNode) {
      hoveredNode = node;
      canvas.style.cursor = node ? 'pointer' : 'grab';
      draw();
    }
    if (node) showTooltip(node, x, y);
    else hideTooltip();
  }

  function onMouseUp(event) {
    let clickedNode = null;
    let isClick = false;
    if (mouseDownPos && event.clientX !== undefined) {
      const { x, y } = mousePosition(event);
      isClick = Math.abs(x - mouseDownPos.x) < 5 && Math.abs(y - mouseDownPos.y) < 5;
      clickedNode = nodeAt(x, y);
    }

    if (isClick && clickedNode) {
      if (clickedNode.type === 'summary' && clickedNode.summaryMode) {
        setMode(clickedNode.summaryMode);
      } else {
        selectedNodeId = clickedNode.id;
        updateModeControls();
        draw();
        canvas.dispatchEvent(new CustomEvent('nodeClick', { detail: { ...clickedNode } }));
      }
    } else if (isClick && !clickedNode) {
      selectedNodeId = null;
      updateModeControls();
      draw();
    }

    isDragging = false;
    dragNode = null;
    panStart = null;
    mouseDownPos = null;
  }

  function onWheel(event) {
    event.preventDefault();
    const { x, y } = mousePosition(event);
    const delta = event.deltaY > 0 ? 0.88 : 1.14;
    const newScale = clamp(scale * delta, 0.15, 3.2);
    panX = x - (x - panX) * (newScale / scale);
    panY = y - (y - panY) * (newScale / scale);
    scale = newScale;
    draw();
  }

  function showTooltip(node, screenX, screenY) {
    let text = node.label;
    if (node.type === 'summary') {
      text = `${node.title}：${node.count}\n點擊展開此類別`;
    } else if (node.type === 'company') {
      if (node.isBranch) text += '\n類型：分公司';
      else text += '\n類型：公司';
      if (node.taxNo) text += `\n統編：${node.taxNo}`;
      text += '\n點擊載入公司詳細資料';
    } else if (node.type === 'person') {
      if (node.role) text += `\n角色：${node.role}`;
      if (node.expandMode === 'person-match-group') {
        text += '\n姓名與登記角色相符；跨公司是否為同一人仍待確認';
      } else {
        text += '\n點擊查詢此姓名的代表人、董事、監察人及經理人登記';
        text += '\n注意：姓名相同不代表同一人';
      }
    } else if (node.type === 'legalEntity') {
      text += '\n類型：法人\n點擊以法人名稱查詢公司';
    } else if (node.type === 'address') {
      text = node.fullAddress || node.label;
      text += '\n點擊查詢相同或相近登記地址的公司';
    }

    tooltip.textContent = text;
    const maxLeft = Math.max(8, cssWidth() - 320);
    const maxTop = Math.max(8, cssHeight() - 160);
    tooltip.style.left = `${Math.min(screenX + 14, maxLeft)}px`;
    tooltip.style.top = `${Math.min(Math.max(8, screenY - 14), maxTop)}px`;
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  function exportPNG() {
    if (!canvas) return;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.fillStyle = themeColor('--bg', '#ffffff');
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    exportCtx.drawImage(canvas, 0, 0);

    const link = document.createElement('a');
    link.download = exportFileName;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }

  return {
    init,
    addCompany,
    addNameMatchGroup,
    addPersonMatchGroup,
    addAddressMatchGroup,
    clear,
    exportPNG,
    getStats,
    setMode,
    fitToView,
    resetFocus,
  };
}

/**
 * 單一關聯圖管理器：兩個畫布建立不同 instance，但共用同一套繪圖與互動邏輯。
 */
const RelationGraphs = (() => {
  const instances = new Map();

  function create(name, options) {
    if (instances.has(name)) return instances.get(name);
    const graph = createRelationGraph(options);
    instances.set(name, graph);
    return graph;
  }

  function get(name) {
    return instances.get(name);
  }

  return { create, get };
})();

RelationGraphs.create('company', {
  canvasId: 'graphCanvas',
  emptyId: 'graphEmpty',
  infoId: 'graphInfo',
  exportFileName: 'company-relation-graph.png',
  modeBarId: 'graphModeBar',
  fitButtonId: 'fitGraphBtn',
  focusButtonId: 'resetGraphFocusBtn',
});

RelationGraphs.create('person', {
  canvasId: 'graphCanvas2',
  emptyId: 'graphEmpty2',
  infoId: 'graphInfo2',
  exportFileName: 'person-relation-graph.png',
  modeBarId: 'graphModeBar2',
  fitButtonId: 'fitGraphBtn2',
  focusButtonId: 'resetGraphFocusBtn2',
});
