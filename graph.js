/**
 * graph.js — Canvas 關聯圖引擎
 * 力導向佈局（Force-directed）+ 互動拖曳
 */

const Graph = (() => {
  const NODE_TYPES = {
    company: { color: '#5b9cf6', darkColor: '#3a7ad4', label: '公司', radius: 28 },
    person: { color: '#e8c84a', darkColor: '#c4a730', label: '人員', radius: 22 },
    address: { color: '#4ecb7a', darkColor: '#32a85c', label: '地址', radius: 20 },
    legalEntity: { color: '#a07cf5', darkColor: '#8060d0', label: '法人', radius: 22 },
  };

  const EDGE_COLORS = {
    代表人: '#e8c84a',
    董事長: '#e8c84a',
    董事: '#5b9cf6',
    監察人: '#a07cf5',
    經理人: '#4ecb7a',
    分公司經理人: '#4ecb7a',
    地址: '#4ecb7a',
    所代表法人: '#ff9960',
    分公司: '#5b9cf6',
    default: '#444860',
  };

  let canvas, ctx, tooltip;
  let nodes = [];
  let edges = [];
  let animFrame = null;
  let simTick = 0;
  let isDragging = false;
  let dragNode = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let panStart = null;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let scale = 1;
  let hoveredNode = null;

  const REPULSION = 3000;
  const ATTRACTION = 0.04;
  const DAMPING = 0.75;
  const CENTER_FORCE = 0.005;

  function init() {
    canvas = document.getElementById('graphCanvas');
    ctx = canvas.getContext('2d');
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    canvas.parentElement.appendChild(tooltip);

    resize();
    window.addEventListener('resize', () => {
      resize();
      draw();
    });

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
  }

  function resize() {
    if (!canvas) return;
    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();
    const width = Math.max(rect.width || container.clientWidth || 700, 320);
    const height = Math.max(rect.height || container.clientHeight || 520, 320);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function canvasWidth() {
    return canvas.getBoundingClientRect().width || 700;
  }

  function canvasHeight() {
    return canvas.getBoundingClientRect().height || 520;
  }

  function nodeId(type, key) {
    return `${type}:${String(key).trim()}`;
  }

  function getOrCreateNode(type, key, label, extraData = {}) {
    const safeKey = String(key || label || '').trim();
    if (!safeKey) return null;
    const id = nodeId(type, safeKey);
    let node = nodes.find(n => n.id === id);
    if (!node) {
      const cx = canvasWidth() / 2;
      const cy = canvasHeight() / 2;
      node = {
        id,
        type,
        key: safeKey,
        label: String(label || safeKey),
        x: cx + (Math.random() - 0.5) * 220,
        y: cy + (Math.random() - 0.5) * 220,
        vx: 0,
        vy: 0,
        ...extraData,
      };
      nodes.push(node);
    } else {
      Object.assign(node, extraData);
      if (label) node.label = String(label);
    }
    return node;
  }

  function getOrCreateEdge(sourceId, targetId, label) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const existing = edges.find(e =>
      e.label === label &&
      ((e.source === sourceId && e.target === targetId) ||
        (e.source === targetId && e.target === sourceId))
    );
    if (!existing) edges.push({ source: sourceId, target: targetId, label });
  }

  function addCompany(companyData, directors = [], branches = []) {
    resize();

    const taxNo = companyData.Business_Accounting_NO;
    const name = companyData.Company_Name || taxNo;
    const address = companyData.Company_Location;
    const companyNode = getOrCreateNode('company', taxNo, name, { fullData: companyData, taxNo });
    if (!companyNode) return;

    const rep = companyData.Responsible_Name;
    if (rep) {
      const personNode = getOrCreateNode('person', rep, rep, { role: '代表人' });
      getOrCreateEdge(companyNode.id, personNode.id, '代表人');
    }

    if (address) {
      const addrKey = normalizeAddressKey(address);
      const addrNode = getOrCreateNode('address', addrKey, address, { fullAddress: address });
      getOrCreateEdge(companyNode.id, addrNode.id, '地址');
    }

    directors.forEach(d => {
      const role = d.Person_Position_Name || d.Title || '董監事';
      const personName = d.Person_Name || d.Name || '';
      const legalEntityName = d.Juristic_Person_Name || '';

      if (legalEntityName) {
        const legalNode = getOrCreateNode('legalEntity', legalEntityName, legalEntityName, { role });
        getOrCreateEdge(companyNode.id, legalNode.id, role || '董監事');
        if (personName && personName !== legalEntityName) {
          const personNode = getOrCreateNode('person', personName, personName, { role: '法人代表' });
          getOrCreateEdge(legalNode.id, personNode.id, '所代表法人');
        }
        return;
      }

      if (personName) {
        const personNode = getOrCreateNode('person', personName, personName, { role });
        getOrCreateEdge(companyNode.id, personNode.id, role || '董監事');
      }
    });

    branches.forEach(b => {
      const branchName = b.Branch_Office_Name;
      const branchTax = b.Branch_Office_Business_Accounting_NO;
      if (branchName && branchTax) {
        const branchNode = getOrCreateNode('company', branchTax, branchName, { taxNo: branchTax, isBranch: true, fullData: b });
        getOrCreateEdge(companyNode.id, branchNode.id, '分公司');
        if (b.Branch_Office_Location) {
          const addrNode = getOrCreateNode('address', normalizeAddressKey(b.Branch_Office_Location), b.Branch_Office_Location, {
            fullAddress: b.Branch_Office_Location,
          });
          getOrCreateEdge(branchNode.id, addrNode.id, '地址');
        }
        if (b.Branch_Office_Manager_Name) {
          const managerNode = getOrCreateNode('person', b.Branch_Office_Manager_Name, b.Branch_Office_Manager_Name, { role: '分公司經理人' });
          getOrCreateEdge(branchNode.id, managerNode.id, '分公司經理人');
        }
      }
    });

    document.getElementById('graphEmpty').style.display = 'none';
    updateInfo();
    startSimulation();
  }

  function addBranchManagerRelation(branch, managerName) {
    resize();
    const branchTax = branch.Branch_Office_Business_Accounting_NO;
    const branchName = branch.Branch_Office_Name || branchTax;
    if (!branchTax || !managerName) return;
    const branchNode = getOrCreateNode('company', branchTax, branchName, { taxNo: branchTax, isBranch: true, fullData: branch });
    const personNode = getOrCreateNode('person', managerName, managerName, { role: '分公司經理人' });
    getOrCreateEdge(branchNode.id, personNode.id, '分公司經理人');
    document.getElementById('graphEmpty').style.display = 'none';
    updateInfo();
    startSimulation();
  }

  function normalizeAddressKey(address) {
    return String(address).replace(/[\s　]/g, '').substring(0, 28);
  }

  function clear() {
    nodes = [];
    edges = [];
    viewOffsetX = 0;
    viewOffsetY = 0;
    scale = 1;
    document.getElementById('graphEmpty').style.display = 'flex';
    updateInfo();
    draw();
  }

  function updateInfo() {
    const info = document.getElementById('graphInfo');
    if (!info) return;
    if (nodes.length === 0) {
      info.textContent = '';
      return;
    }
    const companies = nodes.filter(n => n.type === 'company').length;
    const people = nodes.filter(n => n.type === 'person').length;
    const addresses = nodes.filter(n => n.type === 'address').length;
    const legalEntities = nodes.filter(n => n.type === 'legalEntity').length;
    info.textContent = `節點：${nodes.length}（公司 ${companies}｜人員 ${people}｜法人 ${legalEntities}｜地址 ${addresses}）　連線：${edges.length}`;
  }

  function simulate() {
    if (nodes.length === 0) return;
    const cx = canvasWidth() / 2;
    const cy = canvasHeight() / 2;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    edges.forEach(e => {
      const source = nodes.find(n => n.id === e.source);
      const target = nodes.find(n => n.id === e.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealDist = 160;
      const force = (dist - idealDist) * ATTRACTION;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx; source.vy += fy;
      target.vx -= fx; target.vy -= fy;
    });

    nodes.forEach(n => {
      n.vx += (cx - n.x) * CENTER_FORCE;
      n.vy += (cy - n.y) * CENTER_FORCE;
    });

    nodes.forEach(n => {
      if (n === dragNode) return;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    });
  }

  function startSimulation() {
    simTick = Math.max(simTick, 220);
    if (!animFrame) loop();
  }

  function loop() {
    if (simTick > 0) {
      simulate();
      simTick--;
    }
    draw();
    if (simTick > 0 || isDragging || panStart) {
      animFrame = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
  }

  function worldToScreen(x, y) {
    return {
      sx: (x + viewOffsetX) * scale + canvasWidth() / 2 * (1 - scale),
      sy: (y + viewOffsetY) * scale + canvasHeight() / 2 * (1 - scale),
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvasWidth() / 2 * (1 - scale)) / scale - viewOffsetX,
      y: (sy - canvasHeight() / 2 * (1 - scale)) / scale - viewOffsetY,
    };
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasWidth(), canvasHeight());
    drawGrid();
    edges.forEach(drawEdge);
    nodes.forEach(drawNode);
  }

  function drawGrid() {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    const spacing = Math.max(40 * scale, 14);
    const ox = (viewOffsetX * scale) % spacing;
    const oy = (viewOffsetY * scale) % spacing;
    for (let x = ox; x < canvasWidth(); x += spacing) {
      for (let y = oy; y < canvasHeight(); y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawEdge(e) {
    const src = nodes.find(n => n.id === e.source);
    const tgt = nodes.find(n => n.id === e.target);
    if (!src || !tgt) return;
    const { sx: x1, sy: y1 } = worldToScreen(src.x, src.y);
    const { sx: x2, sy: y2 } = worldToScreen(tgt.x, tgt.y);
    const color = EDGE_COLORS[e.label] || EDGE_COLORS.default;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (scale > 0.6) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.font = `${Math.round(10 * scale)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(e.label).width + 8;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(mx - tw / 2, my - 7 * scale, tw, 14 * scale);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.fillText(e.label, mx, my);
    }
    ctx.restore();
  }

  function drawNode(n) {
    const { sx, sy } = worldToScreen(n.x, n.y);
    const cfg = NODE_TYPES[n.type] || NODE_TYPES.company;
    const r = cfg.radius * scale;
    const isHovered = n === hoveredNode;

    ctx.save();
    if (isHovered) {
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = 20;
    }
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? cfg.color : cfg.darkColor;
    ctx.fill();
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 2 * scale;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#0d0f14';
    ctx.font = `bold ${Math.round(12 * scale)}px 'Noto Serif TC', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icon = n.type === 'company' ? '公' : n.type === 'person' ? '人' : n.type === 'address' ? '址' : '法';
    ctx.fillText(icon, sx, sy);

    if (scale > 0.4) {
      const label = n.label.length > 10 ? `${n.label.substring(0, 10)}…` : n.label;
      ctx.fillStyle = isHovered ? '#fff' : 'rgba(232,234,240,0.8)';
      ctx.font = `${Math.round(11 * scale)}px 'Noto Serif TC', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, sx, sy + r + 4 * scale);
    }
    ctx.restore();
  }

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function getNodeAt(sx, sy) {
    const { x, y } = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const cfg = NODE_TYPES[n.type] || NODE_TYPES.company;
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= cfg.radius + 5) return n;
    }
    return null;
  }

  function onMouseDown(e) {
    const { x, y } = getMousePos(e);
    const node = getNodeAt(x, y);
    if (node) {
      isDragging = true;
      dragNode = node;
      const world = screenToWorld(x, y);
      dragOffsetX = node.x - world.x;
      dragOffsetY = node.y - world.y;
      node.vx = 0;
      node.vy = 0;
      startSimulation();
    } else {
      panStart = { x, y, ox: viewOffsetX, oy: viewOffsetY };
      startSimulation();
    }
  }

  function onMouseMove(e) {
    const { x, y } = getMousePos(e);
    if (isDragging && dragNode) {
      const world = screenToWorld(x, y);
      dragNode.x = world.x + dragOffsetX;
      dragNode.y = world.y + dragOffsetY;
      simTick = Math.max(simTick, 40);
      return;
    }
    if (panStart) {
      viewOffsetX = panStart.ox + (x - panStart.x) / scale;
      viewOffsetY = panStart.oy + (y - panStart.y) / scale;
      simTick = Math.max(simTick, 5);
      return;
    }
    const node = getNodeAt(x, y);
    if (node !== hoveredNode) {
      hoveredNode = node;
      canvas.style.cursor = node ? 'pointer' : 'grab';
      draw();
    }
    node ? showTooltip(node, x, y) : hideTooltip();
  }

  function onMouseUp(e) {
    if (isDragging && dragNode && e.type === 'mouseup') {
      const { x, y } = getMousePos(e);
      const node = getNodeAt(x, y);
      if (node && node.id === dragNode.id) canvas.dispatchEvent(new CustomEvent('nodeClick', { detail: dragNode }));
    }
    isDragging = false;
    dragNode = null;
    panStart = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(2.5, Math.max(0.25, scale * delta));
    draw();
  }

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      onMouseDown({ clientX: t.clientX, clientY: t.clientY });
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    }
  }

  function onTouchEnd() {
    isDragging = false;
    dragNode = null;
    panStart = null;
  }

  function showTooltip(node, x, y) {
    if (!tooltip) return;
    const typeLabel = NODE_TYPES[node.type]?.label || '';
    tooltip.innerHTML = `
      <div style="font-weight:600;color:#e8c84a">${escapeHtml(node.label)}</div>
      <div>${typeLabel}${node.role ? `｜${escapeHtml(node.role)}` : ''}</div>
      ${node.taxNo ? `<div>統編：${escapeHtml(node.taxNo)}</div>` : ''}
    `;
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  function exportPNG() {
    resize();
    draw();
    const link = document.createElement('a');
    link.download = `company-dd-graph-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    init,
    resize,
    addCompany,
    addBranchManagerRelation,
    clear,
    exportPNG,
  };
})();
