/**
 * graph.js — Canvas 關聯圖引擎
 * 力導向佈局（Force-directed）+ 互動拖曳
 * 不依賴任何外部圖形庫
 */

const Graph = (() => {
  // 節點類型與顏色
  const NODE_TYPES = {
    company:      { color: '#5b9cf6', darkColor: '#3a7ad4', label: '公司', radius: 28 },
    person:       { color: '#e8c84a', darkColor: '#c4a730', label: '人員', radius: 22 },
    address:      { color: '#4ecb7a', darkColor: '#32a85c', label: '地址', radius: 20 },
    legalEntity:  { color: '#a07cf5', darkColor: '#8060d0', label: '法人', radius: 22 },
  };

  const EDGE_COLORS = {
    '代表人':   '#e8c84a',
    '董事長':   '#e8c84a',
    '董事':     '#5b9cf6',
    '監察人':   '#a07cf5',
    '經理人':   '#4ecb7a',
    '地址':     '#4ecb7a',
    '法人代表': '#ff9960',
    default:    '#444860',
  };

  let canvas, ctx, tooltip;
  let nodes = [];
  let edges = [];
  let animFrame = null;
  let isDragging = false;
  let dragNode = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let panStart = null;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let scale = 1;
  let hoveredNode = null;

  // ── 物理模擬參數 ──
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
    window.addEventListener('resize', resize);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Touch support
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
  }

  function resize() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  // ── Node/Edge Management ──

  function nodeId(type, key) {
    return `${type}:${key}`;
  }

  function getOrCreateNode(type, key, label, extraData = {}) {
    const id = nodeId(type, key);
    let node = nodes.find(n => n.id === id);
    if (!node) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      node = {
        id,
        type,
        key,
        label,
        x: cx + (Math.random() - 0.5) * 200,
        y: cy + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        ...extraData,
      };
      nodes.push(node);
    }
    return node;
  }

  function getOrCreateEdge(sourceId, targetId, label) {
    const existing = edges.find(e =>
      (e.source === sourceId && e.target === targetId) ||
      (e.source === targetId && e.target === sourceId && e.label === label)
    );
    if (!existing) {
      edges.push({ source: sourceId, target: targetId, label });
    }
  }

  /**
   * 加入公司節點及其關聯
   */
  function addCompany(companyData, directors = [], branches = []) {
    const taxNo = companyData.Business_Accounting_NO;
    const name = companyData.Company_Name || taxNo;
    const address = companyData.Company_Location;

    const companyNode = getOrCreateNode('company', taxNo, name, {
      fullData: companyData,
      taxNo,
    });

    // 代表人 → 人員節點
    const rep = companyData.Responsible_Name;
    if (rep) {
      const personNode = getOrCreateNode('person', rep, rep, { role: '代表人' });
      getOrCreateEdge(companyNode.id, personNode.id, '代表人');
    }

    // 地址節點（取前15字避免太長）
    if (address) {
      const addrKey = address.substring(0, 20);
      const addrNode = getOrCreateNode('address', addrKey, address, { fullAddress: address });
      getOrCreateEdge(companyNode.id, addrNode.id, '地址');
    }

    // 董監事
    directors.forEach(d => {
      const dName = d.Name || d.Director_Name;
      const dRole = d.Title || d.Director_Title || '董事';
      if (!dName) return;

      const isLegal = d.Representative_Name && d.Representative_Name !== dName;

      if (isLegal) {
        // 法人節點
        const legalNode = getOrCreateNode('legalEntity', dName, dName, { role: dRole });
        getOrCreateEdge(companyNode.id, legalNode.id, dRole);
        // 法人代表
        const repNode = getOrCreateNode('person', d.Representative_Name, d.Representative_Name, { role: '法人代表' });
        getOrCreateEdge(legalNode.id, repNode.id, '法人代表');
      } else {
        const personNode = getOrCreateNode('person', dName, dName, { role: dRole });
        getOrCreateEdge(companyNode.id, personNode.id, dRole);
      }
    });

    // 分公司
    branches.forEach(b => {
      const bName = b.Branch_Office_Name;
      const bTax = b.Branch_Office_Business_Accounting_NO;
      if (bName && bTax) {
        const branchNode = getOrCreateNode('company', bTax, bName, { taxNo: bTax, isBranch: true });
        getOrCreateEdge(companyNode.id, branchNode.id, '分公司');
      }
    });

    document.getElementById('graphEmpty').style.display = 'none';
    updateInfo();
    startSimulation();
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
    if (nodes.length === 0) {
      info.textContent = '';
      return;
    }
    const companies = nodes.filter(n => n.type === 'company').length;
    const people = nodes.filter(n => n.type === 'person').length;
    const addresses = nodes.filter(n => n.type === 'address').length;
    info.textContent = `節點：${nodes.length}（公司 ${companies}｜人員 ${people}｜地址 ${addresses}）　連線：${edges.length}`;
  }

  // ── Force-Directed Layout ──

  function simulate() {
    if (nodes.length === 0) return;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Repulsion between all nodes
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

    // Attraction along edges
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

    // Center gravity
    nodes.forEach(n => {
      n.vx += (cx - n.x) * CENTER_FORCE;
      n.vy += (cy - n.y) * CENTER_FORCE;
    });

    // Apply velocity + damping
    nodes.forEach(n => {
      if (n === dragNode) return;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    });
  }

  let simTick = 0;
  function startSimulation() {
    simTick = 200; // run for 200 frames
    if (animFrame) return;
    loop();
  }

  function loop() {
    if (simTick > 0) {
      simulate();
      simTick--;
    }
    draw();
    animFrame = requestAnimationFrame(loop);
  }

  // ── Drawing ──

  function worldToScreen(x, y) {
    return {
      sx: (x + viewOffsetX) * scale + canvas.width / 2 * (1 - scale),
      sy: (y + viewOffsetY) * scale + canvas.height / 2 * (1 - scale),
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvas.width / 2 * (1 - scale)) / scale - viewOffsetX,
      y: (sy - canvas.height / 2 * (1 - scale)) / scale - viewOffsetY,
    };
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grid dots
    drawGrid();

    // Edges
    edges.forEach(e => drawEdge(e));

    // Nodes
    nodes.forEach(n => drawNode(n));
  }

  function drawGrid() {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    const spacing = 40 * scale;
    const ox = (viewOffsetX * scale) % spacing;
    const oy = (viewOffsetY * scale) % spacing;
    for (let x = ox; x < canvas.width; x += spacing) {
      for (let y = oy; y < canvas.height; y += spacing) {
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
    ctx.lineWidth = 1.5 * scale;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Edge label
    if (scale > 0.6) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = color;
      ctx.font = `${Math.round(10 * scale)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Background pill
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

    // Glow for hovered
    if (isHovered) {
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = 20;
    }

    // Circle
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? cfg.color : cfg.darkColor;
    ctx.fill();
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 2 * scale;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Icon letter
    ctx.fillStyle = '#0d0f14';
    ctx.font = `bold ${Math.round(12 * scale)}px 'Noto Serif TC', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icon = n.type === 'company' ? '公' : n.type === 'person' ? '人' : n.type === 'address' ? '址' : '法';
    ctx.fillText(icon, sx, sy);

    // Label below node
    if (scale > 0.4) {
      const label = n.label.length > 10 ? n.label.substring(0, 10) + '…' : n.label;
      ctx.fillStyle = isHovered ? '#fff' : 'rgba(232,234,240,0.8)';
      ctx.font = `${Math.round(11 * scale)}px 'Noto Serif TC', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, sx, sy + r + 4 * scale);
    }

    ctx.restore();
  }

  // ── Interaction ──

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function getNodeAt(sx, sy) {
    const { x, y } = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const cfg = NODE_TYPES[n.type] || NODE_TYPES.company;
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= cfg.radius + 4) return n;
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
      node.vx = 0; node.vy = 0;
      simTick = 100;
      if (!animFrame) loop();
    } else {
      panStart = { x, y, ox: viewOffsetX, oy: viewOffsetY };
    }
  }

  function onMouseMove(e) {
    const { x, y } = getMousePos(e);

    if (isDragging && dragNode) {
      const world = screenToWorld(x, y);
      dragNode.x = world.x + dragOffsetX;
      dragNode.y = world.y + dragOffsetY;
      simTick = 50;
      if (!animFrame) loop();
      return;
    }

    if (panStart) {
      viewOffsetX = panStart.ox + (x - panStart.x) / scale;
      viewOffsetY = panStart.oy + (y - panStart.y) / scale;
      if (!animFrame) { draw(); }
      return;
    }

    const node = getNodeAt(x, y);
    if (node !== hoveredNode) {
      hoveredNode = node;
      canvas.style.cursor = node ? 'pointer' : 'grab';
      if (!animFrame) draw();
    }

    if (node) {
      showTooltip(node, x, y);
    } else {
      hideTooltip();
    }
  }

  function onMouseUp(e) {
    if (isDragging && dragNode && e.type === 'mouseup') {
      // Click (no significant move) → dispatch event
      const { x, y } = getMousePos(e);
      const world = screenToWorld(x, y);
      const moved = Math.abs(dragNode.x - world.x - dragOffsetX) < 4 &&
                    Math.abs(dragNode.y - world.y - dragOffsetY) < 4;
      if (moved) {
        canvas.dispatchEvent(new CustomEvent('nodeClick', { detail: dragNode }));
      }
    }
    isDragging = false;
    dragNode = null;
    panStart = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const { x, y } = getMousePos(e);
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.2, Math.min(3, scale * delta));

    // Zoom toward cursor
    const worldBefore = screenToWorld(x, y);
    scale = newScale;
    const worldAfter = screenToWorld(x, y);
    viewOffsetX += worldAfter.x - worldBefore.x;
    viewOffsetY += worldAfter.y - worldBefore.y;

    if (!animFrame) draw();
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

  function onTouchEnd(e) { onMouseUp({ type: 'touchend' }); }

  function showTooltip(node, sx, sy) {
    let content = node.label;
    if (node.type === 'company') {
      content = `${node.label}${node.taxNo ? '\n統編：' + node.taxNo : ''}`;
    } else if (node.type === 'person') {
      content = `${node.label}${node.role ? '（' + node.role + '）' : ''}`;
    } else if (node.type === 'address') {
      content = node.fullAddress || node.label;
    }

    tooltip.textContent = content;
    tooltip.style.left = (sx + 12) + 'px';
    tooltip.style.top = (sy - 12) + 'px';
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    tooltip.classList.remove('visible');
  }

  // ── Export ──
  function exportPNG() {
    const link = document.createElement('a');
    link.download = 'company-relation-graph.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return {
    init,
    addCompany,
    clear,
    exportPNG,
    get nodeCount() { return nodes.length; },
  };
})();
