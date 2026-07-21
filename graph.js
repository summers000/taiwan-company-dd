/**
 * graph.js — Canvas 關聯圖引擎（力導向佈局）
 */

const Graph = (() => {
  const NODE_CFG = {
    company:     { color: '#5b9cf6', dark: '#2a5aad', radius: 28, icon: '公' },
    person:      { color: '#e8c84a', dark: '#a88c20', radius: 22, icon: '人' },
    address:     { color: '#4ecb7a', dark: '#27834e', radius: 20, icon: '址' },
    legalEntity: { color: '#a07cf5', dark: '#6040b0', radius: 22, icon: '法' },
  };

  const EDGE_COLOR = {
    '代表人':   '#f0d060', '董事長':   '#f0d060',
    '董事':     '#7ab8ff', '獨立董事': '#ff9f43',
    '監察人':   '#cc99ff', '經理人':   '#5dde8a',
    '地址':     '#5dde8a', '法人代表': '#ff7043',
    '分公司':   '#aaccff', default:    '#6878a8',
  };

  let canvas, ctx, tooltip;
  let nodes = [], edges = [];
  let animFrame = null, simTick = 0;
  let isDragging = false, dragNode = null, dragOffX = 0, dragOffY = 0;
  let panStart = null;
  let panX = 0, panY = 0, scale = 1;
  let hoveredNode = null;

  const REPULSION = 3500, ATTRACTION = 0.035, DAMPING = 0.72, GRAVITY = 0.004;

  // ── Init ──
  function init() {
    canvas = document.getElementById('graphCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    canvas.parentElement.appendChild(tooltip);

    resize();

    // ResizeObserver 確保 canvas 尺寸正確
    new ResizeObserver(resize).observe(canvas.parentElement);

    canvas.addEventListener('mousedown',  onMouseDown);
    canvas.addEventListener('mousemove',  onMouseMove);
    canvas.addEventListener('mouseup',    onMouseUp);
    canvas.addEventListener('mouseleave', () => { onMouseUp({}); hideTooltip(); });
    canvas.addEventListener('wheel',      onWheel, { passive: false });
    canvas.addEventListener('touchstart', e => { e.preventDefault(); onMouseDown(touchEvt(e)); }, { passive: false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); onMouseMove(touchEvt(e)); }, { passive: false });
    canvas.addEventListener('touchend',   e => onMouseUp({}));

    draw();
  }

  function resize() {
    if (!canvas) return;
    const p = canvas.parentElement;
    canvas.width  = p.clientWidth;
    canvas.height = p.clientHeight;
    draw();
  }

  function touchEvt(e) {
    const t = e.touches[0];
    const r = canvas.getBoundingClientRect();
    return { clientX: t.clientX, clientY: t.clientY, _isFake: true };
  }

  // ── Node/Edge Management ──
  function nid(type, key) { return `${type}:${key}`; }

  function getOrCreate(type, key, label, extra = {}) {
    const id = nid(type, key);
    let n = nodes.find(x => x.id === id);
    if (!n) {
      const cx = canvas.width / 2, cy = canvas.height / 2;
      n = { id, type, key, label, x: cx + (Math.random()-.5)*220, y: cy + (Math.random()-.5)*220, vx: 0, vy: 0, ...extra };
      nodes.push(n);
    }
    return n;
  }

  function getOrCreateEdge(src, tgt, label) {
    if (!edges.find(e => e.source === src && e.target === tgt && e.label === label)) {
      edges.push({ source: src, target: tgt, label });
    }
  }

  function addCompany(data, directors = [], branches = []) {
    const taxNo = data.Business_Accounting_NO;
    const name  = data.Company_Name || taxNo;

    const cNode = getOrCreate('company', taxNo, name, { taxNo, fullData: data });

    // 代表人
    const rep = data.Responsible_Name;
    if (rep) {
      const pNode = getOrCreate('person', rep, rep, { role: '代表人' });
      getOrCreateEdge(cNode.id, pNode.id, '代表人');
    }

    // 地址
    const addr = data.Company_Location;
    if (addr) {
      const addrKey = addr.substring(0, 20);
      const aNode = getOrCreate('address', addrKey, addr, { fullAddress: addr });
      getOrCreateEdge(cNode.id, aNode.id, '地址');
    }

    // 董監事
    directors.forEach(d => {
      const dName = d.Name;
      const dTitle = d.Title || '董事';
      if (!dName || dName === '—') return;

      const repEntity = d.Representative_Name;
      if (repEntity && repEntity !== dName) {
        // 法人節點
        const lNode = getOrCreate('legalEntity', repEntity, repEntity, { role: dTitle });
        getOrCreateEdge(cNode.id, lNode.id, dTitle);
        // 法人代表
        const rNode = getOrCreate('person', dName, dName, { role: '法人代表' });
        getOrCreateEdge(lNode.id, rNode.id, '法人代表');
      } else {
        const pNode = getOrCreate('person', dName, dName, { role: dTitle });
        getOrCreateEdge(cNode.id, pNode.id, dTitle);
      }
    });

    // 分公司
    branches.forEach(b => {
      const bTax  = b.Branch_Office_Business_Accounting_NO;
      const bName = b.Branch_Office_Name;
      if (bTax && bName) {
        const bNode = getOrCreate('company', bTax, bName, { taxNo: bTax, isBranch: true });
        getOrCreateEdge(cNode.id, bNode.id, '分公司');
      }
    });

    $('graphEmpty').style.display = 'none';
    updateInfo();
    startSim();
  }

  function clear() {
    nodes = []; edges = [];
    panX = 0; panY = 0; scale = 1;
    $('graphEmpty').style.display = 'flex';
    updateInfo(); draw();
  }

  function updateInfo() {
    const el = document.getElementById('graphInfo');
    if (!el) return;
    if (nodes.length === 0) { el.textContent = ''; return; }
    const co = nodes.filter(n => n.type === 'company').length;
    const pe = nodes.filter(n => n.type === 'person').length;
    const ad = nodes.filter(n => n.type === 'address').length;
    el.textContent = `節點：${nodes.length}（公司 ${co}｜人員 ${pe}｜地址 ${ad}）　連線：${edges.length}`;
  }

  function $(id) { return document.getElementById(id); }

  // ── Physics ──
  function simulate() {
    if (nodes.length === 0) return;
    const cx = canvas.width/2, cy = canvas.height/2;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const f = REPULSION / (d*d);
        a.vx -= dx/d*f; a.vy -= dy/d*f;
        b.vx += dx/d*f; b.vy += dy/d*f;
      }
    }

    edges.forEach(e => {
      const s = nodes.find(n => n.id === e.source);
      const t = nodes.find(n => n.id === e.target);
      if (!s || !t) return;
      const dx = t.x-s.x, dy = t.y-s.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      const f  = (d - 160) * ATTRACTION;
      s.vx += dx/d*f; s.vy += dy/d*f;
      t.vx -= dx/d*f; t.vy -= dy/d*f;
    });

    nodes.forEach(n => {
      n.vx += (cx - n.x) * GRAVITY;
      n.vy += (cy - n.y) * GRAVITY;
    });

    nodes.forEach(n => {
      if (n === dragNode) return;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x += n.vx; n.y += n.vy;
    });
  }

  function startSim() {
    simTick = 250;
    if (!animFrame) loop();
  }

  function loop() {
    if (simTick > 0) { simulate(); simTick--; }
    draw();
    animFrame = requestAnimationFrame(loop);
  }

  // ── Drawing ──
  function w2s(x, y) {
    return { sx: x*scale + panX, sy: y*scale + panY };
  }
  function s2w(sx, sy) {
    return { x: (sx-panX)/scale, y: (sy-panY)/scale };
  }

  function draw() {
    if (!ctx || !canvas.width) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDots();
    edges.forEach(drawEdge);
    nodes.forEach(drawNode);
  }

  function drawDots() {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    const sp = 40*scale;
    const ox = panX % sp, oy = panY % sp;
    for (let x = ox; x < canvas.width; x += sp)
      for (let y = oy; y < canvas.height; y += sp) {
        ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI*2); ctx.fill();
      }
    ctx.restore();
  }

  function drawEdge(e) {
    const s = nodes.find(n => n.id === e.source);
    const t = nodes.find(n => n.id === e.target);
    if (!s || !t) return;
    const {sx:x1,sy:y1} = w2s(s.x, s.y);
    const {sx:x2,sy:y2} = w2s(t.x, t.y);
    const color = EDGE_COLOR[e.label] || EDGE_COLOR.default;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.setLineDash([]);

    if (scale > 0.5) {
      const mx=(x1+x2)/2, my=(y1+y2)/2;
      const fs = Math.max(9, Math.round(10*scale));
      ctx.font = `${fs}px 'JetBrains Mono', monospace`;
      const tw = ctx.measureText(e.label).width + 8;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(mx-tw/2, my-fs*0.7, tw, fs*1.4);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(e.label, mx, my);
    }
    ctx.restore();
  }

  // 計算圓圈內要顯示的文字行數
  function innerLines(label, type) {
    if (type === 'address') return ['地址'];

    if (type === 'person') {
      const name = label.trim();
      if (name.length <= 2) return [name];           // 1-2字：一行
      if (name.length === 3) return [name[0], name.substring(1)]; // 3字：姓1 / 名2
      // 4字以上：前2後2（汪郭｜鼎松）
      return [name.substring(0, 2), name.substring(2, 4)];
    }

    // 公司 / 法人：去後綴後依字數決定分行方式
    const stripped = label
      .replace(/股份有限公司$/, '')
      .replace(/有限公司$/, '')
      .replace(/股份公司$/, '')
      .replace(/公司$/, '')
      .trim();
    const len = stripped.length;
    if (len <= 3) return [stripped];                          // 1-3字：一行
    if (len === 4) return [stripped.substring(0,2), stripped.substring(2)]; // 4字：2+2
    if (len === 5) return [stripped.substring(0,2), stripped.substring(2)]; // 5字：2+3
    return [stripped.substring(0,3), stripped.substring(3,6)];              // 6字：3+3
  }

  function drawNode(n) {
    const {sx,sy} = w2s(n.x, n.y);
    const cfg  = NODE_CFG[n.type] || NODE_CFG.company;
    const r    = cfg.radius * Math.max(0.5, scale);
    const isH  = n === hoveredNode;
    const lines = innerLines(n.label, n.type);

    ctx.save();
    if (isH) { ctx.shadowColor = cfg.color; ctx.shadowBlur = 18; }

    // 圓圈
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI*2);
    ctx.fillStyle   = isH ? cfg.color : cfg.dark;
    ctx.fill();
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth   = 2;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // 圓圈內文字（多行垂直置中）
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = lines.length === 1
      ? Math.max(8, Math.round(r * 0.52))
      : Math.max(7, Math.round(r * 0.38));
    ctx.font = `bold ${fs}px 'Noto Serif TC', serif`;
    const lineH = fs * 1.2;
    const totalH = lineH * lines.length;
    lines.forEach((line, i) => {
      const ly = sy - totalH/2 + lineH*(i+0.5);
      ctx.fillText(line, sx, ly);
    });

    ctx.restore();
  }

  // ── Interaction ──
  function mpos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nodeAt(sx, sy) {
    const {x,y} = s2w(sx,sy);
    for (let i=nodes.length-1; i>=0; i--) {
      const n=nodes[i], cfg=NODE_CFG[n.type]||NODE_CFG.company;
      const dx=n.x-x, dy=n.y-y;
      if (Math.sqrt(dx*dx+dy*dy) <= cfg.radius+4) return n;
    }
    return null;
  }

  let mouseDownPos = null;

  function onMouseDown(e) {
    const {x,y} = mpos(e);
    mouseDownPos = {x,y};
    const node = nodeAt(x,y);
    if (node) {
      isDragging=true; dragNode=node;
      const w=s2w(x,y);
      dragOffX=node.x-w.x; dragOffY=node.y-w.y;
      node.vx=0; node.vy=0;
      simTick=80; if(!animFrame) loop();
    } else {
      panStart = {x,y,px:panX,py:panY};
    }
  }

  function onMouseMove(e) {
    const {x,y} = mpos(e);
    if (isDragging && dragNode) {
      const {x:wx,y:wy} = s2w(x,y);
      dragNode.x = wx+dragOffX; dragNode.y = wy+dragOffY;
      simTick=40; if(!animFrame) loop();
      return;
    }
    if (panStart) {
      panX = panStart.px + (x-panStart.x);
      panY = panStart.py + (y-panStart.y);
      if(!animFrame) draw(); return;
    }
    const n = nodeAt(x,y);
    if (n !== hoveredNode) {
      hoveredNode = n;
      canvas.style.cursor = n ? 'pointer' : 'grab';
      if(!animFrame) draw();
    }
    if (n) showTooltip(n, x, y); else hideTooltip();
  }

  function onMouseUp(e) {
    // Click detection (no drag)
    if (isDragging && dragNode && mouseDownPos && e.clientX !== undefined) {
      const {x,y} = mpos(e);
      const moved = Math.abs(x-mouseDownPos.x) < 5 && Math.abs(y-mouseDownPos.y) < 5;
      if (moved) canvas.dispatchEvent(new CustomEvent('nodeClick', { detail: dragNode }));
    }
    isDragging=false; dragNode=null; panStart=null; mouseDownPos=null;
  }

  function onWheel(e) {
    e.preventDefault();
    const {x,y} = mpos(e);
    const delta = e.deltaY > 0 ? 0.88 : 1.14;
    const ns    = Math.max(0.15, Math.min(4, scale*delta));
    // Zoom toward cursor
    panX = x - (x-panX) * (ns/scale);
    panY = y - (y-panY) * (ns/scale);
    scale = ns;
    if(!animFrame) draw();
  }

  function showTooltip(n, sx, sy) {
    let txt = n.label;
    if (n.type==='company')  txt += n.taxNo ? `\n統編：${n.taxNo}` : '';
    if (n.type==='person')   txt += n.role  ? `（${n.role}）\n點擊展開關聯公司` : '\n點擊展開關聯公司';
    if (n.type==='address')  txt = n.fullAddress || n.label;
    tooltip.textContent = txt;
    tooltip.style.left  = (sx+14)+'px';
    tooltip.style.top   = (sy-14)+'px';
    tooltip.classList.add('visible');
  }
  function hideTooltip() { tooltip.classList.remove('visible'); }

  function exportPNG() {
    const link = document.createElement('a');
    link.download = 'company-relation-graph.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return { init, addCompany, clear, exportPNG };
})();

/**
 * Graph2 — 負責人查詢頁面的第二個關聯圖實例
 * 複用同一套引擎，掛在 graphCanvas2 上
 */
const Graph2 = (() => {
  const NODE_CFG = {
    company:     { color: '#5b9cf6', dark: '#2a5aad', radius: 28, icon: '公' },
    person:      { color: '#e8c84a', dark: '#a88c20', radius: 22, icon: '人' },
    address:     { color: '#4ecb7a', dark: '#27834e', radius: 20, icon: '址' },
    legalEntity: { color: '#a07cf5', dark: '#6040b0', radius: 22, icon: '法' },
  };
  const EDGE_COLOR = {
    '代表人':'#f0d060','董事長':'#f0d060','董事':'#7ab8ff','獨立董事':'#ff9f43',
    '監察人':'#cc99ff','經理人':'#5dde8a','地址':'#5dde8a','法人代表':'#ff7043',
    '分公司':'#aaccff', default:'#6878a8',
  };

  let canvas, ctx, tooltip;
  let nodes = [], edges = [];
  let animFrame = null, simTick = 0;
  let isDragging = false, dragNode = null, dragOffX = 0, dragOffY = 0;
  let panStart = null, panX = 0, panY = 0, scale = 1;
  let hoveredNode = null;

  const REPULSION = 3500, ATTRACTION = 0.035, DAMPING = 0.72, GRAVITY = 0.004;

  function init() {
    canvas = document.getElementById('graphCanvas2');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    canvas.parentElement.appendChild(tooltip);
    resize();
    new ResizeObserver(resize).observe(canvas.parentElement);
    canvas.addEventListener('mousedown',  onMouseDown);
    canvas.addEventListener('mousemove',  onMouseMove);
    canvas.addEventListener('mouseup',    onMouseUp);
    canvas.addEventListener('mouseleave', () => { onMouseUp({}); hideTooltip(); });
    canvas.addEventListener('wheel',      onWheel, { passive: false });
    draw();
  }

  function resize() {
    if (!canvas) return;
    const p = canvas.parentElement;
    canvas.width = p.clientWidth; canvas.height = p.clientHeight; draw();
  }

  function nid(type, key) { return `${type}:${key}`; }

  function getOrCreate(type, key, label, extra = {}) {
    const id = nid(type, key);
    let n = nodes.find(x => x.id === id);
    if (!n) {
      const cx = canvas.width/2, cy = canvas.height/2;
      n = { id, type, key, label, x: cx+(Math.random()-.5)*220, y: cy+(Math.random()-.5)*220, vx:0, vy:0, ...extra };
      nodes.push(n);
    }
    return n;
  }

  function getOrCreateEdge(src, tgt, label) {
    if (!edges.find(e => e.source===src && e.target===tgt && e.label===label))
      edges.push({ source:src, target:tgt, label });
  }

  function addCompany(data, directors=[], branches=[]) {
    const taxNo = data.Business_Accounting_NO;
    const name  = data.Company_Name || taxNo;
    const cNode = getOrCreate('company', taxNo, name, { taxNo, fullData: data });
    const rep   = data.Responsible_Name;
    if (rep) { const pNode = getOrCreate('person', rep, rep, { role:'代表人' }); getOrCreateEdge(cNode.id, pNode.id, '代表人'); }
    const addr = data.Company_Location;
    if (addr) { const aNode = getOrCreate('address', addr.substring(0,20), addr, { fullAddress:addr }); getOrCreateEdge(cNode.id, aNode.id, '地址'); }
    directors.forEach(d => {
      const dName = d.Name; if (!dName||dName==='—') return;
      const dTitle = d.Title||'董事';
      if (d.Representative_Name && d.Representative_Name!==dName) {
        const lNode = getOrCreate('legalEntity', d.Representative_Name, d.Representative_Name, { role:dTitle });
        getOrCreateEdge(cNode.id, lNode.id, dTitle);
        const rNode = getOrCreate('person', dName, dName, { role:'法人代表' });
        getOrCreateEdge(lNode.id, rNode.id, '法人代表');
      } else {
        const pNode = getOrCreate('person', dName, dName, { role:dTitle });
        getOrCreateEdge(cNode.id, pNode.id, dTitle);
      }
    });
    const gi = document.getElementById('graphEmpty2');
    if (gi) gi.style.display = 'none';
    updateInfo(); startSim();
  }

  function clear() {
    nodes=[]; edges=[]; panX=0; panY=0; scale=1;
    const gi = document.getElementById('graphEmpty2');
    if (gi) gi.style.display='flex';
    updateInfo(); draw();
  }

  function updateInfo() {
    const el = document.getElementById('graphInfo2'); if (!el) return;
    if (!nodes.length) { el.textContent=''; return; }
    el.textContent = `節點：${nodes.length}（公司 ${nodes.filter(n=>n.type==='company').length}｜人員 ${nodes.filter(n=>n.type==='person').length}）　連線：${edges.length}`;
  }

  function simulate() {
    if (!nodes.length) return;
    const cx=canvas.width/2, cy=canvas.height/2;
    for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
      const a=nodes[i],b=nodes[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=REPULSION/(d*d);
      a.vx-=dx/d*f; a.vy-=dy/d*f; b.vx+=dx/d*f; b.vy+=dy/d*f;
    }
    edges.forEach(e => {
      const s=nodes.find(n=>n.id===e.source),t=nodes.find(n=>n.id===e.target); if(!s||!t) return;
      const dx=t.x-s.x,dy=t.y-s.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-160)*ATTRACTION;
      s.vx+=dx/d*f; s.vy+=dy/d*f; t.vx-=dx/d*f; t.vy-=dy/d*f;
    });
    nodes.forEach(n => { n.vx+=(cx-n.x)*GRAVITY; n.vy+=(cy-n.y)*GRAVITY; });
    nodes.forEach(n => { if(n===dragNode)return; n.vx*=DAMPING; n.vy*=DAMPING; n.x+=n.vx; n.y+=n.vy; });
  }

  function startSim() { simTick=250; if(!animFrame) loop(); }
  function loop() { if(simTick>0){simulate();simTick--;} draw(); animFrame=requestAnimationFrame(loop); }

  function w2s(x,y) { return {sx:x*scale+panX, sy:y*scale+panY}; }
  function s2w(sx,sy) { return {x:(sx-panX)/scale, y:(sy-panY)/scale}; }

  function innerLines(label, type) {
    if (type==='address') return ['地址'];
    if (type==='person') {
      const name=label.trim();
      if (name.length<=2) return [name];
      if (name.length===3) return [name[0], name.substring(1)];
      return [name.substring(0,2), name.substring(2,4)];
    }
    const s=label.replace(/股份有限公司$/,'').replace(/有限公司$/,'').replace(/股份公司$/,'').replace(/公司$/,'').trim();
    if (s.length<=3) return [s];
    if (s.length<=5) return [s.substring(0,2), s.substring(2)];
    return [s.substring(0,3), s.substring(3,6)];
  }

  function draw() {
    if (!ctx||!canvas.width) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='rgba(255,255,255,0.025)';
    const sp=40*scale, ox=panX%sp, oy=panY%sp;
    for (let x=ox;x<canvas.width;x+=sp) for (let y=oy;y<canvas.height;y+=sp) { ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill(); }
    edges.forEach(e => {
      const s=nodes.find(n=>n.id===e.source),t=nodes.find(n=>n.id===e.target); if(!s||!t) return;
      const {sx:x1,sy:y1}=w2s(s.x,s.y),{sx:x2,sy:y2}=w2s(t.x,t.y);
      const color=EDGE_COLOR[e.label]||EDGE_COLOR.default;
      ctx.save(); ctx.strokeStyle=color; ctx.globalAlpha=0.4; ctx.lineWidth=1.5; ctx.setLineDash([5,5]);
      ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.setLineDash([]);
      if (scale>0.5) {
        const mx=(x1+x2)/2,my=(y1+y2)/2,fs=Math.max(9,Math.round(10*scale));
        ctx.font=`${fs}px 'JetBrains Mono',monospace`;
        const tw=ctx.measureText(e.label).width+8;
        ctx.globalAlpha=0.55;ctx.fillStyle='#0d0f14';ctx.fillRect(mx-tw/2,my-fs*0.7,tw,fs*1.4);
        ctx.globalAlpha=0.9;ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(e.label,mx,my);
      }
      ctx.restore();
    });
    nodes.forEach(n => {
      const {sx,sy}=w2s(n.x,n.y),cfg=NODE_CFG[n.type]||NODE_CFG.company;
      const r=cfg.radius*Math.max(0.5,scale),isH=n===hoveredNode;
      const lines=innerLines(n.label,n.type);
      ctx.save();
      if(isH){ctx.shadowColor=cfg.color;ctx.shadowBlur=18;}
      ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI*2);ctx.fillStyle=isH?cfg.color:cfg.dark;ctx.fill();
      ctx.strokeStyle=cfg.color;ctx.lineWidth=2;ctx.stroke();ctx.shadowBlur=0;
      ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
      const fs=lines.length===1?Math.max(8,Math.round(r*0.52)):Math.max(7,Math.round(r*0.38));
      ctx.font=`bold ${fs}px 'Noto Serif TC',serif`;
      const lineH=fs*1.2,totalH=lineH*lines.length;
      lines.forEach((line,i)=>ctx.fillText(line,sx,sy-totalH/2+lineH*(i+0.5)));
      ctx.restore();
    });
  }

  function mpos(e) { const r=canvas.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }
  function nodeAt(sx,sy) {
    const {x,y}=s2w(sx,sy);
    for (let i=nodes.length-1;i>=0;i--) {
      const n=nodes[i],cfg=NODE_CFG[n.type]||NODE_CFG.company,dx=n.x-x,dy=n.y-y;
      if(Math.sqrt(dx*dx+dy*dy)<=cfg.radius+4) return n;
    }
    return null;
  }

  let mouseDownPos=null;
  function onMouseDown(e) {
    const {x,y}=mpos(e); mouseDownPos={x,y};
    const node=nodeAt(x,y);
    if(node){isDragging=true;dragNode=node;const w=s2w(x,y);dragOffX=node.x-w.x;dragOffY=node.y-w.y;node.vx=0;node.vy=0;simTick=80;if(!animFrame)loop();}
    else panStart={x,y,px:panX,py:panY};
  }
  function onMouseMove(e) {
    const {x,y}=mpos(e);
    if(isDragging&&dragNode){const {x:wx,y:wy}=s2w(x,y);dragNode.x=wx+dragOffX;dragNode.y=wy+dragOffY;simTick=40;if(!animFrame)loop();return;}
    if(panStart){panX=panStart.px+(x-panStart.x);panY=panStart.py+(y-panStart.y);if(!animFrame)draw();return;}
    const n=nodeAt(x,y);
    if(n!==hoveredNode){hoveredNode=n;canvas.style.cursor=n?'pointer':'grab';if(!animFrame)draw();}
    if(n){tooltip.textContent=n.label;tooltip.style.left=(x+14)+'px';tooltip.style.top=(y-14)+'px';tooltip.classList.add('visible');}
    else hideTooltip();
  }
  function onMouseUp(e) { isDragging=false;dragNode=null;panStart=null;mouseDownPos=null; }
  function onWheel(e) {
    e.preventDefault();
    const {x,y}=mpos(e),delta=e.deltaY>0?0.88:1.14,ns=Math.max(0.15,Math.min(4,scale*delta));
    panX=x-(x-panX)*(ns/scale);panY=y-(y-panY)*(ns/scale);scale=ns;if(!animFrame)draw();
  }
  function hideTooltip(){tooltip.classList.remove('visible');}
  function exportPNG(){const a=document.createElement('a');a.download='person-relation-graph.png';a.href=canvas.toDataURL('image/png');a.click();}

  return { init, addCompany, clear, exportPNG };
})();
