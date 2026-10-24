// @ts-nocheck
/**
 * main.js — Living Blueprint Webview Client
 *
 * Implements interactive 3D isometric house projection, companion dialogue,
 * architectural graph exploration, room ledger, and strictly typed host communication.
 * Strictly avoids unescaped dynamic innerHTML assignments for CSP compliance.
 */

(function () {
  const vscode = acquireVsCodeApi();

  // Tab Switching
  const tabHouse = document.getElementById('tabHouse');
  const tabCompanions = document.getElementById('tabCompanions');
  const tabGraph = document.getElementById('tabGraph');
  const tabLedger = document.getElementById('tabLedger');

  const panelHouse = document.getElementById('panelHouse');
  const panelCompanions = document.getElementById('panelCompanions');
  const panelGraph = document.getElementById('panelGraph');
  const panelLedger = document.getElementById('panelLedger');

  function setActiveTab(activeBtn, activePanel) {
    [tabHouse, tabCompanions, tabGraph, tabLedger].forEach((b) => b && b.classList.remove('active'));
    [panelHouse, panelCompanions, panelGraph, panelLedger].forEach((p) => p && p.classList.add('hidden'));
    if (activeBtn) activeBtn.classList.add('active');
    if (activePanel) activePanel.classList.remove('hidden');
  }

  if (tabHouse) tabHouse.addEventListener('click', () => setActiveTab(tabHouse, panelHouse));
  if (tabCompanions) tabCompanions.addEventListener('click', () => setActiveTab(tabCompanions, panelCompanions));
  if (tabGraph) {
    tabGraph.addEventListener('click', () => {
      setActiveTab(tabGraph, panelGraph);
      if (currentGraph) renderGraph(currentGraph);
    });
  }
  if (tabLedger) tabLedger.addEventListener('click', () => setActiveTab(tabLedger, panelLedger));

  // Action Buttons
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
  }

  const btnOpenCanvas = document.getElementById('btnOpenCanvas');
  if (btnOpenCanvas) {
    btnOpenCanvas.addEventListener('click', () => {
      vscode.postMessage({ command: 'openEditorPanel' });
    });
  }

  const configKeyBtn = document.getElementById('configKeyBtn');
  if (configKeyBtn) {
    configKeyBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'configureApiKey' });
    });
  }

  const consentCheckbox = document.getElementById('consentCheckbox');
  if (consentCheckbox) {
    consentCheckbox.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'toggleAiConsent', enabled: e.target.checked });
    });
  }

  const folderSelect = document.getElementById('folderSelect');
  if (folderSelect) {
    folderSelect.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'selectFolder', folderPath: e.target.value });
    });
  }

  // Companion Chat
  const inputEl = document.getElementById('companionInput');
  const sendBtn = document.getElementById('sendBtn');

  function sendQuery() {
    if (!inputEl) return;
    const q = inputEl.value.trim();
    if (!q) return;
    inputEl.value = '';
    appendUserBubble(q);
    vscode.postMessage({ command: 'askCompanion', question: q });
  }

  if (sendBtn) sendBtn.addEventListener('click', sendQuery);
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendQuery();
    });
  }

  function appendUserBubble(text) {
    const thread = document.getElementById('companionThread');
    if (!thread) return;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bubble-user';

    const col = document.createElement('div');
    col.className = 'bubble-content-col';

    const header = document.createElement('div');
    header.className = 'bubble-header';
    const speaker = document.createElement('span');
    speaker.className = 'bubble-speaker';
    speaker.textContent = '👤 You';
    header.appendChild(speaker);

    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = text;

    col.appendChild(header);
    col.appendChild(textEl);
    bubble.appendChild(col);

    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
  }

  // Isometric 3D Projection Math (matches IsometricHouse.tsx)
  const ORIGIN_X = 450;
  const ORIGIN_Y = 320;

  function toIso(x, y, z) {
    return {
      x: Number((ORIGIN_X + (x - y) * 0.866).toFixed(1)),
      y: Number((ORIGIN_Y + (x + y) * 0.5 - z).toFixed(1)),
    };
  }

  function polyPoints(pts) {
    return pts.map((p) => p.x + ',' + p.y).join(' ');
  }

  function createSvgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  // Global State
  let currentBlueprintData = null;
  let currentSelectedRoomId = null;
  let currentGraph = null;

  let houseZoom = 1.0;
  let housePanX = 0;
  let housePanY = 0;

  const houseZoomIn = document.getElementById('houseZoomIn');
  if (houseZoomIn) {
    houseZoomIn.addEventListener('click', () => {
      houseZoom = Math.min(2.2, houseZoom + 0.15);
      applyHouseTransform();
    });
  }
  const houseZoomOut = document.getElementById('houseZoomOut');
  if (houseZoomOut) {
    houseZoomOut.addEventListener('click', () => {
      houseZoom = Math.max(0.6, houseZoom - 0.15);
      applyHouseTransform();
    });
  }
  const houseZoomReset = document.getElementById('houseZoomReset');
  if (houseZoomReset) {
    houseZoomReset.addEventListener('click', () => {
      houseZoom = 1.0;
      housePanX = 0;
      housePanY = 0;
      applyHouseTransform();
    });
  }

  function applyHouseTransform() {
    const g = document.getElementById('houseTransformGroup');
    if (g) {
      g.setAttribute(
        'transform',
        'translate(' + housePanX + ',' + housePanY + ') scale(' + houseZoom + ')'
      );
    }
  }

  // Graph Pan & Zoom Controls
  let graphZoom = 1.0;
  let graphPanX = 0;
  let graphPanY = 0;

  const btnZoomIn = document.getElementById('btnZoomIn');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      graphZoom = Math.min(2.5, graphZoom + 0.2);
      applyGraphTransform();
    });
  }
  const btnZoomOut = document.getElementById('btnZoomOut');
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      graphZoom = Math.max(0.4, graphZoom - 0.2);
      applyGraphTransform();
    });
  }
  const btnZoomReset = document.getElementById('btnZoomReset');
  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', () => {
      graphZoom = 1.0;
      graphPanX = 0;
      graphPanY = 0;
      applyGraphTransform();
    });
  }

  function applyGraphTransform() {
    const vp = document.getElementById('svgViewport');
    if (vp) {
      vp.setAttribute(
        'transform',
        'translate(' + graphPanX + ',' + graphPanY + ') scale(' + graphZoom + ')'
      );
    }
  }

  // Room Style Tokens matching IsometricHouse.tsx
  function getRoomStyles(status, isSelected) {
    switch (status) {
      case 'verified':
        return {
          topFill: isSelected ? '#4A6149' : '#3E4E3D',
          leftFill: isSelected ? '#3D503C' : '#313E30',
          rightFill: isSelected ? '#435842' : '#384637',
          stroke: isSelected ? '#FFD166' : '#5B7A58',
          dash: 'none',
          badgeText: '✓ Verified',
          badgeBg: '#2C392C',
          badgeColor: '#A8D4A5',
        };
      case 'implemented':
      case 'in_progress':
        return {
          topFill: isSelected ? '#635133' : '#52432A',
          leftFill: isSelected ? '#4F4028' : '#3F3420',
          rightFill: isSelected ? '#57462C' : '#473A25',
          stroke: isSelected ? '#FFD166' : '#9E7A3E',
          dash: 'none',
          badgeText: '⚡ Implemented',
          badgeBg: '#3D311F',
          badgeColor: '#E0B565',
        };
      case 'planned':
        return {
          topFill: isSelected ? 'rgba(80, 71, 67, 0.45)' : 'rgba(56, 48, 45, 0.35)',
          leftFill: isSelected ? 'rgba(64, 56, 53, 0.45)' : 'rgba(44, 38, 35, 0.35)',
          rightFill: isSelected ? 'rgba(72, 63, 60, 0.45)' : 'rgba(50, 43, 40, 0.35)',
          stroke: isSelected ? '#FFD166' : '#7A706B',
          dash: '5,4',
          badgeText: '○ Planned',
          badgeBg: '#2E2725',
          badgeColor: '#9C908B',
        };
      case 'blocked':
        return {
          topFill: isSelected ? '#6D3838' : '#572C2C',
          leftFill: isSelected ? '#552B2B' : '#432222',
          rightFill: isSelected ? '#613131' : '#4C2727',
          stroke: isSelected ? '#FFD166' : '#9E4A4A',
          dash: 'none',
          badgeText: '✕ Blocked',
          badgeBg: '#3C2020',
          badgeColor: '#E28383',
        };
      default:
        return {
          topFill: isSelected ? '#4F4756' : '#3E3744',
          leftFill: isSelected ? '#3E3745' : '#2F2B36',
          rightFill: isSelected ? '#463E4D' : '#36313C',
          stroke: isSelected ? '#FFD166' : '#766782',
          dash: '3,3',
          badgeText: '? Unknown',
          badgeBg: '#2E2835',
          badgeColor: '#B6A6C5',
        };
    }
  }

  // Render 3D Isometric House
  function renderIsometricHouse(rooms, selectedRoomId) {
    // 1. Structural Pillars
    const pillarsLayer = document.getElementById('pillarsLayer');
    if (pillarsLayer) {
      pillarsLayer.textContent = '';
      const pillars = [
        { x: -180, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: 164, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: -180, y: 134, w: 16, d: 16, h: 40, z: -64 },
        { x: 164, y: 134, w: 16, d: 16, h: 40, z: -64 },
        { x: -8, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: -8, y: 134, w: 16, d: 16, h: 40, z: -64 },
      ];

      pillars.forEach((p) => {
        const pLeft = [
          toIso(p.x, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z + p.h),
          toIso(p.x, p.y + p.d, p.z + p.h),
        ];
        const pRight = [
          toIso(p.x + p.w, p.y, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z + p.h),
          toIso(p.x + p.w, p.y, p.z + p.h),
        ];
        const g = createSvgEl('g');
        g.appendChild(
          createSvgEl('polygon', {
            points: polyPoints(pLeft),
            fill: '#221A1A',
            stroke: '#3A2D2D',
            'stroke-width': '1',
          })
        );
        g.appendChild(
          createSvgEl('polygon', {
            points: polyPoints(pRight),
            fill: '#1A1414',
            stroke: '#3A2D2D',
            'stroke-width': '1',
          })
        );
        pillarsLayer.appendChild(g);
      });
    }

    // 2. Foundation Base Slab
    const foundationLayer = document.getElementById('foundationLayer');
    if (foundationLayer) {
      foundationLayer.textContent = '';
      const foundation = { x: -190, y: -150, w: 380, d: 300, h: 22, baseZ: -24 };
      const fTop = [
        toIso(foundation.x, foundation.y, 0),
        toIso(foundation.x + foundation.w, foundation.y, 0),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x, foundation.y + foundation.d, 0),
      ];
      const fLeft = [
        toIso(foundation.x, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x, foundation.y + foundation.d, 0),
      ];
      const fRight = [
        toIso(foundation.x + foundation.w, foundation.y, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x + foundation.w, foundation.y, 0),
      ];

      foundationLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(fLeft),
          fill: '#241C1C',
          stroke: '#443535',
          'stroke-width': '1.2',
        })
      );
      foundationLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(fRight),
          fill: '#1C1616',
          stroke: '#443535',
          'stroke-width': '1.2',
        })
      );
      foundationLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(fTop),
          fill: '#332727',
          stroke: '#4E3D3D',
          'stroke-width': '1.5',
        })
      );
      foundationLayer.appendChild(
        createSvgEl('line', {
          x1: toIso(foundation.x, 0, 0).x,
          y1: toIso(foundation.x, 0, 0).y,
          x2: toIso(foundation.x + foundation.w, 0, 0).x,
          y2: toIso(foundation.x + foundation.w, 0, 0).y,
          stroke: '#423232',
          'stroke-width': '1',
          'stroke-dasharray': '4,4',
        })
      );
      foundationLayer.appendChild(
        createSvgEl('line', {
          x1: toIso(0, foundation.y, 0).x,
          y1: toIso(0, foundation.y, 0).y,
          x2: toIso(0, foundation.y + foundation.d, 0).x,
          y2: toIso(0, foundation.y + foundation.d, 0).y,
          stroke: '#423232',
          'stroke-width': '1',
          'stroke-dasharray': '4,4',
        })
      );

      const fText = createSvgEl('text', {
        x: toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).x,
        y: toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).y,
        fill: '#8C7A70',
        'font-size': '10',
        'font-family': 'ui-monospace, monospace',
        'letter-spacing': '1.2',
        'font-weight': '600',
        transform: 'rotate(18, 450, 480)',
        'pointer-events': 'none',
      });
      fText.textContent = 'FOUNDATION: REPOSITORY ROOT · RUNTIME PLATFORM';
      foundationLayer.appendChild(fText);
    }

    // 3. Rooms Layer (sorted back to front)
    const roomsLayer = document.getElementById('roomsLayer');
    if (roomsLayer) {
      roomsLayer.textContent = '';

      const sortedRooms = [...rooms].sort((a, b) => {
        const depthA = (a.coords?.isoX ?? 0) + (a.coords?.isoY ?? 0);
        const depthB = (b.coords?.isoX ?? 0) + (b.coords?.isoY ?? 0);
        return depthA - depthB;
      });

      sortedRooms.forEach((room) => {
        const coords = {
          x: room.coords?.isoX ?? 0,
          y: room.coords?.isoY ?? 0,
          w: room.coords?.width ?? 160,
          d: room.coords?.depth ?? 120,
          h: room.coords?.height ?? 80,
          z: 0,
        };

        const isSelected = selectedRoomId === room.id;
        const styles = getRoomStyles(room.status, isSelected);

        const rTop = [
          toIso(coords.x, coords.y, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
        ];
        const rLeft = [
          toIso(coords.x, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
        ];
        const rRight = [
          toIso(coords.x + coords.w, coords.y, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
        ];

        const centerIso = toIso(
          coords.x + coords.w / 2,
          coords.y + coords.d / 2,
          coords.z + coords.h
        );

        const g = createSvgEl('g', {
          class: 'room-poly ' + (isSelected ? 'selected' : ''),
          id: 'room-node-' + room.id,
        });

        g.appendChild(
          createSvgEl('polygon', {
            points: polyPoints(rLeft),
            fill: styles.leftFill,
            stroke: isSelected ? '#FFD166' : styles.stroke,
            'stroke-width': isSelected ? '2' : '1.2',
            'stroke-dasharray': styles.dash,
          })
        );
        g.appendChild(
          createSvgEl('polygon', {
            points: polyPoints(rRight),
            fill: styles.rightFill,
            stroke: isSelected ? '#FFD166' : styles.stroke,
            'stroke-width': isSelected ? '2' : '1.2',
            'stroke-dasharray': styles.dash,
          })
        );
        g.appendChild(
          createSvgEl('polygon', {
            points: polyPoints(rTop),
            fill: styles.topFill,
            stroke: isSelected ? '#FFE5A3' : styles.stroke,
            'stroke-width': isSelected ? '2.5' : '1.4',
            'stroke-dasharray': styles.dash,
          })
        );

        if (isSelected) {
          g.appendChild(
            createSvgEl('polygon', {
              points: polyPoints(rTop),
              fill: 'none',
              stroke: '#FFD166',
              'stroke-width': '3.5',
              opacity: '0.8',
              'pointer-events': 'none',
            })
          );
        }

        const labelGroup = createSvgEl('g', {
          'pointer-events': 'none',
          transform: 'translate(' + centerIso.x + ', ' + (centerIso.y - 10) + ')',
        });

        const titleText = createSvgEl('text', {
          x: '0',
          y: '-4',
          'text-anchor': 'middle',
          fill: '#E6DFDA',
          'font-size': '11',
          'font-weight': '600',
          'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
        });
        titleText.textContent = room.name || '';
        labelGroup.appendChild(titleText);

        labelGroup.appendChild(
          createSvgEl('rect', {
            x: '-36',
            y: '5',
            width: '72',
            height: '16',
            rx: '3',
            fill: styles.badgeBg,
            stroke: isSelected ? '#FFD166' : styles.stroke,
            'stroke-width': '0.8',
          })
        );

        const badgeText = createSvgEl('text', {
          x: '0',
          y: '16',
          'text-anchor': 'middle',
          fill: styles.badgeColor,
          'font-size': '9',
          'font-family': 'ui-monospace, monospace',
          'font-weight': '600',
        });
        badgeText.textContent = styles.badgeText;
        labelGroup.appendChild(badgeText);

        g.appendChild(labelGroup);

        g.addEventListener('click', () => {
          selectRoom(room.id);
        });

        roomsLayer.appendChild(g);
      });
    }

    // 4. Roof Structure
    const roofLayer = document.getElementById('roofLayer');
    if (roofLayer) {
      roofLayer.textContent = '';
      const roof = { x: -190, y: -150, w: 380, d: 300, baseZ: 145, peakZ: 195 };
      const roofGableFront = [
        toIso(roof.x, roof.y + roof.d, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
        toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
      ];
      const roofLeftSlope = [
        toIso(roof.x, roof.y, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
        toIso(roof.x, roof.y + roof.d, roof.baseZ),
      ];
      const roofRightSlope = [
        toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
        toIso(roof.x + roof.w, roof.y, roof.baseZ),
        toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
      ];

      roofLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(roofLeftSlope),
          fill: 'rgba(84, 66, 66, 0.4)',
          stroke: '#9E7A7A',
          'stroke-width': '1.5',
        })
      );
      roofLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(roofRightSlope),
          fill: 'rgba(68, 52, 52, 0.4)',
          stroke: '#9E7A7A',
          'stroke-width': '1.5',
        })
      );
      roofLayer.appendChild(
        createSvgEl('polygon', {
          points: polyPoints(roofGableFront),
          fill: 'rgba(74, 58, 58, 0.25)',
          stroke: '#8A6E6E',
          'stroke-width': '1.5',
        })
      );
      roofLayer.appendChild(
        createSvgEl('line', {
          x1: toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).x,
          y1: toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).y,
          x2: toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).x,
          y2: toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).y,
          stroke: '#A88B8B',
          'stroke-width': '2',
        })
      );
    }
  }

  function selectRoom(roomId) {
    currentSelectedRoomId = roomId;
    vscode.postMessage({ command: 'selectRoom', roomId });
    updateInspector();
    if (currentBlueprintData) {
      renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
    }
  }

  function updateInspector() {
    if (!currentBlueprintData || !currentSelectedRoomId) return;
    const room = (currentBlueprintData.rooms || []).find((r) => r.id === currentSelectedRoomId);
    if (!room) return;

    const nameEl = document.getElementById('inspectorRoomName');
    if (nameEl) nameEl.textContent = room.name || 'Unnamed Module';

    const pill = document.getElementById('inspectorRoomPill');
    if (pill) {
      pill.className = 'status-pill pill-' + (room.status || 'unknown');
      pill.textContent = (room.status || 'unknown').toUpperCase();
    }

    const layerEl = document.getElementById('inspectorRoomLayer');
    if (layerEl) {
      layerEl.textContent = room.layer ? 'LAYER: ' + room.layer.toUpperCase() : '';
    }

    const descEl = document.getElementById('inspectorRoomDesc');
    if (descEl) {
      descEl.textContent = room.description || 'No description recorded for this module.';
    }

    const evEl = document.getElementById('inspectorRoomEvidence');
    if (evEl) {
      if (room.evidence) {
        evEl.classList.remove('hidden');
        evEl.textContent = 'Evidence: ' + room.evidence;
      } else {
        evEl.classList.add('hidden');
      }
    }

    const filesEl = document.getElementById('inspectorRoomFiles');
    if (filesEl) {
      filesEl.textContent = '';
      const paths = room.filePaths || [];
      if (paths.length === 0) {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'text-empty-hint';
        emptySpan.textContent = 'No files tracked directly under this room.';
        filesEl.appendChild(emptySpan);
      } else {
        paths.forEach((fp) => {
          const pillEl = document.createElement('a');
          pillEl.className = 'file-pill';
          pillEl.textContent = '📄 ' + (fp.split('/').pop() || fp);
          pillEl.title = fp + ' (Click to open file in editor)';
          pillEl.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'openFile', path: fp, line: 1 });
          });
          filesEl.appendChild(pillEl);
        });
      }
    }
  }

  // Message Listener
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'scanState': {
        const banner = document.getElementById('scanStateBanner');
        if (banner && msg.state) {
          if (msg.state.status === 'idle') {
            banner.classList.add('hidden');
            banner.textContent = '';
          } else {
            banner.classList.remove('hidden');
            banner.textContent =
              (msg.state.message || msg.state.status) +
              (msg.state.isStale ? ' [Stale Snapshot]' : '');

            banner.className = 'scan-state-banner';
            if (msg.state.status === 'error') {
              banner.classList.add('scan-banner-error');
            } else if (msg.state.status === 'empty') {
              banner.classList.add('scan-banner-empty');
            } else if (msg.state.status === 'truncated') {
              banner.classList.add('scan-banner-truncated');
            } else {
              banner.classList.add('scan-banner-default');
            }
          }
        }
        break;
      }
      case 'workspaceFolders': {
        const sel = document.getElementById('folderSelect');
        if (sel && Array.isArray(msg.folders)) {
          if (msg.folders.length > 1) {
            sel.classList.remove('hidden');
            sel.textContent = '';
            msg.folders.forEach((f) => {
              const opt = document.createElement('option');
              opt.value = f.uri.fsPath;
              opt.textContent = f.name;
              if (f.uri.fsPath === msg.activeFolderPath) opt.selected = true;
              sel.appendChild(opt);
            });
          } else {
            sel.classList.add('hidden');
          }
        }
        break;
      }
      case 'scanningStatus': {
        const indicator = document.getElementById('scanningIndicator');
        if (indicator) {
          if (msg.isScanning) indicator.classList.add('active');
          else indicator.classList.remove('active');
        }
        break;
      }
      case 'securityState': {
        const modeBadge = document.getElementById('modeBadge');
        if (modeBadge) {
          if (msg.hasApiKey && msg.aiConsent) {
            modeBadge.textContent = 'Cloud AI Active';
            modeBadge.style.color = '#E0B565';
          } else {
            modeBadge.textContent = 'Offline Safe';
            modeBadge.style.color = 'var(--text-secondary)';
          }
        }
        if (consentCheckbox) {
          consentCheckbox.checked = Boolean(msg.aiConsent);
        }
        break;
      }
      case 'updateBlueprint': {
        currentBlueprintData = msg.data;
        currentSelectedRoomId = msg.selectedRoomId || (msg.data.rooms[0]?.id ?? null);
        currentGraph = msg.data.graph;
        renderBlueprint(msg.data);
        renderIsometricHouse(msg.data.rooms || [], currentSelectedRoomId);
        updateInspector();
        renderLedger(msg.data.rooms || []);
        break;
      }
      case 'companionAnalysis': {
        renderCompanionAnalysis(msg.analysis);
        break;
      }
      case 'companionReplies': {
        appendCompanionReplies(msg.messages);
        break;
      }
      case 'companionThinking': {
        const thread = document.getElementById('companionThread');
        let el = document.getElementById('thinkingBubble');
        if (msg.isThinking) {
          if (!el && thread) {
            el = document.createElement('div');
            el.id = 'thinkingBubble';
            el.className = 'chat-bubble bubble-dog';

            const avCol = document.createElement('div');
            avCol.className = 'bubble-avatar-col';
            avCol.appendChild(createPixelDogSvg(20));
            el.appendChild(avCol);

            const cCol = document.createElement('div');
            cCol.className = 'bubble-content-col';
            const spk = document.createElement('span');
            spk.className = 'speaker-dog speaker-title-bold';
            spk.textContent = 'Barkley';
            const thk = document.createElement('span');
            thk.className = 'thinking-subtle';
            thk.textContent = 'Consulting architectural scan & evidence ledger...';
            cCol.appendChild(spk);
            cCol.appendChild(thk);
            el.appendChild(cCol);

            thread.appendChild(el);
            thread.scrollTop = thread.scrollHeight;
          }
        } else if (el) {
          el.remove();
        }
        break;
      }
      case 'roomSelected': {
        currentSelectedRoomId = msg.roomId;
        updateInspector();
        if (currentBlueprintData) {
          renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
        }
        break;
      }
    }
  });

  function renderBlueprint(data) {
    const statusText = document.getElementById('headerStatusText');
    if (statusText) statusText.textContent = data.workspaceName || 'Workspace Discovered';

    const discCount = document.getElementById('discoveredCount');
    if (discCount) discCount.textContent = data.discoveredFilesCount ?? 0;

    const inspCount = document.getElementById('inspectedCount');
    if (inspCount) inspCount.textContent = data.inspectedFilesCount ?? 0;

    const stampEl = document.getElementById('scanTimestamp');
    if (stampEl && data.scannedAt) {
      const d = new Date(data.scannedAt);
      stampEl.textContent =
        'Scanned: ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // Summary Pills
    const summaryContainer = document.getElementById('summaryPills');
    if (summaryContainer) {
      summaryContainer.textContent = '';
      const summary = data.statusSummary || {};
      const statusTypes = ['verified', 'implemented', 'planned', 'blocked', 'unknown'];
      statusTypes.forEach((st) => {
        const count = summary[st] || 0;
        if (count > 0 || st === 'verified' || st === 'implemented') {
          const pill = document.createElement('span');
          pill.className = 'status-pill pill-' + st;
          pill.textContent = count + ' ' + st.charAt(0).toUpperCase() + st.slice(1);
          summaryContainer.appendChild(pill);
        }
      });
    }
  }

  function renderCompanionAnalysis(analysis) {
    if (!analysis) return;
    const thread = document.getElementById('companionThread');
    if (!thread) return;
    thread.textContent = '';

    (analysis.messages || []).forEach((msg) => {
      thread.appendChild(createCompanionBubble(msg));
    });

    // Suggestion Chips
    const suggRow = document.getElementById('suggestionsRow');
    if (suggRow) {
      suggRow.textContent = '';
      (analysis.suggestedQuestions || []).forEach((q) => {
        const chip = document.createElement('button');
        chip.className = 'suggestion-chip';
        chip.textContent = q;
        chip.addEventListener('click', () => {
          appendUserBubble(q);
          vscode.postMessage({ command: 'askCompanion', question: q });
        });
        suggRow.appendChild(chip);
      });
    }

    thread.scrollTop = thread.scrollHeight;
  }

  function appendCompanionReplies(messages) {
    const thread = document.getElementById('companionThread');
    if (!thread) return;

    (messages || []).forEach((msg) => {
      thread.appendChild(createCompanionBubble(msg));
    });
    thread.scrollTop = thread.scrollHeight;
  }

  function createCompanionBubble(msg) {
    const isDog = msg.speaker === 'dog';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (isDog ? 'bubble-dog' : 'bubble-cat');

    const avatarCol = document.createElement('div');
    avatarCol.className = 'bubble-avatar-col';
    avatarCol.appendChild(isDog ? createPixelDogSvg(24) : createPixelCatSvg(24));
    bubble.appendChild(avatarCol);

    const contentCol = document.createElement('div');
    contentCol.className = 'bubble-content-col';

    const header = document.createElement('div');
    header.className = 'bubble-header';

    const speaker = document.createElement('span');
    speaker.className = 'bubble-speaker ' + (isDog ? 'speaker-dog' : 'speaker-cat');
    speaker.textContent = isDog ? 'Barkley' : 'Cleo';

    const tagline = document.createElement('span');
    tagline.className = 'bubble-tagline';
    tagline.textContent = isDog ? 'Architectural Companion' : 'Evidence Auditor';

    header.appendChild(speaker);
    header.appendChild(tagline);
    contentCol.appendChild(header);

    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = msg.text || '';
    contentCol.appendChild(textEl);

    if (msg.evidencePaths && msg.evidencePaths.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'evidence-chips';
      msg.evidencePaths.forEach((ep) => {
        const raw = ep.split(':');
        const p = raw[0];
        const line = raw[1] || '1';
        const a = document.createElement('a');
        a.className = 'file-pill';
        a.setAttribute('data-path', p);
        a.setAttribute('data-line', line);
        a.textContent = '🔍 ' + (p.split('/').pop() || p) + ':' + line;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ command: 'openFile', path: p, line: line });
        });
        chips.appendChild(a);
      });
      contentCol.appendChild(chips);
    }

    bubble.appendChild(contentCol);
    return bubble;
  }

  function renderLedger(rooms) {
    const list = document.getElementById('ledgerList');
    if (!list) return;
    list.textContent = '';

    rooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'ledger-card';

      const top = document.createElement('div');
      top.className = 'ledger-top';

      const title = document.createElement('span');
      title.className = 'ledger-title';
      title.textContent = room.name || 'Unnamed Module';

      const pill = document.createElement('span');
      pill.className = 'status-pill pill-' + (room.status || 'unknown');
      pill.textContent = (room.status || 'unknown').toUpperCase();

      top.appendChild(title);
      top.appendChild(pill);
      card.appendChild(top);

      if (room.description) {
        const desc = document.createElement('div');
        desc.className = 'ledger-desc';
        desc.textContent = room.description;
        card.appendChild(desc);
      }

      if (room.evidence) {
        const ev = document.createElement('div');
        ev.className = 'ledger-evidence';
        ev.textContent = 'Evidence: ' + room.evidence;
        card.appendChild(ev);
      }

      list.appendChild(card);
    });
  }

  function renderGraph(graph) {
    if (!graph || !graph.nodes) return;
    const nodesLayer = document.getElementById('nodesLayer');
    const edgesLayer = document.getElementById('edgesLayer');
    if (!nodesLayer || !edgesLayer) return;

    nodesLayer.textContent = '';
    edgesLayer.textContent = '';

    const nodeMap = new Map();
    graph.nodes.forEach((n) => nodeMap.set(n.id, n));

    (graph.edges || []).forEach((edge) => {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) return;

      const x1 = src.x + src.width / 2;
      const y1 = src.y + src.height;
      const x2 = tgt.x + tgt.width / 2;
      const y2 = tgt.y;

      const pathEl = createSvgEl('path', {
        d: 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + y2,
        class: 'graph-edge',
        'marker-end': 'url(#graphArrow)',
      });
      edgesLayer.appendChild(pathEl);
    });

    graph.nodes.forEach((node) => {
      const g = createSvgEl('g', {
        class: 'graph-node',
        transform: 'translate(' + node.x + ',' + node.y + ')',
      });

      let strokeColor = '#9E7A3E';
      const st = String(node.importance || '').toLowerCase();
      if (st === 'verified') strokeColor = '#5B7A58';
      else if (st === 'blocked') strokeColor = '#9E4A4A';
      else if (st === 'planned') strokeColor = '#7A706B';

      const rect = createSvgEl('rect', {
        width: String(node.width || 200),
        height: String(node.height || 75),
        rx: '6',
        ry: '6',
        fill: '#3A2E2E',
        stroke: strokeColor,
        'stroke-width': '1.5',
      });
      g.appendChild(rect);

      const t1 = createSvgEl('text', {
        x: '12',
        y: '26',
        class: 'node-title',
      });
      t1.textContent =
        node.label && node.label.length > 22 ? node.label.slice(0, 20) + '...' : node.label || '';
      g.appendChild(t1);

      const t2 = createSvgEl('text', {
        x: '12',
        y: '46',
        class: 'node-sub',
      });
      t2.textContent = node.subLabel || '';
      g.appendChild(t2);

      const t3 = createSvgEl('text', {
        x: '12',
        y: '62',
        class: 'node-tag',
      });
      t3.textContent =
        '[' +
        (node.classification || 'observed').toUpperCase() +
        '] ' +
        (node.filePath ? '📄 ' + node.filePath.split('/').pop() : '');
      g.appendChild(t3);

      g.addEventListener('click', () => {
        if (node.filePath) {
          vscode.postMessage({ command: 'openFile', path: node.filePath, line: 1 });
        }
      });

      nodesLayer.appendChild(g);
    });

    if (graph.bounds) {
      const svg = document.getElementById('graphSvg');
      if (svg) {
        const b = graph.bounds;
        svg.setAttribute(
          'viewBox',
          b.minX + ' ' + b.minY + ' ' + Math.max(600, b.width) + ' ' + Math.max(450, b.height)
        );
      }
    }
  }

  function createPixelDogSvg(size) {
    const svg = createSvgEl('svg', {
      viewBox: '0 0 16 16',
      width: String(size),
      height: String(size),
      class: 'pixel-avatar-svg',
    });
    const rects = [
      { x: 3, y: 1, w: 3, h: 4, f: '#4A2E1E' },
      { x: 4, y: 2, w: 1, h: 2, f: '#E2873A' },
      { x: 10, y: 1, w: 3, h: 4, f: '#4A2E1E' },
      { x: 11, y: 2, w: 1, h: 2, f: '#E2873A' },
      { x: 3, y: 4, w: 10, h: 7, f: '#C48E58' },
      { x: 4, y: 4, w: 8, h: 6, f: '#E2873A' },
      { x: 7, y: 5, w: 2, h: 2, f: '#FBE9CF' },
      { x: 4, y: 6, w: 2, h: 2, f: '#22150F' },
      { x: 5, y: 6, w: 1, h: 1, f: '#FFFFFF' },
      { x: 10, y: 6, w: 2, h: 2, f: '#22150F' },
      { x: 10, y: 6, w: 1, h: 1, f: '#FFFFFF' },
      { x: 5, y: 8, w: 6, h: 4, f: '#FBE9CF' },
      { x: 7, y: 8, w: 2, h: 2, f: '#1A0F0B' },
      { x: 7, y: 10, w: 2, h: 1, f: '#C46C2C' },
      { x: 4, y: 11, w: 8, h: 4, f: '#C48E58' },
      { x: 6, y: 11, w: 4, h: 4, f: '#FBE9CF' },
      { x: 4, y: 14, w: 2, h: 1, f: '#E2C9A6' },
      { x: 10, y: 14, w: 2, h: 1, f: '#E2C9A6' },
      { x: 1, y: 10, w: 2, h: 3, f: '#E2873A' },
    ];
    for (const r of rects) {
      svg.appendChild(
        createSvgEl('rect', {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          fill: r.f,
        })
      );
    }
    return svg;
  }

  function createPixelCatSvg(size) {
    const svg = createSvgEl('svg', {
      viewBox: '0 0 16 16',
      width: String(size),
      height: String(size),
      class: 'pixel-avatar-svg',
    });
    const rects = [
      { x: 3, y: 1, w: 2, h: 4, f: '#545B6B' },
      { x: 4, y: 2, w: 1, h: 2, f: '#F08D9A' },
      { x: 11, y: 1, w: 2, h: 4, f: '#545B6B' },
      { x: 11, y: 2, w: 1, h: 2, f: '#F08D9A' },
      { x: 3, y: 4, w: 10, h: 7, f: '#767E8F' },
      { x: 4, y: 4, w: 8, h: 6, f: '#8B909A' },
      { x: 4, y: 6, w: 2, h: 1, f: '#1B1C22' },
      { x: 4, y: 7, w: 2, h: 1, f: '#F5C542' },
      { x: 10, y: 6, w: 2, h: 1, f: '#1B1C22' },
      { x: 10, y: 7, w: 2, h: 1, f: '#F5C542' },
      { x: 6, y: 8, w: 4, h: 3, f: '#D9D4CC' },
      { x: 7, y: 8, w: 2, h: 1, f: '#E07A86' },
      { x: 2, y: 8, w: 2, h: 1, f: '#D9D4CC' },
      { x: 12, y: 8, w: 2, h: 1, f: '#D9D4CC' },
      { x: 4, y: 11, w: 8, h: 4, f: '#767E8F' },
      { x: 6, y: 11, w: 4, h: 3, f: '#D9D4CC' },
      { x: 4, y: 14, w: 2, h: 1, f: '#D9D4CC' },
      { x: 10, y: 14, w: 2, h: 1, f: '#D9D4CC' },
      { x: 12, y: 11, w: 2, h: 4, f: '#545B6B' },
    ];
    for (const r of rects) {
      svg.appendChild(
        createSvgEl('rect', {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          fill: r.f,
        })
      );
    }
    return svg;
  }
})();
