/**
 * graph.js — Canvas 關聯圖引擎（力導向佈局）
 *
 * 第一階段資料正確性調整：
 * - 人員節點以「公司＋角色＋姓名」建立識別，不再把所有同名者直接合併。
 * - 地址使用完整正規化地址作為識別，不再只取前 20 個字。
 * - 依負責人姓名反查的結果，以「同名關聯（未確認同一人）」呈現。
 */

function createRelationGraph({ canvasId, emptyId, infoId, exportFileName }) {
  const NODE_CFG = {
    company:     { color: '#5b9cf6', dark: '#2a5aad', radius: 28 },
    person:      { color: '#e8c84a', dark: '#a88c20', radius: 22 },
    address:     { color: '#4ecb7a', dark: '#27834e', radius: 20 },
    legalEntity: { color: '#a07cf5', dark: '#6040b0', radius: 22 },
  };

  const EDGE_COLOR = {
    代表人: '#f0d060',
    董事長: '#f0d060',
    董事: '#7ab8ff',
    獨立董事: '#ff9f43',
    監察人: '#cc99ff',
    經理人: '#5dde8a',
    地址: '#5dde8a',
    法人代表: '#ff7043',
    分公司: '#aaccff',
    同名負責人: '#e8c84a',
    default: '#6878a8',
  };

  let canvas;
  let ctx;
  let tooltip;
  const nodeMap = new Map();
  const edgeMap = new Map();
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
  let hoveredNode = null;

  const REPULSION = 3500;
  const ATTRACTION = 0.035;
  const DAMPING = 0.72;
  const GRAVITY = 0.004;

  const byId = id => document.getElementById(id);
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

    resize();
    new ResizeObserver(resize).observe(canvas.parentElement);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', () => {
      onMouseUp({});
      hideTooltip();
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

    draw();
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
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
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      node = {
        id,
        type,
        key,
        label,
        x: centerX + (Math.random() - 0.5) * 220,
        y: centerY + (Math.random() - 0.5) * 220,
        vx: 0,
        vy: 0,
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
    });

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
          expandMode: 'responsible',
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
            expandMode: 'unsupported-person-role',
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
            expandMode: role.includes('經理') ? 'unsupported-manager-role' : 'unsupported-director-role',
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

    const empty = byId(emptyId);
    if (empty) empty.style.display = 'none';
    updateInfo();
    startSim();
  }

  /**
   * 依官方「負責人姓名」反查後建立的同名群組。
   * 此群組只代表姓名相符，不代表已確認為同一自然人。
   */
  function addNameMatchGroup(name, companies = []) {
    if (!canvas || !name) return;
    const matchNode = getOrCreate(
      'person',
      `name-match:${normalizePerson(name)}`,
      name,
      {
        role: '同名負責人（未確認同一人）',
        personName: name,
        expandMode: 'name-match-group',
        identityStatus: 'unverified-name-match',
        uncertain: true,
      }
    );

    companies.forEach(company => {
      const taxNo = String(company.Business_Accounting_NO || '').trim();
      const companyName = company.Company_Name || taxNo || '未知公司';
      const companyKey = taxNo || `name:${normalizeCompany(companyName)}`;
      const companyNode = getOrCreate('company', companyKey, companyName, {
        taxNo,
        fullData: company,
        expandMode: 'company',
      });
      getOrCreateEdge(companyNode.id, matchNode.id, '同名負責人', { certainty: 'suspected' });
      addAddress(companyNode, company.Company_Location || company.Company_Address || '');
    });

    const empty = byId(emptyId);
    if (empty) empty.style.display = 'none';
    updateInfo();
    startSim();
  }

  function clear() {
    nodeMap.clear();
    edgeMap.clear();
    panX = 0;
    panY = 0;
    scale = 1;
    hoveredNode = null;
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    simTick = 0;
    const empty = byId(emptyId);
    if (empty) empty.style.display = 'flex';
    updateInfo();
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
      animating: Boolean(animFrame),
    };
  }

  function emitStatsChanged() {
    if (!canvas) return;
    canvas.dispatchEvent(new CustomEvent('graphStatsChanged', { detail: getStats() }));
  }

  function updateInfo() {
    const info = byId(infoId);
    const stats = getStats();
    if (info) {
      if (nodeMap.size === 0) {
        info.textContent = '';
      } else {
        const counts = { company: 0, person: 0, address: 0, legalEntity: 0 };
        nodeMap.forEach(node => {
          if (Object.prototype.hasOwnProperty.call(counts, node.type)) counts[node.type]++;
        });
        info.textContent = `節點：${nodeMap.size}（公司 ${counts.company}｜人員 ${counts.person}｜法人 ${counts.legalEntity}｜地址 ${counts.address}）　連線：${edgeMap.size}（已確認 ${stats.confirmedEdges}｜疑似 ${stats.suspectedEdges}）`;
      }
    }
    emitStatsChanged();
  }

  function simulate() {
    if (nodeMap.size === 0) return 0;
    const nodeList = [...nodeMap.values()];
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i];
        const b = nodeList[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (distance * distance);
        a.vx -= (dx / distance) * force;
        a.vy -= (dy / distance) * force;
        b.vx += (dx / distance) * force;
        b.vy += (dy / distance) * force;
      }
    }

    edgeMap.forEach(edge => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - 160) * ATTRACTION;
      source.vx += (dx / distance) * force;
      source.vy += (dy / distance) * force;
      target.vx -= (dx / distance) * force;
      target.vy -= (dy / distance) * force;
    });

    let energy = 0;
    nodeList.forEach(node => {
      node.vx += (centerX - node.x) * GRAVITY;
      node.vy += (centerY - node.y) * GRAVITY;
      if (node === dragNode) return;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      energy += Math.abs(node.vx) + Math.abs(node.vy);
    });
    return energy;
  }

  function startSim(ticks = 250) {
    simTick = Math.max(simTick, ticks);
    if (!animFrame) animFrame = requestAnimationFrame(loop);
  }

  function loop() {
    if (simTick <= 0) {
      animFrame = null;
      draw();
      return;
    }

    const energy = simulate();
    simTick--;
    draw();

    // 圖形穩定後立即停止，避免畫面在背景持續耗用 CPU。
    const stableThreshold = Math.max(0.08, nodeMap.size * 0.015);
    if (!isDragging && energy < stableThreshold) simTick = 0;

    if (simTick > 0) animFrame = requestAnimationFrame(loop);
    else animFrame = null;
  }

  function worldToScreen(x, y) {
    return { sx: x * scale + panX, sy: y * scale + panY };
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - panX) / scale, y: (sy - panY) / scale };
  }

  function draw() {
    if (!ctx || !canvas?.width) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDots();
    edgeMap.forEach(drawEdge);
    nodeMap.forEach(drawNode);
  }

  function drawDots() {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    const spacing = Math.max(8, 40 * scale);
    const offsetX = panX % spacing;
    const offsetY = panY % spacing;
    for (let x = offsetX; x < canvas.width; x += spacing) {
      for (let y = offsetY; y < canvas.height; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawEdge(edge) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return;

    const { sx: x1, sy: y1 } = worldToScreen(source.x, source.y);
    const { sx: x2, sy: y2 } = worldToScreen(target.x, target.y);
    const color = EDGE_COLOR[edge.label] || EDGE_COLOR.default;

    ctx.save();
    const suspected = edge.certainty === 'suspected' || edge.uncertain;
    ctx.strokeStyle = color;
    ctx.globalAlpha = suspected ? 0.78 : 0.52;
    ctx.lineWidth = suspected ? 2 : 1.7;
    ctx.setLineDash(suspected ? [4, 7] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (scale > 0.5) {
      const middleX = (x1 + x2) / 2;
      const middleY = (y1 + y2) / 2;
      const fontSize = Math.max(9, Math.round(10 * scale));
      ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;
      const textWidth = ctx.measureText(edge.label).width + 8;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(middleX - textWidth / 2, middleY - fontSize * 0.7, textWidth, fontSize * 1.4);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(edge.label, middleX, middleY);
    }
    ctx.restore();
  }

  function innerLines(label, type) {
    if (type === 'address') return ['地址'];
    if (type === 'person') {
      const name = String(label || '').trim();
      if (name.length <= 2) return [name];
      if (name.length === 3) return [name[0], name.substring(1)];
      return [name.substring(0, 2), name.substring(2, 4)];
    }

    const stripped = String(label || '')
      .replace(/股份有限公司$/, '')
      .replace(/有限公司$/, '')
      .replace(/股份公司$/, '')
      .replace(/公司$/, '')
      .trim();
    if (stripped.length <= 3) return [stripped];
    if (stripped.length <= 5) return [stripped.substring(0, 2), stripped.substring(2)];
    return [stripped.substring(0, 3), stripped.substring(3, 6)];
  }

  function drawNode(node) {
    const { sx, sy } = worldToScreen(node.x, node.y);
    const config = NODE_CFG[node.type] || NODE_CFG.company;
    const radius = config.radius * Math.max(0.5, scale);
    const isHovered = node === hoveredNode;
    const lines = innerLines(node.label, node.type);

    ctx.save();
    if (isHovered) {
      ctx.shadowColor = config.color;
      ctx.shadowBlur = 18;
    }

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? config.color : config.dark;
    ctx.fill();
    ctx.strokeStyle = config.color;
    ctx.lineWidth = node.uncertain ? 3 : 2;
    if (node.uncertain) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = lines.length === 1
      ? Math.max(8, Math.round(radius * 0.52))
      : Math.max(7, Math.round(radius * 0.38));
    ctx.font = `bold ${fontSize}px 'Noto Serif TC', serif`;
    const lineHeight = fontSize * 1.2;
    const totalHeight = lineHeight * lines.length;
    lines.forEach((line, index) => {
      ctx.fillText(line, sx, sy - totalHeight / 2 + lineHeight * (index + 0.5));
    });
    ctx.restore();
  }

  function mousePosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nodeAt(screenX, screenY) {
    const { x, y } = screenToWorld(screenX, screenY);
    const nodeList = [...nodeMap.values()];
    for (let index = nodeList.length - 1; index >= 0; index--) {
      const node = nodeList[index];
      const config = NODE_CFG[node.type] || NODE_CFG.company;
      const dx = node.x - x;
      const dy = node.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= config.radius + 4) return node;
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
      startSim(80);
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
      startSim(40);
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
    if (isDragging && dragNode && mouseDownPos && event.clientX !== undefined) {
      const { x, y } = mousePosition(event);
      const isClick = Math.abs(x - mouseDownPos.x) < 5 && Math.abs(y - mouseDownPos.y) < 5;
      if (isClick) {
        canvas.dispatchEvent(new CustomEvent('nodeClick', { detail: { ...dragNode } }));
      }
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
    const newScale = Math.max(0.15, Math.min(4, scale * delta));
    panX = x - (x - panX) * (newScale / scale);
    panY = y - (y - panY) * (newScale / scale);
    scale = newScale;
    draw();
  }

  function showTooltip(node, screenX, screenY) {
    let text = node.label;
    if (node.type === 'company' && node.taxNo) text += `\n統編：${node.taxNo}`;
    if (node.type === 'person') {
      if (node.role) text += `（${node.role}）`;
      if (node.expandMode === 'responsible') {
        text += '\n點擊查詢同名負責人公司\n注意：姓名相同不代表同一人';
      } else if (node.expandMode === 'name-match-group') {
        text += '\n此為姓名相符的疑似關聯，尚未確認為同一人';
      } else {
        text += '\n目前官方資料源不支援依此角色反查公司';
      }
    }
    if (node.type === 'legalEntity') text += '\n點擊以法人名稱查詢公司';
    if (node.type === 'address') text = node.fullAddress || node.label;

    tooltip.textContent = text;
    tooltip.style.left = `${screenX + 14}px`;
    tooltip.style.top = `${screenY - 14}px`;
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  function exportPNG() {
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = exportFileName;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return { init, addCompany, addNameMatchGroup, clear, exportPNG, getStats };
}

/**
 * 單一關聯圖管理器：兩個畫布只建立不同 instance，不再維護 Graph / Graph2 兩套引擎。
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
});

RelationGraphs.create('person', {
  canvasId: 'graphCanvas2',
  emptyId: 'graphEmpty2',
  infoId: 'graphInfo2',
  exportFileName: 'person-relation-graph.png',
});
