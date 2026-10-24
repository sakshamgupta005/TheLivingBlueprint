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
      if (currentGraph) {
        renderGraph(currentGraph);
      } else if (currentSelectedLensId !== 'modules') {
        switchArchitectureLens(currentSelectedLensId);
      }
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

  let confirmedAiConsent = false;
  const consentCheckbox = document.getElementById('consentCheckbox');
  if (consentCheckbox) {
    consentCheckbox.addEventListener('change', (e) => {
      const requestedState = e.target.checked;
      // Treat checkbox as a request to host: keep visual checkbox locked
      // to confirmed host state until securityState message confirms it.
      consentCheckbox.checked = confirmedAiConsent;
      vscode.postMessage({ command: 'toggleAiConsent', enabled: requestedState });
    });
  }

  const btnPreviewPayload = document.getElementById('btnPreviewPayload');
  const btnClosePayloadPreview = document.getElementById('btnClosePayloadPreview');
  const payloadPreviewDrawer = document.getElementById('payloadPreviewDrawer');

  if (btnPreviewPayload) {
    btnPreviewPayload.addEventListener('click', () => {
      if (payloadPreviewDrawer) {
        const isOpening = payloadPreviewDrawer.classList.contains('hidden');
        payloadPreviewDrawer.classList.toggle('hidden');
        if (isOpening) {
          requestHostPayloadPreview();
        }
      }
    });
  }

  if (btnClosePayloadPreview && payloadPreviewDrawer) {
    btnClosePayloadPreview.addEventListener('click', () => {
      payloadPreviewDrawer.classList.add('hidden');
    });
  }

  let currentActiveFolderPath = null;

  function resetWorkspaceFolderState() {
    currentSelectedRoomId = null;
    selectedGraphNodeId = null;
    storedFindingsByRoomId = {};
    latestReinspectionByRoomId = {};
    isReinspectingFinding = false;
    activeReinspectingRoomId = null;
    activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);
    isInvestigatingRoom = false;
    activeInvestigatingRoomId = null;
    activeInvestigationWatchdog = clearTimer(activeInvestigationWatchdog);
    isTestRunning = false;
    lastTestRunResult = null;
    if (testRunIndicatorBadge) {
      testRunIndicatorBadge.classList.add('hidden');
      testRunIndicatorBadge.textContent = '';
    }
    if (testRunBanner) {
      testRunBanner.classList.add('hidden');
    }
    cachedLensGraphs = {};
    cachedEvidenceChains = {};
    currentGraph = null;

    updateInspector();
    updateChatContextIndicator();
    updateInvestigationUi();
    updateEvidenceChainUi();
    updateTestRunButtonUi();

    if (currentBlueprintData) {
      renderIsometricHouse(currentBlueprintData.rooms || [], null);
    }
    const nodesLayer = document.getElementById('nodesLayer');
    const edgesLayer = document.getElementById('edgesLayer');
    if (nodesLayer) nodesLayer.textContent = '';
    if (edgesLayer) edgesLayer.textContent = '';
  }

  const folderSelect = document.getElementById('folderSelect');
  if (folderSelect) {
    folderSelect.addEventListener('change', (e) => {
      currentActiveFolderPath = e.target.value;
      resetWorkspaceFolderState();
      vscode.postMessage({ command: 'selectFolder', folderPath: e.target.value });
    });
  }

  // Companion Chat & State
  const inputEl = document.getElementById('companionInput');
  const sendBtn = document.getElementById('sendBtn');
  const btnClearChat = document.getElementById('btnClearChat');
  const chatContextIndicator = document.getElementById('chatContextIndicator');
  const explanationLevelSelect = document.getElementById('explanationLevelSelect');

  let currentExplanationLevel = 'intermediate';
  if (explanationLevelSelect && explanationLevelSelect.value) {
    currentExplanationLevel = explanationLevelSelect.value;
  }
  let isSending = false;
  let lastSubmittedQuestion = '';
  let sendWatchdogTimeout = null;
  let latestAnalysisQuestions = [];

  if (explanationLevelSelect) {
    explanationLevelSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (['beginner', 'intermediate', 'technical'].includes(val)) {
        currentExplanationLevel = val;
        updateChatContextIndicator();
        try {
          vscode.postMessage({ command: 'setExplanationLevel', level: val });
        } catch {
          // Safe fallback
        }
      }
    });
  }

  function getActiveRoom() {
    if (!currentSelectedRoomId || !currentBlueprintData || !Array.isArray(currentBlueprintData.rooms)) {
      return null;
    }
    return currentBlueprintData.rooms.find((r) => r.id === currentSelectedRoomId) || null;
  }

  function updateChatContextIndicator() {
    const badge = document.getElementById('contextRoomBadge');
    const levelBadge = document.getElementById('contextLevelBadge');
    const room = getActiveRoom();
    if (badge) {
      if (room) {
        badge.textContent = '📍 ' + (room.name || 'Module') + ' (' + (room.status || 'unknown').toUpperCase() + ')';
      } else {
        badge.textContent = 'All Modules (Workspace)';
      }
    }
    if (levelBadge) {
      const displayLevel = currentExplanationLevel.charAt(0).toUpperCase() + currentExplanationLevel.slice(1);
      levelBadge.textContent = '⚡ ' + displayLevel;
      levelBadge.title = 'Explanation depth: ' + displayLevel;
    }
  }

  function updateSendingState(sending) {
    isSending = sending;
    if (sendBtn) {
      sendBtn.disabled = sending;
      sendBtn.textContent = sending ? 'Thinking...' : 'Ask';
    }
    if (inputEl) {
      inputEl.disabled = sending;
      if (!sending) inputEl.focus();
    }
    if (btnClearChat) {
      btnClearChat.disabled = sending;
    }
    const chips = document.querySelectorAll('.suggestion-chip, .follow-up-chip');
    chips.forEach((c) => {
      c.disabled = sending;
    });
  }

  function startWatchdogTimer() {
    stopWatchdogTimer();
    sendWatchdogTimeout = setTimeout(() => {
      sendWatchdogTimeout = null;
      if (isSending) {
        updateSendingState(false);
        hideThinkingBubble();
        renderErrorNotice(
          {
            kind: 'timeout',
            title: 'Request Timed Out',
            message:
              'The companion query did not receive a response from the host within 25 seconds. Please try again.',
            retryable: true,
          },
          lastSubmittedQuestion
        );
      }
    }, 25000);
  }

  function stopWatchdogTimer() {
    sendWatchdogTimeout = clearTimer(sendWatchdogTimeout);
  }

  function showThinkingBubble(speakerName) {
    const thread = document.getElementById('companionThread');
    if (!thread) return;
    let el = document.getElementById('thinkingBubble');
    if (el) return;

    el = document.createElement('div');
    el.id = 'thinkingBubble';
    el.className = 'chat-bubble bubble-dog';

    const avCol = document.createElement('div');
    avCol.className = 'bubble-avatar-col';
    avCol.appendChild(createPixelDogSvg(20));
    el.appendChild(avCol);

    const cCol = document.createElement('div');
    cCol.className = 'bubble-content-col';

    const header = document.createElement('div');
    header.className = 'bubble-header';
    const spk = document.createElement('span');
    spk.className = 'bubble-speaker speaker-dog';
    spk.textContent = speakerName || 'Barkley';
    header.appendChild(spk);
    cCol.appendChild(header);

    const thk = document.createElement('div');
    thk.className = 'thinking-subtle';

    const room = getActiveRoom();
    if (room) {
      thk.textContent = 'Reviewing ' + (room.name || 'selected') + ' architecture and evidence ledger...';
    } else {
      thk.textContent = 'Consulting architectural scan & evidence ledger...';
    }
    cCol.appendChild(thk);

    el.appendChild(cCol);
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
  }

  function hideThinkingBubble() {
    const el = document.getElementById('thinkingBubble');
    if (el) el.remove();
  }

  function appendUserBubble(text, room) {
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

    if (room) {
      const roomTag = document.createElement('span');
      roomTag.className = 'bubble-room-tag';
      roomTag.textContent = '📍 ' + (room.name || 'Room');
      roomTag.title = 'Question grounded in: ' + (room.name || 'Room');
      header.appendChild(roomTag);
    }

    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = text;

    col.appendChild(header);
    col.appendChild(textEl);
    bubble.appendChild(col);

    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
  }

  function submitQuery(questionText) {
    if (isSending) return;
    const q = (questionText || '').trim();
    if (!q) return;

    const initialText = document.getElementById('initialAnalyzingState');
    if (initialText) initialText.remove();

    const emptyBox = document.querySelector('.chat-empty-state');
    if (emptyBox) emptyBox.remove();

    isSending = true;
    lastSubmittedQuestion = q;
    updateSendingState(true);

    if (inputEl) inputEl.value = '';

    const activeRoom = getActiveRoom();
    appendUserBubble(q, activeRoom);
    showThinkingBubble();

    vscode.postMessage({
      command: 'askCompanion',
      question: q,
      roomId: currentSelectedRoomId || undefined,
      explanationLevel: currentExplanationLevel,
    });

    startWatchdogTimer();
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      submitQuery(inputEl ? inputEl.value : '');
    });
  }
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        submitQuery(inputEl.value);
      }
    });
  }

  function requestClearConversation() {
    if (isSending) return;
    if (btnClearChat) {
      btnClearChat.disabled = true;
      btnClearChat.textContent = 'Clearing...';
    }
    try {
      vscode.postMessage({ command: 'clearConversation' });
    } catch {
      if (btnClearChat) {
        btnClearChat.disabled = false;
        btnClearChat.textContent = 'Clear';
      }
    }
    // Do NOT clear messages locally; wait for the host to confirm via conversationHistory.
  }

  /** Clears a pending timer and returns null, for `timer = clearTimer(timer)`. */
  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function handleHostConversationHistory(turns) {
    if (btnClearChat) {
      btnClearChat.disabled = false;
      btnClearChat.textContent = 'Clear';
    }
    stopWatchdogTimer();
    updateSendingState(false);
    hideThinkingBubble();

    const thread = document.getElementById('companionThread');
    if (!thread) return;

    if (!Array.isArray(turns) || turns.length === 0) {
      renderEmptyChatState();
      if (latestAnalysisQuestions && latestAnalysisQuestions.length > 0) {
        renderSuggestionsRow(latestAnalysisQuestions);
      }
      return;
    }

    thread.textContent = '';
    turns.forEach((turn) => {
      let room = null;
      if (turn.selectedRoomId && currentBlueprintData && Array.isArray(currentBlueprintData.rooms)) {
        room = currentBlueprintData.rooms.find((r) => r.id === turn.selectedRoomId) || null;
      }
      appendUserBubble(turn.question, room);
      (turn.replies || []).forEach((rep) => {
        thread.appendChild(
          createCompanionBubble({
            speaker: rep.speaker,
            speakerName: rep.speaker === 'cat' ? 'Cleo' : 'Barkley',
            text: rep.text,
            isAiGenerated: turn.mode === 'ai',
          })
        );
      });
    });

    if (latestAnalysisQuestions && latestAnalysisQuestions.length > 0) {
      renderSuggestionsRow(latestAnalysisQuestions);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  if (btnClearChat) {
    btnClearChat.addEventListener('click', requestClearConversation);
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

  // Architecture Lens & Graph Pan/Zoom State (P2-12)
  let currentSelectedLensId = 'modules';
  let cachedLensGraphs = {};
  let selectedGraphNodeId = null;
  let graphZoom = 1.0;
  let graphPanX = 0;
  let graphPanY = 0;
  let isPanningGraph = false;
  let panStartX = 0;
  let panStartY = 0;

  const architectureLensSelect = document.getElementById('architectureLensSelect');
  const lensStatusPill = document.getElementById('lensStatusPill');
  const lensInsufficientNotice = document.getElementById('lensInsufficientNotice');
  const graphTruthBanner = document.getElementById('graphTruthBanner');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const graphSvg = document.getElementById('graphSvg');

  function applyGraphTransform() {
    const vp = document.getElementById('svgViewport');
    if (vp) {
      vp.setAttribute(
        'transform',
        'translate(' + graphPanX + ',' + graphPanY + ') scale(' + graphZoom + ')'
      );
    }
  }

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      graphZoom = Math.min(3.5, graphZoom + 0.2);
      applyGraphTransform();
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      graphZoom = Math.max(0.3, graphZoom - 0.2);
      applyGraphTransform();
    });
  }
  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', () => {
      graphZoom = 1.0;
      graphPanX = 0;
      graphPanY = 0;
      applyGraphTransform();
    });
  }

  if (graphSvg) {
    graphSvg.addEventListener('mousedown', (e) => {
      if (e.target.closest('.graph-node') || e.target.closest('button')) return;
      isPanningGraph = true;
      panStartX = e.clientX - graphPanX;
      panStartY = e.clientY - graphPanY;
      graphSvg.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanningGraph) return;
      graphPanX = e.clientX - panStartX;
      graphPanY = e.clientY - panStartY;
      applyGraphTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isPanningGraph) {
        isPanningGraph = false;
        if (graphSvg) graphSvg.style.cursor = 'grab';
      }
    });

    graphSvg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 0.85;
        graphZoom = Math.max(0.25, Math.min(3.5, graphZoom * factor));
        applyGraphTransform();
      },
      { passive: false }
    );
  }

  function formatLensTitle(lensId) {
    switch (lensId) {
      case 'modules':
        return 'Modules Topology';
      case 'module_hierarchy':
        return 'Module Hierarchy';
      case 'config_wiring':
        return 'Config Wiring';
      case 'data_schema':
        return 'Data & Schemas';
      case 'state_transitions':
        return 'State Transitions';
      case 'error_paths':
        return 'Error Paths';
      default:
        return String(lensId || '').replace(/_/g, ' ');
    }
  }

  function updateLensStatusPill(lensId, sufficientEvidence) {
    if (!lensStatusPill) return;
    lensStatusPill.textContent = formatLensTitle(lensId);
    if (sufficientEvidence === false) {
      lensStatusPill.title = 'Insufficient evidence for this lens in current workspace';
    } else {
      lensStatusPill.title = 'Active architectural lens: ' + formatLensTitle(lensId);
    }
  }

  function highlightSelectedGraphNode(nodeId) {
    const nodes = document.querySelectorAll('#nodesLayer .graph-node');
    nodes.forEach((n) => {
      if (n.getAttribute('data-node-id') === nodeId) {
        n.classList.add('selected');
      } else {
        n.classList.remove('selected');
      }
    });
  }

  function switchArchitectureLens(lensId) {
    if (!lensId) return;
    currentSelectedLensId = lensId;
    if (architectureLensSelect && architectureLensSelect.value !== lensId) {
      architectureLensSelect.value = lensId;
    }
    updateLensStatusPill(lensId);

    if (lensInsufficientNotice) {
      lensInsufficientNotice.classList.add('hidden');
      lensInsufficientNotice.textContent = '';
    }

    if (lensId === 'modules') {
      if (graphTruthBanner) {
        graphTruthBanner.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = 'Static Module Topology:';
        graphTruthBanner.appendChild(strong);
        graphTruthBanner.appendChild(
          document.createTextNode(' Derived from discovered workspace dependencies.')
        );
      }
      const modGraph =
        cachedLensGraphs['modules'] || (currentBlueprintData && currentBlueprintData.graph);
      if (modGraph) {
        currentGraph = modGraph;
        renderGraph(currentGraph);
        if (selectedGraphNodeId) {
          highlightSelectedGraphNode(selectedGraphNodeId);
        }
      }
    } else {
      if (graphTruthBanner) {
        graphTruthBanner.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = 'Architecture Lens (' + formatLensTitle(lensId) + '):';
        graphTruthBanner.appendChild(strong);
        graphTruthBanner.appendChild(document.createTextNode(' Requesting lens from host...'));
      }
    }

    vscode.postMessage({
      command: 'selectArchitectureLens',
      lensId: lensId,
    });
  }

  if (architectureLensSelect) {
    architectureLensSelect.addEventListener('change', (e) => {
      switchArchitectureLens(e.target.value);
    });
  }

  function handleArchitectureLensResponse(msg) {
    if (!msg || !msg.lensId) return;
    const lensId = msg.lensId;

    if (msg.graph) {
      cachedLensGraphs[lensId] = msg.graph;
    }

    if (lensId === currentSelectedLensId) {
      updateLensStatusPill(lensId, msg.sufficientEvidence);

      if (architectureLensSelect && architectureLensSelect.value !== lensId) {
        architectureLensSelect.value = lensId;
      }

      if (
        msg.sufficientEvidence &&
        msg.graph &&
        Array.isArray(msg.graph.nodes) &&
        msg.graph.nodes.length > 0
      ) {
        if (lensInsufficientNotice) {
          lensInsufficientNotice.classList.add('hidden');
          lensInsufficientNotice.textContent = '';
        }
        currentGraph = msg.graph;

        if (graphTruthBanner) {
          graphTruthBanner.textContent = '';
          const strong = document.createElement('strong');
          strong.textContent = (msg.title || formatLensTitle(lensId)) + ':';
          graphTruthBanner.appendChild(strong);
          graphTruthBanner.appendChild(
            document.createTextNode(
              ' Derived from ' +
                msg.graph.nodes.length +
                ' node(s) and ' +
                ((msg.graph.edges || []).length) +
                ' edge(s).'
            )
          );
        }

        renderGraph(currentGraph);

        if (selectedGraphNodeId) {
          const exists = msg.graph.nodes.some((n) => n.id === selectedGraphNodeId);
          if (exists) {
            highlightSelectedGraphNode(selectedGraphNodeId);
          } else {
            selectedGraphNodeId = null;
          }
        }
      } else {
        // Honest Insufficient Evidence handling:
        // Do NOT substitute demo or synthetic nodes/edges.
        currentGraph = null;
        const nodesLayer = document.getElementById('nodesLayer');
        const edgesLayer = document.getElementById('edgesLayer');
        if (nodesLayer) nodesLayer.textContent = '';
        if (edgesLayer) edgesLayer.textContent = '';

        if (graphTruthBanner) {
          graphTruthBanner.textContent = '';
          const strong = document.createElement('strong');
          strong.textContent = (msg.title || formatLensTitle(lensId)) + ':';
          graphTruthBanner.appendChild(strong);
          graphTruthBanner.appendChild(document.createTextNode(' Insufficient evidence in workspace.'));
        }

        if (lensInsufficientNotice) {
          lensInsufficientNotice.classList.remove('hidden');
          lensInsufficientNotice.textContent = '';

          const iconSpan = document.createElement('span');
          iconSpan.className = 'lens-notice-icon';
          iconSpan.textContent = 'ℹ';
          lensInsufficientNotice.appendChild(iconSpan);

          const textSpan = document.createElement('div');
          textSpan.className = 'lens-notice-text';

          const titleEl = document.createElement('strong');
          titleEl.textContent = 'Insufficient Evidence: ';
          textSpan.appendChild(titleEl);

          const msgEl = document.createElement('span');
          msgEl.textContent =
            msg.message ||
            'Not enough evidence in the inspected workspace files to construct this architectural lens.';
          textSpan.appendChild(msgEl);

          const honestNote = document.createElement('div');
          honestNote.className = 'claim-number';
          honestNote.textContent =
            'Truthful Visualization: No synthetic or demo nodes are substituted.';
          textSpan.appendChild(honestNote);

          lensInsufficientNotice.appendChild(textSpan);
        }
      }
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
    updateChatContextIndicator();
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

    updateEvidenceChainUi();
    updateInvestigationUi();
  }

  // Project Test Runner State & Logic (P2-13)
  let isTestRunning = false;
  let isWorkspaceUntrusted = false;
  let lastTestRunResult = null;

  const btnRunProjectTests = document.getElementById('btnRunProjectTests');
  const runTestsIcon = document.getElementById('runTestsIcon');
  const btnRunTestsText = document.getElementById('btnRunTestsText');
  const testRunIndicatorBadge = document.getElementById('testRunIndicatorBadge');
  const testRunBanner = document.getElementById('testRunBanner');
  const testRunStatusPill = document.getElementById('testRunStatusPill');
  const testRunTimestamp = document.getElementById('testRunTimestamp');
  const testRunMessage = document.getElementById('testRunMessage');
  const testRunDetails = document.getElementById('testRunDetails');
  const btnDismissTestRunBanner = document.getElementById('btnDismissTestRunBanner');

  function updateTestRunButtonUi() {
    if (!btnRunProjectTests) return;
    if (isWorkspaceUntrusted) {
      btnRunProjectTests.disabled = true;
      btnRunProjectTests.classList.remove('running');
      btnRunProjectTests.title =
        'Local test execution is disabled in untrusted workspaces (Restricted Mode).';
      if (runTestsIcon) runTestsIcon.textContent = '🔒';
      if (btnRunTestsText) btnRunTestsText.textContent = 'Tests Disabled (Untrusted)';
    } else if (isTestRunning) {
      btnRunProjectTests.disabled = true;
      btnRunProjectTests.classList.add('running');
      btnRunProjectTests.title = 'A project test run is currently active...';
      if (runTestsIcon) runTestsIcon.textContent = '⏳';
      if (btnRunTestsText) btnRunTestsText.textContent = 'Running Tests...';
    } else {
      btnRunProjectTests.disabled = false;
      btnRunProjectTests.classList.remove('running');
      btnRunProjectTests.title =
        'Execute observed project test command to establish real verification evidence';
      if (runTestsIcon) runTestsIcon.textContent = '▶';
      if (btnRunTestsText) btnRunTestsText.textContent = 'Run Project Tests';
    }
  }

  function showTestRunUntrustedNotice() {
    if (!testRunBanner) return;
    testRunBanner.className = 'test-run-banner banner-unavailable';
    testRunBanner.classList.remove('hidden');

    if (testRunStatusPill) {
      testRunStatusPill.className = 'test-run-status-pill pill-unavailable';
      testRunStatusPill.textContent = 'RESTRICTED';
    }
    if (testRunTimestamp) {
      const now = new Date();
      testRunTimestamp.textContent = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    if (testRunMessage) {
      testRunMessage.textContent =
        'Local test execution is disabled in untrusted workspaces.';
    }
    if (testRunDetails) {
      testRunDetails.classList.remove('hidden');
      testRunDetails.textContent =
        'To run project tests, trust this workspace via VS Code ("Manage Workspace Trust"). The host enforces safety policies for command execution.';
    }
  }

  function showTestRunState(msg) {
    if (!testRunBanner) return;
    if (msg.state === 'running') {
      testRunBanner.className = 'test-run-banner banner-running';
      testRunBanner.classList.remove('hidden');

      if (testRunStatusPill) {
        testRunStatusPill.className = 'test-run-status-pill pill-running';
        testRunStatusPill.textContent = 'RUNNING';
      }
      if (testRunTimestamp) {
        const now = new Date();
        testRunTimestamp.textContent = now.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
      if (testRunMessage) {
        testRunMessage.textContent =
          msg.message || 'Executing project test command (confirmation modal may be pending)...';
      }
      if (testRunDetails) {
        testRunDetails.classList.remove('hidden');
        testRunDetails.textContent =
          'Executing observed test script. Host will capture exit code and attach verification evidence if tests pass.';
      }
    } else if (msg.state === 'idle') {
      if (testRunStatusPill && testRunStatusPill.textContent === 'RUNNING') {
        testRunStatusPill.className = 'test-run-status-pill pill-unavailable';
        testRunStatusPill.textContent = 'IDLE';
        if (testRunMessage && msg.message) {
          testRunMessage.textContent = msg.message;
        }
      }
    }
  }

  function showTestRunResult(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastTestRunResult = msg;
    isTestRunning = false;
    updateTestRunButtonUi();

    // Clear every room's cached evidence chain on test results
    cachedEvidenceChains = {};
    if (currentSelectedRoomId) {
      updateEvidenceChainUi();
    }

    if (!testRunBanner) return;
    testRunBanner.classList.remove('hidden');

    const status = String(msg.status || 'unavailable').toLowerCase();
    const hasEvidence = Boolean(msg.evidenceRecorded);
    const exitCodeText = msg.exitCode !== undefined ? ' (exit code: ' + msg.exitCode + ')' : '';

    if (testRunTimestamp) {
      const now = new Date();
      testRunTimestamp.textContent = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    if (status === 'passed') {
      if (hasEvidence) {
        testRunBanner.className = 'test-run-banner banner-passed';
        if (testRunStatusPill) {
          testRunStatusPill.className = 'test-run-status-pill pill-passed';
          testRunStatusPill.textContent = '✓ PASSED';
        }
        if (testRunMessage) {
          testRunMessage.textContent =
            msg.message || ('Tests passed for this snapshot' + exitCodeText + '. Verification evidence recorded.');
        }
        if (testRunDetails) {
          testRunDetails.classList.remove('hidden');
          testRunDetails.textContent =
            'Genuine observed evidence was attached to snapshot ' +
            (msg.fingerprint ? '[' + msg.fingerprint.slice(0, 8) + ']' : '(current)') +
            '. Test rooms and evidence chains are updated.';
        }
      } else {
        // CRITICAL: Passed command but evidence was not recorded
        testRunBanner.className = 'test-run-banner banner-unverified';
        if (testRunStatusPill) {
          testRunStatusPill.className = 'test-run-status-pill pill-unverified';
          testRunStatusPill.textContent = '○ NOT RECORDED';
        }
        if (testRunMessage) {
          testRunMessage.textContent =
            msg.message ||
            ('Test command succeeded' + exitCodeText + ', but evidence was not recorded for this snapshot.');
        }
        if (testRunDetails) {
          testRunDetails.classList.remove('hidden');
          testRunDetails.textContent =
            'Status remains unverified. Only runs with recorded evidence establish verified status for a snapshot.';
        }
      }
    } else if (status === 'failed') {
      testRunBanner.className = 'test-run-banner banner-failed';
      if (testRunStatusPill) {
        testRunStatusPill.className = 'test-run-status-pill pill-failed';
        testRunStatusPill.textContent = '✕ FAILED';
      }
      if (testRunMessage) {
        testRunMessage.textContent =
          msg.message || ('Test execution failed' + exitCodeText + '.');
      }
      if (testRunDetails) {
        testRunDetails.classList.remove('hidden');
        testRunDetails.textContent = hasEvidence
          ? 'Observed failure recorded as blocking evidence for snapshot ' + (msg.fingerprint ? '[' + msg.fingerprint.slice(0, 8) + ']' : '') + '.'
          : 'Observed failure' + exitCodeText + '. No persistent evidence recorded.';
      }
    } else if (status === 'cancelled') {
      testRunBanner.className = 'test-run-banner banner-cancelled';
      if (testRunStatusPill) {
        testRunStatusPill.className = 'test-run-status-pill pill-cancelled';
        testRunStatusPill.textContent = '○ CANCELLED';
      }
      if (testRunMessage) {
        testRunMessage.textContent =
          msg.message || 'Test run cancelled or confirmation dismissed.';
      }
      if (testRunDetails) {
        testRunDetails.classList.remove('hidden');
        testRunDetails.textContent =
          'No test execution occurred. No evidence was recorded; architecture status remains unchanged.';
      }
    } else if (status === 'timeout') {
      testRunBanner.className = 'test-run-banner banner-timeout';
      if (testRunStatusPill) {
        testRunStatusPill.className = 'test-run-status-pill pill-timeout';
        testRunStatusPill.textContent = '⏱ TIMEOUT';
      }
      if (testRunMessage) {
        testRunMessage.textContent =
          msg.message || 'Test execution exceeded the 120s timeout limit.';
      }
      if (testRunDetails) {
        testRunDetails.classList.remove('hidden');
        testRunDetails.textContent =
          'Process was terminated after timing out. No passing evidence was recorded.';
      }
    } else {
      testRunBanner.className = 'test-run-banner banner-unavailable';
      if (testRunStatusPill) {
        testRunStatusPill.className = 'test-run-status-pill pill-unavailable';
        testRunStatusPill.textContent = '○ UNAVAILABLE';
      }
      if (testRunMessage) {
        testRunMessage.textContent =
          msg.message || 'Test command is unavailable for this workspace.';
      }
      if (testRunDetails) {
        testRunDetails.classList.remove('hidden');
        testRunDetails.textContent =
          'Ensure package.json includes an observed "scripts.test" entry and workspace trust is granted.';
      }
    }
  }

  if (btnRunProjectTests) {
    btnRunProjectTests.addEventListener('click', () => {
      if (isTestRunning) return;
      if (isWorkspaceUntrusted) {
        showTestRunUntrustedNotice();
        return;
      }
      isTestRunning = true;
      updateTestRunButtonUi();
      showTestRunState({
        state: 'running',
        message: 'Requesting project test execution from host...',
      });
      vscode.postMessage({ command: 'runProjectTests' });
    });
  }

  if (btnDismissTestRunBanner && testRunBanner) {
    btnDismissTestRunBanner.addEventListener('click', () => {
      testRunBanner.classList.add('hidden');
    });
  }

  function handleTestRunEvidence(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (testRunIndicatorBadge) {
      if (msg.applied && !msg.stale) {
        testRunIndicatorBadge.classList.remove('hidden');
        testRunIndicatorBadge.className = 'test-run-indicator-badge badge-chain-verified';
        testRunIndicatorBadge.textContent = 'Evidence Active';
        testRunIndicatorBadge.title =
          'Observed test evidence is active for snapshot ' +
          (msg.fingerprint ? '[' + msg.fingerprint.slice(0, 8) + ']' : '(current)');
      } else if (msg.stale) {
        testRunIndicatorBadge.classList.remove('hidden');
        testRunIndicatorBadge.className = 'test-run-indicator-badge badge-chain-unverified';
        testRunIndicatorBadge.textContent = 'Evidence Stale';
        testRunIndicatorBadge.title =
          'Test evidence is stale: ' + (msg.message || 'code changed since last run') + '.';
      } else {
        testRunIndicatorBadge.classList.add('hidden');
        testRunIndicatorBadge.textContent = '';
      }
    }
  }

  // Evidence Chain State & Logic (P2-12)
  let cachedEvidenceChains = {};

  function updateEvidenceChainUi() {
    const panel = document.getElementById('evidenceChainPanel');
    const badge = document.getElementById('evidenceChainBadge');
    if (!panel) return;

    if (!currentSelectedRoomId) {
      panel.textContent = '';
      if (badge) badge.classList.add('hidden');
      return;
    }

    if (cachedEvidenceChains[currentSelectedRoomId]) {
      renderEvidenceChain(currentSelectedRoomId, cachedEvidenceChains[currentSelectedRoomId]);
    } else {
      panel.textContent = '';
      const loadBox = document.createElement('div');
      loadBox.className = 'evidence-chain-loading';
      const dot = document.createElement('span');
      dot.className = 'status-indicator-dot dot-pulsing';
      loadBox.appendChild(dot);
      const txt = document.createElement('span');
      txt.textContent = 'Mapping tests and inspecting CI evidence chain...';
      loadBox.appendChild(txt);
      panel.appendChild(loadBox);

      vscode.postMessage({
        command: 'requestEvidenceChain',
        roomId: currentSelectedRoomId,
      });
    }
  }

  function handleEvidenceChainResponse(msg) {
    if (!msg || !msg.roomId) return;
    cachedEvidenceChains[msg.roomId] = msg;
    if (msg.roomId === currentSelectedRoomId) {
      renderEvidenceChain(msg.roomId, msg);
    }
  }

  function sanitizeSecretText(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/([a-zA-Z0-9_-]*(?:api[_-]?key|secret|token|password|auth|bearer)[a-zA-Z0-9_-]*\s*[:=]\s*)(['"][^'"]+['"]|[^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/(?:ghp_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{33})/g, '[REDACTED]');
  }

  function isClaimEstablished(v) {
    return v === 'established' || v === true;
  }

  function renderEvidenceChain(roomId, data) {
    const panel = document.getElementById('evidenceChainPanel');
    const badge = document.getElementById('evidenceChainBadge');
    if (!panel) return;
    panel.textContent = '';

    if (data.error) {
      if (badge) {
        badge.classList.remove('hidden', 'badge-chain-verified', 'badge-chain-failing', 'badge-chain-pending');
        badge.classList.add('badge-chain-unverified');
        badge.textContent = '○ Unavailable';
      }
      const errBox = document.createElement('div');
      errBox.className = 'claim-detail';
      errBox.textContent = 'Evidence chain unavailable: ' + data.error;
      panel.appendChild(errBox);
      return;
    }

    // Extract items / chains and summary
    const summary = data.summary || (data.claimsSeparation ? data : null);
    const chains = Array.isArray(data.items)
      ? data.items
      : (Array.isArray(data.chains) ? data.chains : (data.chain ? [data.chain] : []));

    // Determine aggregate verification status
    let chainStatus = data.chainStatus || (summary && summary.ciState) || 'unverified_implementation';
    if (chains.length > 0 && chains[0].chainStatus) {
      chainStatus = chains[0].chainStatus;
    }

    if (badge) {
      badge.classList.remove('hidden', 'badge-chain-verified', 'badge-chain-failing', 'badge-chain-unverified', 'badge-chain-pending');
      if (chainStatus === 'complete_verified') {
        badge.classList.add('badge-chain-verified');
        badge.textContent = '✓ Verified Chain';
      } else if (chainStatus === 'complete_failing') {
        badge.classList.add('badge-chain-failing');
        badge.textContent = '✕ Failing CI';
      } else if (chainStatus === 'pending_ci') {
        badge.classList.add('badge-chain-pending');
        badge.textContent = '⏳ Pending CI';
      } else if (chainStatus === 'missing_test') {
        badge.classList.add('badge-chain-unverified');
        badge.textContent = '○ Missing Tests';
      } else {
        badge.classList.add('badge-chain-unverified');
        badge.textContent = '○ Not Verified (Not Run)';
      }
    }

    // If no mapped chains/items exist
    if (chains.length === 0 && (!summary || !summary.claimsSeparation)) {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'claim-detail';
      emptyNote.textContent = data.message || 'No implementation files or tests mapped to this room.';
      panel.appendChild(emptyNote);
      if (data.droppedCount > 0) {
        const dropNote = document.createElement('div');
        dropNote.className = 'evidence-truth-note';
        dropNote.textContent = data.droppedCount + ' placeholder chain(s) dropped (not in workspace snapshot).';
        panel.appendChild(dropNote);
      }
      return;
    }

    // Evaluate the 4 distinct claims
    let claim1Detected = false;
    let claim1File = null;
    let claim1Mapping = 'none';

    let claim2References = false;
    let claim2Detail = 'No direct syntax reference detected';

    let claim3Executed = false;
    let claim3Detail = data.runEvidenceAvailable
      ? 'No local test run executed for this module'
      : 'Not run (local execution evidence pending)';

    let claim4Passed = false;
    let claim4Detail = 'Not run (cannot verify pass without test execution)';

    let primary = null;
    if (chains.length > 0) {
      primary = chains[0];
      const cl = primary.claims || {};
      claim1Detected = isClaimEstablished(cl.testFileDetected) || (!cl.testFileDetected && Boolean(primary.test));
      claim2References = isClaimEstablished(cl.testReferencesCode) || (!cl.testReferencesCode && Boolean(primary.test && (primary.test.mappingType || primary.test.evidence)));
      claim3Executed = isClaimEstablished(cl.testExecuted);
      claim4Passed = isClaimEstablished(cl.testPassed);

      if (primary.test) {
        claim1File = primary.test.filePath || primary.test.testFilePath || primary.test.path;
        claim1Mapping = primary.test.mappingType || 'syntax';
        if (primary.implementation && primary.implementation.symbolName) {
          claim2Detail = 'Maps to ' + primary.implementation.symbolName + ' (' + claim1Mapping + ')';
        } else if (primary.test.evidence) {
          claim2Detail = sanitizeSecretText(primary.test.evidence);
        } else {
          claim2Detail = 'Mapped via ' + claim1Mapping + ' analysis';
        }
      }

      if (primary.ciCheck) {
        if (primary.ciCheck.status === 'completed' && primary.ciCheck.isExactScannedCommit) {
          claim3Executed = true;
          claim3Detail = 'Executed in CI (' + (primary.ciCheck.checkName || 'test check') + ')';
          claim4Passed = primary.ciCheck.conclusion === 'success';
          claim4Detail = claim4Passed ? 'CI check succeeded on exact commit' : 'CI check failed (' + (primary.ciCheck.conclusion || 'failure') + ')';
        } else if (!primary.ciCheck.isExactScannedCommit && primary.ciCheck.commitSha) {
          claim3Detail = 'Stale CI result on commit ' + primary.ciCheck.commitSha.slice(0, 7) + ' (not current)';
          claim4Detail = 'Cannot treat stale check as current evidence';
        }
      } else if (claim3Executed) {
        claim3Detail = 'Executed locally';
        claim4Detail = claim4Passed ? 'Passed local test run' : 'Failed local test run';
      }
    } else if (summary && summary.claimsSeparation) {
      claim1Detected = summary.claimsSeparation.filesDetectedCount > 0;
      claim2References = summary.claimsSeparation.referencingTestsCount > 0;
      claim3Executed = summary.claimsSeparation.executedTestsCount > 0;
      claim4Passed = summary.claimsSeparation.passedCheckCount > 0;
    }

    // Top metadata rows (requirement, implementation)
    if (primary) {
      if (primary.requirement && primary.requirement.title) {
        const reqRow = document.createElement('div');
        reqRow.className = 'claim-detail';
        const reqLabel = document.createElement('strong');
        reqLabel.textContent = 'Requirement: ';
        reqRow.appendChild(reqLabel);
        reqRow.appendChild(
          document.createTextNode('[' + (primary.requirement.id || 'REQ') + '] ' + primary.requirement.title)
        );
        panel.appendChild(reqRow);
      }
      if (primary.implementation && primary.implementation.filePath) {
        const impRow = document.createElement('div');
        impRow.className = 'claim-detail';
        const impLabel = document.createElement('strong');
        impLabel.textContent = 'Implementation: ';
        impRow.appendChild(impLabel);

        const impLink = document.createElement('a');
        impLink.className = 'claim-file-link';
        impLink.textContent =
          '📄 ' +
          primary.implementation.filePath.split('/').pop() +
          (primary.implementation.symbolName ? ' (' + primary.implementation.symbolName + ')' : '');
        impLink.title =
          primary.implementation.filePath +
          (primary.implementation.lineRange
            ? ' (lines ' + primary.implementation.lineRange.startLine + '-' + primary.implementation.lineRange.endLine + ')'
            : '');
        impLink.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({
            command: 'openFile',
            path: primary.implementation.filePath,
            line: (primary.implementation.lineRange && primary.implementation.lineRange.startLine) || 1,
          });
        });
        impRow.appendChild(impLink);
        panel.appendChild(impRow);
      }
    }

    // Build the 4-claim cards grid
    const grid = document.createElement('div');
    grid.className = 'evidence-claims-grid';

    // 1. Test Detected
    const card1 = document.createElement('div');
    card1.className = 'evidence-claim-card';
    const c1Header = document.createElement('div');
    c1Header.className = 'claim-header';
    const c1Num = document.createElement('span');
    c1Num.className = 'claim-number';
    c1Num.textContent = 'CLAIM 1';
    const c1Pill = document.createElement('span');
    c1Pill.className = 'claim-status-pill ' + (claim1Detected ? 'claim-status-verified' : 'claim-status-missing');
    c1Pill.textContent = claim1Detected ? '✓ Detected' : '○ Not Found';
    c1Header.appendChild(c1Num);
    c1Header.appendChild(c1Pill);
    card1.appendChild(c1Header);

    const c1Title = document.createElement('span');
    c1Title.className = 'claim-label';
    c1Title.textContent = 'Test Detected';
    card1.appendChild(c1Title);

    if (claim1File) {
      const fileLink = document.createElement('a');
      fileLink.className = 'claim-detail claim-file-link';
      fileLink.textContent = '📄 ' + (claim1File.split('/').pop() || claim1File);
      fileLink.title = claim1File + ' (Click to open test file)';
      fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({
          command: 'openFile',
          path: claim1File,
          line: (primary && primary.test && primary.test.lineRange && primary.test.lineRange.startLine) || 1,
        });
      });
      card1.appendChild(fileLink);
    } else {
      const c1Detail = document.createElement('span');
      c1Detail.className = 'claim-detail';
      c1Detail.textContent = 'No test file detected for module';
      card1.appendChild(c1Detail);
    }
    grid.appendChild(card1);

    // 2. References Implementation
    const card2 = document.createElement('div');
    card2.className = 'evidence-claim-card';
    const c2Header = document.createElement('div');
    c2Header.className = 'claim-header';
    const c2Num = document.createElement('span');
    c2Num.className = 'claim-number';
    c2Num.textContent = 'CLAIM 2';
    const c2Pill = document.createElement('span');
    c2Pill.className =
      'claim-status-pill ' +
      (claim2References
        ? (claim1Mapping === 'heuristic' ? 'claim-status-heuristic' : 'claim-status-verified')
        : 'claim-status-missing');
    c2Pill.textContent = claim2References
      ? (claim1Mapping === 'heuristic' ? '~ Heuristic' : '✓ Syntax Ref')
      : '○ No Ref';
    c2Header.appendChild(c2Num);
    c2Header.appendChild(c2Pill);
    card2.appendChild(c2Header);

    const c2Title = document.createElement('span');
    c2Title.className = 'claim-label';
    c2Title.textContent = 'References Code';
    card2.appendChild(c2Title);

    const c2Detail = document.createElement('span');
    c2Detail.className = 'claim-detail';
    c2Detail.textContent = claim2Detail;
    card2.appendChild(c2Detail);
    grid.appendChild(card2);

    // 3. Executed (CRITICAL: Must remain "Not Run" unless real execution evidence exists)
    const card3 = document.createElement('div');
    card3.className = 'evidence-claim-card';
    const c3Header = document.createElement('div');
    c3Header.className = 'claim-header';
    const c3Num = document.createElement('span');
    c3Num.className = 'claim-number';
    c3Num.textContent = 'CLAIM 3';
    const c3Pill = document.createElement('span');
    c3Pill.className = 'claim-status-pill ' + (claim3Executed ? 'claim-status-verified' : 'claim-status-not-run');
    c3Pill.textContent = claim3Executed ? '✓ Executed' : '— Not Run';
    c3Header.appendChild(c3Num);
    c3Header.appendChild(c3Pill);
    card3.appendChild(c3Header);

    const c3Title = document.createElement('span');
    c3Title.className = 'claim-label';
    c3Title.textContent = 'Test Executed';
    card3.appendChild(c3Title);

    const c3Detail = document.createElement('span');
    c3Detail.className = 'claim-detail';
    c3Detail.textContent = claim3Detail;
    card3.appendChild(c3Detail);
    grid.appendChild(card3);

    // 4. Passed (CRITICAL: Must remain "Not Run" unless genuine passing test results exist)
    const card4 = document.createElement('div');
    card4.className = 'evidence-claim-card';
    const c4Header = document.createElement('div');
    c4Header.className = 'claim-header';
    const c4Num = document.createElement('span');
    c4Num.className = 'claim-number';
    c4Num.textContent = 'CLAIM 4';
    const c4Pill = document.createElement('span');
    c4Pill.className =
      'claim-status-pill ' +
      (claim4Passed
        ? 'claim-status-verified'
        : (claim3Executed ? 'claim-status-failed' : 'claim-status-not-run'));
    c4Pill.textContent = claim4Passed ? '✓ Passed' : (claim3Executed ? '✕ Failed' : '— Not Run');
    c4Header.appendChild(c4Num);
    c4Header.appendChild(c4Pill);
    card4.appendChild(c4Header);

    const c4Title = document.createElement('span');
    c4Title.className = 'claim-label';
    c4Title.textContent = 'Passed Status';
    card4.appendChild(c4Title);

    const c4Detail = document.createElement('span');
    c4Detail.className = 'claim-detail';
    c4Detail.textContent = claim4Detail;
    card4.appendChild(c4Detail);
    grid.appendChild(card4);

    panel.appendChild(grid);

    // Truth note
    const truthNote = document.createElement('div');
    truthNote.className = 'evidence-truth-note';
    truthNote.textContent =
      'Truthful Evaluation: Test execution and pass status are never inferred from file existence alone. Executed & passed require genuine local test runs or exact CI runs.';
    panel.appendChild(truthNote);

    // Dropped placeholder note if applicable
    if (data.droppedCount > 0) {
      const dropNote = document.createElement('div');
      dropNote.className = 'evidence-truth-note';
      dropNote.textContent =
        data.droppedCount + ' placeholder chain(s) dropped (not in workspace snapshot).';
      panel.appendChild(dropNote);
    }

    // Explanation if provided
    if (primary && primary.explanation) {
      const expDiv = document.createElement('div');
      expDiv.className = 'claim-detail';
      expDiv.textContent = sanitizeSecretText(primary.explanation);
      panel.appendChild(expDiv);
    }

    // Mapped test assertions if available
    if (
      chains.length > 0 &&
      chains[0].test &&
      Array.isArray(chains[0].test.assertions) &&
      chains[0].test.assertions.length > 0
    ) {
      const assertionsSec = document.createElement('div');
      assertionsSec.className = 'evidence-chain-details';
      const aTitle = document.createElement('span');
      aTitle.className = 'claim-number';
      aTitle.textContent = 'MAPPED ASSERTIONS IN ' + (claim1File ? claim1File.split('/').pop() : 'TEST') + ':';
      assertionsSec.appendChild(aTitle);

      chains[0].test.assertions.slice(0, 4).forEach((asrt) => {
        const asrtPill = document.createElement('div');
        asrtPill.className = 'claim-detail';
        asrtPill.textContent = 'Line ' + asrt.line + ': ' + sanitizeSecretText(asrt.expression);
        assertionsSec.appendChild(asrtPill);
      });
      panel.appendChild(assertionsSec);
    }

    // Failure excerpt if CI or run failed
    if (
      chains.length > 0 &&
      chains[0].failureConnection &&
      chains[0].failureConnection.failureOutputExcerpt
    ) {
      const failSec = document.createElement('div');
      failSec.className = 'evidence-chain-details';
      const fTitle = document.createElement('span');
      fTitle.className = 'claim-number';
      fTitle.textContent = 'OBSERVED TEST FAILURE:';
      failSec.appendChild(fTitle);

      const fPre = document.createElement('pre');
      fPre.className = 'evidence-failure-pre';
      fPre.textContent = sanitizeSecretText(chains[0].failureConnection.failureOutputExcerpt);
      failSec.appendChild(fPre);
      panel.appendChild(failSec);
    }
  }

  // Investigation UI Logic (P2-10)
  let storedFindingsByRoomId = {};
  let isInvestigatingRoom = false;
  let activeInvestigatingRoomId = null;
  let activeInvestigationWatchdog = null;

  // Re-inspection UI Logic (P2-14)
  let isReinspectingFinding = false;
  let activeReinspectingRoomId = null;
  let latestReinspectionByRoomId = {};
  let activeReinspectionWatchdog = null;

  const btnInvestigateRoom = document.getElementById('btnInvestigateRoom');
  const btnInvestigateText = document.getElementById('btnInvestigateText');
  const btnReinspectFinding = document.getElementById('btnReinspectFinding');
  const btnReinspectText = document.getElementById('btnReinspectText');
  const investigationStatusPill = document.getElementById('investigationStatusPill');
  const investigationPanel = document.getElementById('investigationPanel');

  function setInvestigatingState(loading, roomId) {
    if (!loading && activeInvestigationWatchdog) {
      clearTimeout(activeInvestigationWatchdog);
      activeInvestigationWatchdog = null;
    }
    isInvestigatingRoom = loading;
    activeInvestigatingRoomId = loading ? roomId : null;

    if (btnInvestigateRoom) {
      btnInvestigateRoom.disabled = loading;
    }
    if (btnInvestigateText) {
      if (loading) {
        btnInvestigateText.textContent = 'Investigating...';
      } else {
        const hasExisting = Boolean(storedFindingsByRoomId[currentSelectedRoomId]);
        btnInvestigateText.textContent = hasExisting ? 'Re-investigate Room' : 'Investigate Room';
      }
    }

    if (loading && investigationPanel) {
      investigationPanel.classList.remove('hidden');
      investigationPanel.textContent = '';

      const loadBox = document.createElement('div');
      loadBox.className = 'payload-state-box';

      const dot = document.createElement('span');
      dot.className = 'status-indicator-dot dot-pulsing';
      loadBox.appendChild(dot);

      const txt = document.createElement('span');
      txt.textContent = 'Investigating module boundaries, source code, and evidence gaps...';
      loadBox.appendChild(txt);

      investigationPanel.appendChild(loadBox);
    }

    if (!loading) {
      updateInvestigationUi();
    }
  }

  function setReinspectingState(loading, roomId = null) {
    isReinspectingFinding = loading;
    activeReinspectingRoomId = loading ? roomId : null;

    if (btnReinspectFinding) {
      btnReinspectFinding.disabled = loading;
    }
    if (btnReinspectText) {
      btnReinspectText.textContent = loading ? 'Re-inspecting...' : 'Re-inspect Finding';
    }
    updateInvestigationUi();
  }

  function triggerRoomInvestigation(roomId, bypassCache = false) {
    if (isInvestigatingRoom || !roomId) return;
    activeInvestigationWatchdog = clearTimer(activeInvestigationWatchdog);
    setInvestigatingState(true, roomId);
    vscode.postMessage({
      command: 'investigateRoom',
      roomId,
      bypassCache,
    });

    activeInvestigationWatchdog = setTimeout(() => {
      activeInvestigationWatchdog = null;
      if (isInvestigatingRoom) {
        setInvestigatingState(false);
        handleInvestigationError({
          roomId,
          errorInfo: {
            kind: 'timeout',
            title: 'Investigation Timed Out',
            message: 'The investigation request did not receive a response from the host within 30 seconds. Please try again.',
            retryable: true,
          },
        });
      }
    }, 30000);
  }

  function triggerReinspectFinding(roomId) {
    if (isReinspectingFinding || !roomId) return;
    const record = storedFindingsByRoomId[roomId];
    if (!record) return;

    activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);

    setReinspectingState(true, roomId);

    vscode.postMessage({
      command: 'reinspectFinding',
      roomId,
    });

    activeReinspectionWatchdog = setTimeout(() => {
      activeReinspectionWatchdog = null;
      if (isReinspectingFinding) {
        setReinspectingState(false);
      }
    }, 10000);
  }

  if (btnInvestigateRoom) {
    btnInvestigateRoom.addEventListener('click', () => {
      if (currentSelectedRoomId) {
        const hasExisting = Boolean(storedFindingsByRoomId[currentSelectedRoomId]);
        triggerRoomInvestigation(currentSelectedRoomId, hasExisting);
      }
    });
  }

  if (btnReinspectFinding) {
    btnReinspectFinding.addEventListener('click', () => {
      if (currentSelectedRoomId) {
        triggerReinspectFinding(currentSelectedRoomId);
      }
    });
  }

  // Handoff state & orchestration seam (P2-11)
  // Architecture seam for future agent adapters (Claude Code, Codex, Antigravity).
  // Hand-off currently supports host clipboard and file export only (no auto-execution or chat ingestion).
  let activeHandoffWatchdog = null;
  let activeHandoffAction = null;
  let activeHandoffRoomId = null;

  function setHandoffButtonsState(inFlight, action = null) {
    const copyBtn = document.getElementById('btnCopyPrompt');
    const saveBtn = document.getElementById('btnSavePrompt');

    if (copyBtn) {
      copyBtn.disabled = inFlight;
      if (inFlight && action === 'copy') {
        copyBtn.textContent = 'Copying...';
      } else if (!inFlight && !copyBtn.classList.contains('copied')) {
        copyBtn.textContent = '📋 Copy prompt';
      }
    }

    if (saveBtn) {
      saveBtn.disabled = inFlight;
      if (inFlight && action === 'save') {
        saveBtn.textContent = 'Saving...';
      } else if (!inFlight && !saveBtn.classList.contains('saved')) {
        saveBtn.textContent = '💾 Save prompt file';
      }
    }
  }

  function markHandoffButtonConfirmed(action) {
    if (action === 'copy') {
      const copyBtn = document.getElementById('btnCopyPrompt');
      if (copyBtn) {
        copyBtn.textContent = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          if (copyBtn) {
            copyBtn.textContent = '📋 Copy prompt';
            copyBtn.classList.remove('copied');
          }
        }, 3000);
      }
    } else if (action === 'save') {
      const saveBtn = document.getElementById('btnSavePrompt');
      if (saveBtn) {
        saveBtn.textContent = '✓ Saved!';
        saveBtn.classList.add('saved');
        setTimeout(() => {
          if (saveBtn) {
            saveBtn.textContent = '💾 Save prompt file';
            saveBtn.classList.remove('saved');
          }
        }, 3500);
      }
    }
  }

  function showHandoffFeedback(text, kind = 'info') {
    const banner = document.getElementById('handoffFeedbackBanner');
    if (!banner) return;
    banner.classList.remove('hidden', 'handoff-feedback-loading', 'handoff-feedback-success', 'handoff-feedback-error', 'handoff-feedback-warning');
    banner.classList.add('handoff-feedback-' + kind);
    banner.textContent = text;
  }

  function triggerRepairPromptHandoff(roomId, action) {
    if (!roomId) return;
    const record = storedFindingsByRoomId[roomId];
    if (!record || !record.finding || !record.finding.generatedPrompt) {
      showHandoffFeedback('Cannot hand off prompt: this finding does not contain generated prompt content.', 'error');
      return;
    }

    activeHandoffWatchdog = clearTimer(activeHandoffWatchdog);

    activeHandoffAction = action;
    activeHandoffRoomId = roomId;

    setHandoffButtonsState(true, action);

    if (action === 'copy') {
      showHandoffFeedback('⏳ Copying repair prompt via host clipboard adapter...', 'loading');
    } else {
      showHandoffFeedback('⏳ Requesting file save confirmation from host (.living-blueprint/prompts)...', 'loading');
    }

    vscode.postMessage({
      command: 'handoffRepairPrompt',
      roomId,
      action,
    });

    activeHandoffWatchdog = setTimeout(() => {
      activeHandoffWatchdog = null;
      if (action === 'save') {
        // Keep save button disabled while modal / dialog remains open
        showHandoffFeedback(
          'ℹ️ Awaiting confirmation in VS Code dialog. Check open modals to complete saving.',
          'warning'
        );
      } else {
        setHandoffButtonsState(false);
        showHandoffFeedback(
          '⚠️ Host response pending: awaiting host-side handoff adapter for \'' + action + '\'.',
          'error'
        );
      }
    }, action === 'save' ? 120000 : 8000);
  }

  function handleHandoffResult(msg) {
    activeHandoffWatchdog = clearTimer(activeHandoffWatchdog);
    const action = msg.action || activeHandoffAction || (msg.adapterId === 'file' ? 'save' : 'copy');
    setHandoffButtonsState(false);

    if (msg.roomId && msg.roomId !== currentSelectedRoomId) {
      return;
    }

    const isSuccess = Boolean(msg.success || msg.ok);

    if (isSuccess) {
      const isStale = Boolean(msg.stale || (storedFindingsByRoomId[msg.roomId] && storedFindingsByRoomId[msg.roomId].stale));
      const staleNotice = isStale ? ' (from earlier snapshot)' : '';

      if (action === 'copy' || msg.adapterId === 'clipboard') {
        markHandoffButtonConfirmed('copy');
        const detail = msg.message ? ': ' + msg.message : '.';
        showHandoffFeedback('✓ Host confirmed: Copied repair prompt to clipboard' + staleNotice + detail, 'success');
      } else {
        markHandoffButtonConfirmed('save');
        const targetPath = (msg.filePath || msg.path) ? ' (' + (msg.filePath || msg.path) + ')' : '';
        const detail = msg.message ? ': ' + msg.message : '.';
        showHandoffFeedback('✓ Host confirmed: Saved prompt file' + targetPath + staleNotice + detail, 'success');
      }
    } else {
      const isCancelled = Boolean(
        msg.cancelled ||
        msg.reason === 'cancelled' ||
        (msg.message && msg.message.toLowerCase().includes('cancel')) ||
        (msg.error && msg.error.toLowerCase().includes('cancel')) ||
        (msg.reason && msg.reason.toLowerCase().includes('cancel'))
      );

      if (isCancelled) {
        showHandoffFeedback('ℹ️ Save prompt file cancelled by user in confirmation dialog.', 'warning');
      } else {
        const errText = msg.error || msg.message || msg.reason || ('Host ' + action + ' adapter failed.');
        showHandoffFeedback('⚠️ Host handoff failed: ' + errText, 'error');
      }
    }
  }

  function handleReinspectionResult(msg) {
    activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);
    if (!msg.roomId || msg.roomId === activeReinspectingRoomId) {
      setReinspectingState(false);
    }
    if (msg.roomId) {
      latestReinspectionByRoomId[msg.roomId] = msg;
      const record = storedFindingsByRoomId[msg.roomId];
      if (record) {
        if (!Array.isArray(record.reinspections)) {
          record.reinspections = [];
        }
        record.reinspections.push(msg);
      }
    }
    if (msg.roomId === currentSelectedRoomId) {
      updateInvestigationUi();
    }
  }

  function handleReinspectionError(msg) {
    activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);
    if (!msg.roomId || msg.roomId === activeReinspectingRoomId) {
      setReinspectingState(false);
    }
    if (msg.roomId) {
      latestReinspectionByRoomId[msg.roomId] = {
        roomId: msg.roomId,
        classification: 'not_comparable',
        message: msg.error || msg.message || 'Re-inspection encountered an error.',
        evidence: [],
        testsPassedForCurrentSnapshot: false,
        fixVerified: false,
        findingStale: false,
        at: new Date().toISOString(),
      };
    }
    if (msg.roomId === currentSelectedRoomId) {
      updateInvestigationUi();
    }
  }

  function handleInvestigationUnavailable(msg) {
    if (!msg.roomId || msg.roomId === activeInvestigatingRoomId) {
      setInvestigatingState(false);
    }
    if (msg.previous && msg.roomId) {
      storedFindingsByRoomId[msg.roomId] = msg.previous;
    }
    if (msg.roomId && msg.roomId !== currentSelectedRoomId) {
      return;
    }
    if (!investigationPanel) return;
    investigationPanel.classList.remove('hidden');
    investigationPanel.textContent = '';

    const box = document.createElement('div');
    box.className = 'investigation-notice-box notice-unavailable';

    const title = document.createElement('strong');
    if (msg.state === 'untrusted') {
      title.textContent = 'AI Investigation Blocked (Untrusted Workspace)';
    } else if (msg.state === 'needs_consent') {
      title.textContent = 'Cloud AI Consent Required';
    } else if (msg.state === 'needs_key') {
      title.textContent = 'AI Provider Key Required';
    } else {
      title.textContent = 'Investigation Unavailable (' + String(msg.state || 'offline').toUpperCase() + ')';
    }
    box.appendChild(title);

    const desc = document.createElement('p');
    desc.textContent = msg.reason || 'AI investigations require cloud AI consent and configured provider credentials in SecretStorage.';
    box.appendChild(desc);

    investigationPanel.appendChild(box);

    if (msg.previous) {
      const prevNote = document.createElement('div');
      prevNote.className = 'text-empty-hint';
      prevNote.textContent = '(Preserving previous finding from earlier run below)';
      investigationPanel.appendChild(prevNote);

      renderInvestigationFindingContent(msg.previous);
    }
  }

  function handleInvestigationError(msg) {
    if (!msg.roomId || msg.roomId === activeInvestigatingRoomId) {
      setInvestigatingState(false);
    }
    if (msg.previous && msg.roomId) {
      storedFindingsByRoomId[msg.roomId] = msg.previous;
    }
    if (msg.roomId && msg.roomId !== currentSelectedRoomId) {
      return;
    }
    if (!investigationPanel) return;
    investigationPanel.classList.remove('hidden');
    investigationPanel.textContent = '';

    const card = document.createElement('div');
    card.className = 'chat-error-notice';

    const header = document.createElement('div');
    header.className = 'error-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'error-title-row';
    const icon = document.createElement('span');
    icon.textContent = '⚠️';
    const title = document.createElement('span');
    title.className = 'error-title';
    title.textContent = (msg.errorInfo && msg.errorInfo.title) || 'Investigation Failed';
    titleRow.appendChild(icon);
    titleRow.appendChild(title);
    header.appendChild(titleRow);

    if (msg.errorInfo && msg.errorInfo.kind) {
      const badge = document.createElement('span');
      badge.className = 'error-badge';
      badge.textContent = String(msg.errorInfo.kind).toUpperCase().replace(/_/g, ' ');
      header.appendChild(badge);
    }
    card.appendChild(header);

    const msgEl = document.createElement('div');
    msgEl.className = 'error-message';
    msgEl.textContent = (msg.errorInfo && (msg.errorInfo.message || msg.errorInfo.error)) || msg.error || 'The investigation request failed.';
    card.appendChild(msgEl);

    if (msg.errorInfo && msg.errorInfo.retryAfterSeconds !== undefined && msg.errorInfo.retryAfterSeconds !== null) {
      const retryInfo = document.createElement('div');
      retryInfo.className = 'error-retry-text';
      retryInfo.textContent = '⏳ Provider cooldown: retry recommended in ' + msg.errorInfo.retryAfterSeconds + 's';
      card.appendChild(retryInfo);
    }

    const retryRow = document.createElement('div');
    retryRow.className = 'error-retry-row';

    const hint = document.createElement('span');
    hint.className = 'text-empty-hint';
    hint.textContent = 'Existing architecture & evidence remain fully available.';
    retryRow.appendChild(hint);

    if (msg.errorInfo?.retryable !== false && msg.roomId) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-retry-chat';
      retryBtn.textContent = '↻ Retry Investigation';
      retryBtn.addEventListener('click', () => {
        triggerRoomInvestigation(msg.roomId, true);
      });
      retryRow.appendChild(retryBtn);
    }
    card.appendChild(retryRow);

    investigationPanel.appendChild(card);

    if (msg.previous) {
      const prevNote = document.createElement('div');
      prevNote.className = 'text-empty-hint';
      prevNote.textContent = '(Preserving previous finding from earlier run below)';
      investigationPanel.appendChild(prevNote);

      renderInvestigationFindingContent(msg.previous);
    }
  }

  function updateInvestigationUi() {
    if (!investigationPanel) return;

    if (isInvestigatingRoom && activeInvestigatingRoomId === currentSelectedRoomId) {
      return;
    }

    if (!currentSelectedRoomId) {
      investigationPanel.classList.add('hidden');
      investigationPanel.textContent = '';
      if (investigationStatusPill) investigationStatusPill.classList.add('hidden');
      if (btnReinspectFinding) btnReinspectFinding.classList.add('hidden');
      return;
    }

    const record = storedFindingsByRoomId[currentSelectedRoomId];
    if (btnInvestigateText) {
      if (isInvestigatingRoom && activeInvestigatingRoomId === currentSelectedRoomId) {
        btnInvestigateText.textContent = 'Investigating...';
      } else {
        btnInvestigateText.textContent = record ? 'Re-investigate Room' : 'Investigate Room';
      }
    }
    if (btnInvestigateRoom) {
      btnInvestigateRoom.disabled = isInvestigatingRoom;
    }

    if (!record || !record.finding) {
      investigationPanel.classList.add('hidden');
      investigationPanel.textContent = '';
      if (investigationStatusPill) {
        investigationStatusPill.classList.add('hidden');
      }
      if (btnReinspectFinding) {
        btnReinspectFinding.classList.add('hidden');
      }
      return;
    }

    if (btnReinspectFinding) {
      btnReinspectFinding.classList.remove('hidden');
      btnReinspectFinding.disabled = isReinspectingFinding;
    }
    if (btnReinspectText) {
      btnReinspectText.textContent = (isReinspectingFinding && activeReinspectingRoomId === currentSelectedRoomId)
        ? 'Re-inspecting...'
        : 'Re-inspect Finding';
    }

    if (record.reinspections && record.reinspections.length > 0 && !latestReinspectionByRoomId[currentSelectedRoomId]) {
      latestReinspectionByRoomId[currentSelectedRoomId] = record.reinspections[record.reinspections.length - 1];
    }

    investigationPanel.classList.remove('hidden');
    investigationPanel.textContent = '';

    // Stale status indicator pill in header
    if (investigationStatusPill) {
      if (record.stale) {
        investigationStatusPill.classList.remove('hidden');
        investigationStatusPill.className = 'investigation-status-pill status-stale';
        investigationStatusPill.textContent = '⚠️ Stale';
        investigationStatusPill.title = 'Workspace files changed since this investigation was run. Re-investigate to re-verify.';
      } else {
        investigationStatusPill.classList.remove('hidden');
        investigationStatusPill.className = 'investigation-status-pill';
        investigationStatusPill.textContent = '✓ Inspected';
        investigationStatusPill.title = 'Investigation grounded in current workspace snapshot.';
      }
    }

    // Stale banner
    if (record.stale) {
      const staleBanner = document.createElement('div');
      staleBanner.className = 'investigation-stale-banner';
      staleBanner.textContent = '⚠️ Stale Finding: Workspace files changed since this investigation was performed. Evidence and line numbers may have changed. Click "Re-investigate Room" to re-verify.';
      investigationPanel.appendChild(staleBanner);
    }

    renderInvestigationFindingContent(record);
  }

  function renderInvestigationFindingContent(record) {
    if (!investigationPanel || !record || !record.finding) return;
    const finding = record.finding;

    // 1. Finding Header with Severity / Category / Classification
    const headerSec = document.createElement('div');
    headerSec.className = 'finding-header';

    const eyebrow1 = document.createElement('span');
    eyebrow1.className = 'finding-section-eyebrow';
    eyebrow1.textContent = '1. DIAGNOSTIC FINDING & SEVERITY';
    headerSec.appendChild(eyebrow1);

    const titleEl = document.createElement('div');
    titleEl.className = 'finding-title';
    titleEl.textContent = finding.title || 'Diagnostic Assessment';
    headerSec.appendChild(titleEl);

    const badgesRow = document.createElement('div');
    badgesRow.className = 'finding-badges-row';

    if (finding.category) {
      const catPill = document.createElement('span');
      catPill.className = 'category-pill';
      catPill.textContent = finding.category.replace(/_/g, ' ');
      badgesRow.appendChild(catPill);
    }

    if (finding.severity) {
      const sevPill = document.createElement('span');
      sevPill.className = 'severity-pill sev-' + finding.severity;
      sevPill.textContent = finding.severity.toUpperCase();
      badgesRow.appendChild(sevPill);
    }

    if (finding.evidenceClassification) {
      const classPill = document.createElement('span');
      classPill.className = 'classification-pill class-' + finding.evidenceClassification;
      classPill.textContent = finding.evidenceClassification.toUpperCase();
      classPill.title = 'Evidence Certainty: ' + finding.evidenceClassification.toUpperCase();
      badgesRow.appendChild(classPill);
    }

    const timingData = finding.timing || record.finding.timing;
    if (timingData && timingData.totalMs) {
      const timePill = document.createElement('span');
      timePill.className = 'timing-pill';
      const prov = finding.providerUsed || finding.provider || 'AI';
      timePill.textContent = '⚡ ' + timingData.totalMs + 'ms (' + prov + ')';
      badgesRow.appendChild(timePill);
    }
    headerSec.appendChild(badgesRow);

    if (finding.explanation) {
      const expEl = document.createElement('div');
      expEl.className = 'finding-explanation';
      expEl.textContent = finding.explanation;
      headerSec.appendChild(expEl);
    }
    investigationPanel.appendChild(headerSec);

    // 2. Why It Matters (Consequence)
    if (finding.whyItMatters || finding.explanation) {
      const whySec = document.createElement('div');
      whySec.className = 'finding-evidence-section';

      const eyebrow2 = document.createElement('span');
      eyebrow2.className = 'finding-section-eyebrow';
      eyebrow2.textContent = '2. WHY IT MATTERS (CONSEQUENCE)';
      whySec.appendChild(eyebrow2);

      const whyBox = document.createElement('div');
      whyBox.className = 'finding-why-box';
      whyBox.textContent = finding.whyItMatters || finding.explanation;
      whySec.appendChild(whyBox);

      investigationPanel.appendChild(whySec);
    }

    // 3. Validated Evidence: code excerpt and navigable references
    const evSec = document.createElement('div');
    evSec.className = 'finding-evidence-section';

    const eyebrow3 = document.createElement('span');
    eyebrow3.className = 'finding-section-eyebrow';
    eyebrow3.textContent = '3. VALIDATED EVIDENCE';
    evSec.appendChild(eyebrow3);

    // Code evidence
    if (finding.codeEvidence && finding.codeEvidence.codeSnippet) {
      const codeBox = document.createElement('div');
      codeBox.className = 'code-evidence-box';

      const codeHeader = document.createElement('div');
      codeHeader.className = 'code-evidence-header';

      const fileSpan = document.createElement('span');
      fileSpan.className = 'code-evidence-file';
      const lineNum = finding.codeEvidence.derivedLineNumber || 1;
      const lineRangeStr = finding.codeEvidence.lineRange
        ? ' (' + finding.codeEvidence.lineRange + ')'
        : (finding.codeEvidence.derivedLineNumber ? ' (Line ' + finding.codeEvidence.derivedLineNumber + ')' : '');
      fileSpan.textContent = '📄 ' + finding.codeEvidence.filePath + lineRangeStr;
      fileSpan.title = 'Click to open file at line ' + lineNum;
      fileSpan.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openFile',
          path: finding.codeEvidence.filePath,
          line: lineNum,
        });
      });
      codeHeader.appendChild(fileSpan);

      const statusBadge = document.createElement('span');
      statusBadge.className = 'code-evidence-badge ' + (finding.codeEvidence.isVerified ? 'ref-pill-verified' : 'ref-pill-unverified');
      statusBadge.textContent = finding.codeEvidence.isVerified ? '✓ Verified Source' : '○ Unverified Snippet';
      codeHeader.appendChild(statusBadge);

      codeBox.appendChild(codeHeader);

      const pre = document.createElement('pre');
      pre.className = 'code-evidence-pre';
      pre.textContent = finding.codeEvidence.codeSnippet;
      codeBox.appendChild(pre);

      if (finding.codeEvidence.explanation) {
        const note = document.createElement('div');
        note.className = 'code-evidence-note';
        note.textContent = finding.codeEvidence.explanation;
        codeBox.appendChild(note);
      }

      evSec.appendChild(codeBox);
    }

    // Navigable References: strictly build only from host navigation.references objects
    const navRefs = (record.navigation && Array.isArray(record.navigation.references))
      ? record.navigation.references.filter((ref) => ref && typeof ref === 'object' && (ref.file || ref.path))
      : [];

    if (navRefs.length > 0) {
      const refsGrid = document.createElement('div');
      refsGrid.className = 'finding-refs-grid';

      navRefs.forEach((ref) => {
        const a = document.createElement('a');
        const filePath = ref.file || ref.path;
        const line = ref.line || ref.derivedLineNumber || 1;
        const lineRangeText = ref.lineRange ? ':' + ref.lineRange : (line ? ':' + line : '');

        const isVerified = (ref.status === 'verified' || ref.isInspected === true) &&
          ref.status !== 'unverified' &&
          ref.status !== 'uninspected' &&
          ref.status !== 'unverified_not_inspected';
        const isLineUnverified = ref.status === 'line_unverified';

        if (isVerified) {
          a.className = 'file-pill ref-pill-verified';
          a.textContent = '✓ ' + (ref.label || ((filePath.split('/').pop() || filePath) + lineRangeText));
          a.title = (ref.note ? ref.note + ' — ' : '') + filePath + ':' + line + ' (Inspected & verified evidence)';
        } else if (isLineUnverified) {
          a.className = 'file-pill ref-pill-line-unverified';
          a.textContent = '? ' + (ref.label || ((filePath.split('/').pop() || filePath) + lineRangeText + ' (line unverified)'));
          a.title = (ref.note ? ref.note + ' — ' : '') + filePath + ':' + line + ' (Inspected file; line beyond inspected excerpt)';
        } else {
          a.className = 'file-pill ref-pill-unverified';
          const base = filePath.split('/').pop() || filePath;
          a.textContent = '⚠ ' + (ref.label && ref.label.includes('unverified') ? ref.label : base + ' (unverified reference, not inspected)');
          a.title = (ref.note ? ref.note + ' — ' : '') + filePath + ':1 (Unverified reference: exists in workspace tree but not inspected; opens at line 1)';
        }

        a.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ command: 'openFile', path: filePath, line });
        });
        refsGrid.appendChild(a);
      });
      evSec.appendChild(refsGrid);
    }

    if (record.navigation && record.navigation.droppedCount > 0) {
      const dropNotice = document.createElement('div');
      dropNotice.className = 'refs-unverified-count-note';
      dropNotice.textContent = 'ℹ ' + record.navigation.droppedCount + ' cited reference(s) could not be verified in this workspace and were excluded.';
      evSec.appendChild(dropNotice);
    }

    investigationPanel.appendChild(evSec);

    // 4. Reasoning (Direct Facts vs Inferences)
    if (finding.reasoning && ((finding.reasoning.facts && finding.reasoning.facts.length > 0) || (finding.reasoning.inferences && finding.reasoning.inferences.length > 0))) {
      const reasonSec = document.createElement('div');
      reasonSec.className = 'finding-evidence-section';

      const eyebrow4 = document.createElement('span');
      eyebrow4.className = 'finding-section-eyebrow';
      eyebrow4.textContent = '4. REASONING (DIRECT FACTS VS INFERENCES)';
      reasonSec.appendChild(eyebrow4);

      const rBox = document.createElement('div');
      rBox.className = 'finding-reasoning-section';

      if (Array.isArray(finding.reasoning.facts) && finding.reasoning.facts.length > 0) {
        const factsGroup = document.createElement('div');
        factsGroup.className = 'reasoning-subgroup';
        const fLbl = document.createElement('span');
        fLbl.className = 'reasoning-sub-label';
        fLbl.textContent = 'Direct Observed Facts:';
        factsGroup.appendChild(fLbl);

        finding.reasoning.facts.forEach((fact) => {
          const item = document.createElement('div');
          item.className = 'reasoning-item fact';
          const ic = document.createElement('span');
          ic.textContent = '✓';
          const txt = document.createElement('span');
          txt.textContent = fact;
          item.appendChild(ic);
          item.appendChild(txt);
          factsGroup.appendChild(item);
        });
        rBox.appendChild(factsGroup);
      }

      if (Array.isArray(finding.reasoning.inferences) && finding.reasoning.inferences.length > 0) {
        const infGroup = document.createElement('div');
        infGroup.className = 'reasoning-subgroup';
        const iLbl = document.createElement('span');
        iLbl.className = 'reasoning-sub-label';
        iLbl.textContent = 'Architectural Inferences:';
        infGroup.appendChild(iLbl);

        finding.reasoning.inferences.forEach((inf) => {
          const item = document.createElement('div');
          item.className = 'reasoning-item inference';
          const ic = document.createElement('span');
          ic.textContent = '↳';
          const txt = document.createElement('span');
          txt.textContent = inf;
          item.appendChild(ic);
          item.appendChild(txt);
          infGroup.appendChild(item);
        });
        rBox.appendChild(infGroup);
      }

      reasonSec.appendChild(rBox);
      investigationPanel.appendChild(reasonSec);
    }

    // 5. What Remains Uncertain (Unknowns & Rejected References)
    const uncSec = document.createElement('div');
    uncSec.className = 'finding-uncertainties-wrapper';

    const eyebrow5 = document.createElement('span');
    eyebrow5.className = 'finding-section-eyebrow';
    eyebrow5.textContent = '5. WHAT REMAINS UNCERTAIN';
    uncSec.appendChild(eyebrow5);

    if (finding.evidenceClassification !== 'observed') {
      const banner = document.createElement('div');
      banner.className = 'uncertainty-banner';
      banner.textContent = 'ℹ️ Classification: ' + (finding.evidenceClassification || 'UNKNOWN').toUpperCase() + '. ' +
        (finding.evidenceClassification === 'inferred'
          ? 'Derivation is based on architectural inference without directly observed execution evidence.'
          : 'Grounding is limited by uninspected files. Verify actual code before acting.');
      uncSec.appendChild(banner);
    }

    if (Array.isArray(finding.rejectedReferences) && finding.rejectedReferences.length > 0) {
      const rejBanner = document.createElement('div');
      rejBanner.className = 'uncertainty-banner';
      rejBanner.textContent = '⚠️ Ungrounded Files Excluded: ' + finding.rejectedReferences.join(', ') + ' do not exist in the repository tree and were stripped.';
      uncSec.appendChild(rejBanner);
    }

    if (finding.uncertainties) {
      const uncBox = document.createElement('div');
      uncBox.className = 'finding-uncertainties-box';
      uncBox.textContent = finding.uncertainties;
      uncSec.appendChild(uncBox);
    }

    investigationPanel.appendChild(uncSec);

    // 6. Recommended Next Step & Companion Dialogue
    if (finding.recommendedNextStep || (record.companionMessages && record.companionMessages.length > 0)) {
      const recSec = document.createElement('div');
      recSec.className = 'finding-evidence-section';

      const eyebrow6 = document.createElement('span');
      eyebrow6.className = 'finding-section-eyebrow';
      eyebrow6.textContent = '6. RECOMMENDED NEXT STEP';
      recSec.appendChild(eyebrow6);

      if (finding.recommendedNextStep) {
        const recBox = document.createElement('div');
        recBox.className = 'recommendation-box';
        recBox.textContent = finding.recommendedNextStep;
        recSec.appendChild(recBox);
      }

      const companionQuotes = record.companionMessages || finding.companionMessages;
      if (Array.isArray(companionQuotes) && companionQuotes.length > 0) {
        const quotesList = document.createElement('div');
        quotesList.className = 'finding-dialogue-section';

        companionQuotes.forEach((cmsg) => {
          const qBox = document.createElement('div');
          const isDog = cmsg.speaker === 'dog';
          qBox.className = 'finding-companion-quote ' + (isDog ? 'dog' : 'cat');

          if (isDog) {
            qBox.appendChild(createPixelDogSvg(18));
          } else {
            qBox.appendChild(createPixelCatSvg(18));
          }

          const txtWrap = document.createElement('div');
          const spk = document.createElement('span');
          spk.className = 'quote-speaker';
          spk.textContent = (cmsg.speakerName || (isDog ? 'Barkley' : 'Cleo')) + ': ';
          txtWrap.appendChild(spk);

          const qTxt = document.createElement('span');
          qTxt.textContent = cmsg.text || '';
          txtWrap.appendChild(qTxt);

          qBox.appendChild(txtWrap);
          quotesList.appendChild(qBox);
        });

        recSec.appendChild(quotesList);
      }

      investigationPanel.appendChild(recSec);
    }

    // 7. Coding Agent Repair Prompt (P2-11)
    const promptSec = document.createElement('div');
    promptSec.className = 'repair-prompt-section';

    const pHeader = document.createElement('div');
    pHeader.className = 'repair-prompt-header-row';

    const eyebrow7 = document.createElement('span');
    eyebrow7.className = 'finding-section-eyebrow';
    eyebrow7.textContent = '7. CODING AGENT REPAIR PROMPT';
    pHeader.appendChild(eyebrow7);
    promptSec.appendChild(pHeader);

    const pDesc = document.createElement('div');
    pDesc.className = 'repair-prompt-desc';
    pDesc.textContent = 'Generates a self-contained repair prompt with line ranges, acceptance criteria, and observed test commands for external coding agents (Claude Code, GitHub Copilot, Cursor). Prompts only; does not execute code or verify repairs.';
    promptSec.appendChild(pDesc);

    if (!finding.generatedPrompt) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'text-empty-hint';
      emptyNotice.textContent = 'No self-contained repair prompt was generated for this diagnostic assessment.';
      promptSec.appendChild(emptyNotice);
      investigationPanel.appendChild(promptSec);
    } else {
      if (record.stale) {
        const staleNotice = document.createElement('div');
        staleNotice.className = 'prompt-stale-warning';
        staleNotice.textContent = '⚠️ Stale finding warning: The prompt was generated from an earlier workspace snapshot. You can still copy or save it, but re-investigating this room is recommended so recent changes are included.';
        promptSec.appendChild(staleNotice);
      }

      const actionsRow = document.createElement('div');
      actionsRow.className = 'handoff-actions-row';

      const copyBtn = document.createElement('button');
      copyBtn.id = 'btnCopyPrompt';
      copyBtn.className = 'btn-copy-prompt';
      copyBtn.textContent = '📋 Copy prompt';
      copyBtn.title = 'Copy repair prompt to clipboard via host clipboard adapter';
      copyBtn.addEventListener('click', () => {
        triggerRepairPromptHandoff(currentSelectedRoomId, 'copy');
      });
      actionsRow.appendChild(copyBtn);

      const saveBtn = document.createElement('button');
      saveBtn.id = 'btnSavePrompt';
      saveBtn.className = 'btn-save-prompt';
      saveBtn.textContent = '💾 Save prompt file';
      saveBtn.title = 'Save prompt file to .living-blueprint/prompts/ via host file adapter';
      saveBtn.addEventListener('click', () => {
        triggerRepairPromptHandoff(currentSelectedRoomId, 'save');
      });
      actionsRow.appendChild(saveBtn);

      let isPromptVisible = false;
      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'btnTogglePrompt';
      toggleBtn.className = 'btn-toggle-prompt';
      toggleBtn.textContent = '⚡ Show prompt preview';

      actionsRow.appendChild(toggleBtn);
      promptSec.appendChild(actionsRow);

      const feedbackBanner = document.createElement('div');
      feedbackBanner.id = 'handoffFeedbackBanner';
      feedbackBanner.className = 'handoff-feedback-banner hidden';
      promptSec.appendChild(feedbackBanner);

      const prePrompt = document.createElement('pre');
      prePrompt.className = 'prompt-pre hidden';
      prePrompt.textContent = finding.generatedPrompt;

      toggleBtn.addEventListener('click', () => {
        isPromptVisible = !isPromptVisible;
        if (isPromptVisible) {
          prePrompt.classList.remove('hidden');
          toggleBtn.textContent = '⚡ Hide prompt preview';
        } else {
          prePrompt.classList.add('hidden');
          toggleBtn.textContent = '⚡ Show prompt preview';
        }
      });

      promptSec.appendChild(prePrompt);
      investigationPanel.appendChild(promptSec);
    }

    // 8. Re-inspection & Truthful Fix Status (P2-14)
    renderReinspectionSection(record);
  }

  function renderReinspectionSection(record) {
    if (!investigationPanel || !record || !record.roomId) return;
    const roomId = record.roomId;

    const reinspectSec = document.createElement('div');
    reinspectSec.className = 'finding-reinspection-section';

    // Header row with section eyebrow and CTA
    const headerRow = document.createElement('div');
    headerRow.className = 'reinspection-header-row';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'finding-section-eyebrow';
    eyebrow.textContent = '8. SOURCE RE-INSPECTION & FIX STATUS';
    headerRow.appendChild(eyebrow);

    const reInspectActionBtn = document.createElement('button');
    reInspectActionBtn.type = 'button';
    reInspectActionBtn.className = 'btn-run-reinspect-cta';
    reInspectActionBtn.textContent = (isReinspectingFinding && activeReinspectingRoomId === roomId) ? '⏳ Re-inspecting...' : '🔄 Re-inspect Now';
    reInspectActionBtn.title = 'Re-inspect workspace source files against this finding\'s cited evidence';
    reInspectActionBtn.disabled = isReinspectingFinding;
    reInspectActionBtn.addEventListener('click', () => {
      triggerReinspectFinding(roomId);
    });
    headerRow.appendChild(reInspectActionBtn);
    reinspectSec.appendChild(headerRow);

    // If currently loading for this room
    if (isReinspectingFinding && activeReinspectingRoomId === roomId) {
      const loadBox = document.createElement('div');
      loadBox.className = 'payload-state-box';

      const dot = document.createElement('span');
      dot.className = 'status-indicator-dot dot-pulsing';
      loadBox.appendChild(dot);

      const txt = document.createElement('span');
      txt.textContent = 'Re-inspecting cited files, comparing content hashes and checking current line ranges...';
      loadBox.appendChild(txt);

      reinspectSec.appendChild(loadBox);
      investigationPanel.appendChild(reinspectSec);
      return;
    }

    // Check if we have a re-inspection result for this room
    const result = latestReinspectionByRoomId[roomId] ||
      (Array.isArray(record.reinspections) && record.reinspections.length > 0
        ? record.reinspections[record.reinspections.length - 1]
        : null);

    if (!result) {
      // Empty / Uninspected state
      const emptyBox = document.createElement('div');
      emptyBox.className = 'reinspection-empty-box';

      const desc = document.createElement('div');
      desc.className = 'reinspection-empty-desc';
      desc.textContent = 'No re-inspection recorded yet for this finding. After applying a repair with your coding agent (Claude Code, Cursor, Copilot), click "Re-inspect Now" to verify whether cited evidence files changed.';
      emptyBox.appendChild(desc);

      const ctaBtn = document.createElement('button');
      ctaBtn.type = 'button';
      ctaBtn.className = 'btn-run-reinspect-cta';
      ctaBtn.textContent = '🔄 Re-inspect Finding';
      ctaBtn.title = 'Check current source files against this finding';
      ctaBtn.disabled = isReinspectingFinding;
      ctaBtn.addEventListener('click', () => {
        triggerReinspectFinding(roomId);
      });
      emptyBox.appendChild(ctaBtn);

      reinspectSec.appendChild(emptyBox);
      investigationPanel.appendChild(reinspectSec);
      return;
    }

    // Normalize classification
    const rawClass = String(result.classification || '').toLowerCase().replace(/-/g, '_');
    const isUnchanged = rawClass === 'evidence_unchanged';
    const isChanged = rawClass === 'evidence_changed';
    const isRemoved = rawClass === 'file_removed';
    const isNotComparable = rawClass === 'not_comparable' || (!isUnchanged && !isChanged && !isRemoved);

    // Check staleness of the re-inspection result
    const currentFp = currentBlueprintData && currentBlueprintData.fingerprint ? currentBlueprintData.fingerprint : undefined;
    const isReinspectionStale = Boolean(
      result.findingStale ||
      (currentFp && result.fingerprint && currentFp !== result.fingerprint)
    );

    // Stale notice banner
    if (isReinspectionStale) {
      const staleBanner = document.createElement('div');
      staleBanner.className = 'reinspection-stale-banner';
      staleBanner.textContent = '⚠️ Stale Re-inspection: Workspace files changed since this re-inspection was recorded (' +
        (result.fingerprint ? result.fingerprint.slice(0, 8) : 'earlier') +
        '). Click "Re-inspect Now" to re-evaluate against current files.';
      reinspectSec.appendChild(staleBanner);
    }

    // Card container
    const card = document.createElement('div');
    const borderClass = isUnchanged
      ? 'border-unchanged'
      : isChanged
      ? 'border-changed'
      : isRemoved
      ? 'border-removed'
      : 'border-not-comparable';
    card.className = 'reinspection-card ' + borderClass;

    // Badges Row
    const badgesRow = document.createElement('div');
    badgesRow.className = 'reinspection-badges-group';

    // 1. Classification Pill
    const classPill = document.createElement('span');
    if (isUnchanged) {
      classPill.className = 'reinspection-pill reinspection-pill-unchanged';
      classPill.textContent = '○ EVIDENCE UNCHANGED';
      classPill.title = 'The original evidence remains identical. Finding has not been demonstrated to be addressed.';
    } else if (isChanged) {
      classPill.className = 'reinspection-pill reinspection-pill-changed';
      classPill.textContent = '⚡ CODE CHANGED (UNVERIFIED)';
      classPill.title = 'Code in cited locations has changed, but the fix remains unverified.';
    } else if (isRemoved) {
      classPill.className = 'reinspection-pill reinspection-pill-removed';
      classPill.textContent = '⚠️ CITED FILE REMOVED (UNVERIFIED)';
      classPill.title = 'A cited file was removed from the workspace. Not verified.';
    } else {
      classPill.className = 'reinspection-pill reinspection-pill-not-comparable';
      classPill.textContent = '○ NOT COMPARABLE';
      classPill.title = 'References could not be compared with current files.';
    }
    badgesRow.appendChild(classPill);

    // 2. Tests passed badge (P2-13 confirmed)
    const hasPassingTests = Boolean(result.testsPassedForCurrentSnapshot);
    if (hasPassingTests) {
      const testsPill = document.createElement('span');
      testsPill.className = 'reinspection-pill reinspection-pill-tests-passed';
      testsPill.textContent = '✓ TESTS PASSED FOR SNAPSHOT';
      testsPill.title = 'Genuine passing local tests observed for this exact snapshot.';
      badgesRow.appendChild(testsPill);
    }

    // 3. Truthful fix status (strictly unverified)
    const unverifiedPill = document.createElement('span');
    unverifiedPill.className = 'reinspection-pill reinspection-pill-unverified-fix';
    unverifiedPill.textContent = 'FIX UNVERIFIED';
    unverifiedPill.title = 'Neither source code changes nor AI speculation can declare a fix verified.';
    badgesRow.appendChild(unverifiedPill);

    card.appendChild(badgesRow);

    // Meta row (timestamp & fingerprints)
    const metaRow = document.createElement('div');
    metaRow.className = 'reinspection-meta-row';

    const timeSpan = document.createElement('span');
    const atDate = result.at ? new Date(result.at) : null;
    timeSpan.textContent = atDate && !isNaN(atDate.getTime())
      ? 'Evaluated: ' + atDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : 'Evaluated locally';
    metaRow.appendChild(timeSpan);

    const fpSpan = document.createElement('span');
    const origFp = (result.originalFingerprint || record.fingerprint || '').slice(0, 8);
    const currFp = (result.fingerprint || currentFp || '').slice(0, 8);
    fpSpan.textContent = 'Baseline: ' + (origFp || 'original') + ' → Current: ' + (currFp || 'latest');
    metaRow.appendChild(fpSpan);
    card.appendChild(metaRow);

    // Host message
    if (result.message) {
      const msgEl = document.createElement('div');
      msgEl.className = 'reinspection-message';
      msgEl.textContent = result.message;
      card.appendChild(msgEl);
    }

    // Truthful classification explanation
    const truthBox = document.createElement('div');
    truthBox.className = 'reinspection-truth-note' + (hasPassingTests ? ' note-passed' : '');

    const truthTitle = document.createElement('div');
    truthTitle.style.fontWeight = '600';
    truthTitle.style.marginBottom = '3px';

    const truthDesc = document.createElement('div');

    if (isUnchanged) {
      truthTitle.textContent = 'Finding remains unaddressed in cited code';
      truthDesc.textContent = 'The original evidence remains identical in the cited files. The finding has not been demonstrated to be addressed.';
    } else if (isChanged) {
      truthTitle.textContent = 'Code modified — fix remains unverified';
      truthDesc.textContent = hasPassingTests
        ? 'Code in the cited locations changed and project tests passed for this snapshot. Passing the overall test suite demonstrates the build succeeds, but is not proof that this specific finding is fixed.'
        : 'Code in the cited locations changed since the finding was recorded. However, code modification alone does NOT prove functional correctness or that the gap has been resolved. Run project tests (P2-13) or re-investigate to verify.';
    } else if (isRemoved) {
      truthTitle.textContent = 'Cited file removed — not verified';
      truthDesc.textContent = 'One or more cited files were removed from the workspace. Removing a file does not verify that the finding is resolved or that the gap no longer applies.';
    } else {
      truthTitle.textContent = 'Cannot compare with baseline';
      truthDesc.textContent = 'The cited references could not be compared with current files. Re-investigating this room is recommended.';
    }
    truthBox.appendChild(truthTitle);
    truthBox.appendChild(truthDesc);
    card.appendChild(truthBox);

    // Cited evidence references list
    const evidenceList = Array.isArray(result.evidence) ? result.evidence : [];
    if (evidenceList.length > 0) {
      const evHeader = document.createElement('div');
      evHeader.style.fontSize = '11px';
      evHeader.style.fontWeight = '600';
      evHeader.style.color = 'var(--text-primary)';
      evHeader.style.marginTop = '4px';
      evHeader.textContent = 'Cited Evidence References Status:';
      card.appendChild(evHeader);

      const grid = document.createElement('div');
      grid.className = 'reinspection-evidence-grid';

      evidenceList.forEach((ref) => {
        const item = document.createElement('div');
        item.className = 'reinspection-evidence-item';

        const fileBtn = document.createElement('button');
        fileBtn.type = 'button';
        fileBtn.className = 'reinspection-file-btn';

        const isRemovedRef = ref.state === 'file_removed';
        const targetLine = ref.currentLine || ref.originalLine || 1;
        const lineText = ref.currentLine && ref.originalLine && ref.currentLine !== ref.originalLine
          ? ' (L' + ref.originalLine + ' → L' + ref.currentLine + ')'
          : (ref.originalLine ? ' (Line ' + ref.originalLine + ')' : '');

        fileBtn.textContent = '📄 ' + ref.file + (isRemovedRef ? ' [Removed]' : lineText);
        fileBtn.disabled = isRemovedRef;

        if (!isRemovedRef) {
          fileBtn.title = 'Click to open ' + ref.file + ' at line ' + targetLine;
          fileBtn.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({
              command: 'openFile',
              path: ref.file,
              line: targetLine,
            });
          });
        } else {
          fileBtn.title = 'Cited file no longer exists in workspace';
        }
        item.appendChild(fileBtn);

        const statePill = document.createElement('span');
        const refState = ref.state || 'not_comparable';
        statePill.className = 'reinspection-ref-pill ref-state-' + refState;
        statePill.textContent = String(refState).toUpperCase().replace(/_/g, ' ');
        item.appendChild(statePill);

        if (ref.note) {
          const noteEl = document.createElement('div');
          noteEl.className = 'reinspection-ref-note';
          noteEl.textContent = ref.note;
          item.appendChild(noteEl);
        }

        grid.appendChild(item);
      });

      card.appendChild(grid);
    }

    reinspectSec.appendChild(card);
    investigationPanel.appendChild(reinspectSec);
  }

  // Message Listener
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'scanState': {
        if (msg.state && (msg.state.status === 'scanning' || msg.state.isStale)) {
          cachedEvidenceChains = {};
        }
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
          if (msg.activeFolderPath && currentActiveFolderPath !== null && currentActiveFolderPath !== msg.activeFolderPath) {
            resetWorkspaceFolderState();
          }
          currentActiveFolderPath = msg.activeFolderPath || null;

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
        const isUntrusted = msg.isTrusted === false;
        isWorkspaceUntrusted = isUntrusted;
        updateTestRunButtonUi();
        const consentCheckbox = document.getElementById('consentCheckbox');
        const privacyBadge = document.getElementById('privacyBadge');
        const trustNotice = document.getElementById('payloadTrustNotice');

        if (isUntrusted) {
          confirmedAiConsent = false;
          if (modeBadge) {
            modeBadge.textContent = 'AI Blocked (Untrusted)';
            modeBadge.style.color = 'var(--status-blocked)';
            modeBadge.title = 'AI companions are disabled in untrusted workspaces';
          }
          if (consentCheckbox) {
            consentCheckbox.checked = false;
            consentCheckbox.disabled = true;
            consentCheckbox.title = 'Cloud AI is disabled in untrusted workspaces';
          }
          if (privacyBadge) {
            privacyBadge.textContent = 'Untrusted: AI Blocked';
            privacyBadge.classList.add('privacy-badge-warning');
          }
          if (trustNotice) {
            trustNotice.textContent =
              'Restricted Mode: Workspace is untrusted. Read-only architecture visualization is active; cloud AI requests and local test execution are disabled.';
          }
        } else {
          confirmedAiConsent = Boolean(msg.aiConsent);
          if (consentCheckbox) {
            consentCheckbox.disabled = false;
            consentCheckbox.checked = confirmedAiConsent;
            consentCheckbox.title =
              'When enabled, queries consult configured AI keys. Source code is never sent without consent.';
          }
          if (privacyBadge) {
            privacyBadge.textContent = 'Zero Raw Secrets';
            privacyBadge.classList.remove('privacy-badge-warning');
          }
          if (modeBadge) {
            if (msg.hasApiKey && msg.aiConsent) {
              modeBadge.textContent = 'Cloud AI Active';
              modeBadge.style.color = '#E0B565';
              modeBadge.title = 'Cloud AI enabled with valid credentials';
            } else {
              modeBadge.textContent = 'Offline Safe';
              modeBadge.style.color = 'var(--text-secondary)';
              modeBadge.title = 'Offline analysis only; no external AI calls';
            }
          }
          if (trustNotice) {
            trustNotice.textContent =
              'Prepared-Context Preview (Offline Inspection): Displays the host-prepared adapter payload (toChatRepoContext). Previewing does not call any AI provider. Disclosure: Until Milestone P2-08 connects companions to this adapter, this preview does not represent what the legacy chatbot sends.';
          }
        }

        const drawer = document.getElementById('payloadPreviewDrawer');
        if (drawer && !drawer.classList.contains('hidden')) {
          requestHostPayloadPreview();
        }
        break;
      }
      case 'payloadPreview': {
        handleHostPayloadResponse(msg);
        break;
      }
      case 'updateBlueprint': {
        const prevSelectedRoomId = currentSelectedRoomId;
        const prevSelectedNodeId = selectedGraphNodeId;
        currentBlueprintData = msg.data;

        // Invalidate cached evidence chains and lens graphs on workspace rescan or fingerprint change
        cachedEvidenceChains = {};
        cachedLensGraphs = {};

        // Preserve selected room if it still exists
        const roomStillExists =
          msg.data.rooms && msg.data.rooms.some((r) => r.id === prevSelectedRoomId);
        currentSelectedRoomId =
          prevSelectedRoomId && roomStillExists
            ? prevSelectedRoomId
            : (msg.selectedRoomId || (msg.data.rooms[0]?.id ?? null));

        if (msg.data.graph) {
          cachedLensGraphs['modules'] = msg.data.graph;
        }

        renderBlueprint(msg.data);
        renderIsometricHouse(msg.data.rooms || [], currentSelectedRoomId);
        updateInspector();
        updateChatContextIndicator();
        renderLedger(msg.data.rooms || []);

        // Lens preservation (P2-12)
        if (currentSelectedLensId === 'modules') {
          currentGraph = msg.data.graph;
          if (panelGraph && !panelGraph.classList.contains('hidden') && currentGraph) {
            renderGraph(currentGraph);
            if (prevSelectedNodeId) {
              const nodeExists =
                currentGraph.nodes && currentGraph.nodes.some((n) => n.id === prevSelectedNodeId);
              if (nodeExists) {
                selectedGraphNodeId = prevSelectedNodeId;
                highlightSelectedGraphNode(selectedGraphNodeId);
              }
            }
          }
        } else {
          // Re-request current non-default lens from host
          vscode.postMessage({ command: 'selectArchitectureLens', lensId: currentSelectedLensId });
        }

        // Re-request evidence chain if room selected
        if (currentSelectedRoomId) {
          updateEvidenceChainUi();
        }

        const drawer = document.getElementById('payloadPreviewDrawer');
        if (drawer && !drawer.classList.contains('hidden')) {
          requestHostPayloadPreview();
        }
        break;
      }
      case 'companionAnalysis': {
        renderCompanionAnalysis(msg.analysis);
        break;
      }
      case 'companionReplies': {
        appendCompanionReplies(msg.messages || [], {
          suggestedFollowUps: msg.suggestedFollowUps,
          suggestedQuestions: msg.suggestedQuestions,
          errorInfo: msg.errorInfo,
          error: msg.error,
        });
        break;
      }
      case 'companionError': {
        stopWatchdogTimer();
        updateSendingState(false);
        hideThinkingBubble();
        renderErrorNotice(msg.errorInfo || msg.error || msg.message, lastSubmittedQuestion);
        break;
      }
      case 'explanationLevel': {
        if (msg.level && ['beginner', 'intermediate', 'technical'].includes(msg.level)) {
          currentExplanationLevel = msg.level;
          if (explanationLevelSelect) {
            explanationLevelSelect.value = msg.level;
          }
          updateChatContextIndicator();
        }
        break;
      }
      case 'conversationHistory': {
        handleHostConversationHistory(msg.turns);
        break;
      }
      case 'companionThinking': {
        if (msg.isThinking) {
          showThinkingBubble(msg.speaker);
        } else {
          hideThinkingBubble();
          updateSendingState(false);
          stopWatchdogTimer();
        }
        break;
      }
      case 'investigationFindings': {
        storedFindingsByRoomId = msg.findings || {};
        Object.keys(storedFindingsByRoomId).forEach((rid) => {
          const rec = storedFindingsByRoomId[rid];
          if (rec && Array.isArray(rec.reinspections) && rec.reinspections.length > 0) {
            latestReinspectionByRoomId[rid] = rec.reinspections[rec.reinspections.length - 1];
          }
        });
        updateInvestigationUi();
        break;
      }
      case 'investigationState': {
        if (msg.status === 'loading') {
          setInvestigatingState(true, msg.roomId);
        } else if (!msg.roomId || msg.roomId === activeInvestigatingRoomId) {
          setInvestigatingState(false);
        }
        break;
      }
      case 'investigationResult': {
        if (!msg.roomId || msg.roomId === activeInvestigatingRoomId) {
          setInvestigatingState(false);
        }
        if (msg.roomId && msg.record) {
          storedFindingsByRoomId[msg.roomId] = msg.record;
          if (Array.isArray(msg.record.reinspections) && msg.record.reinspections.length > 0) {
            latestReinspectionByRoomId[msg.roomId] = msg.record.reinspections[msg.record.reinspections.length - 1];
          }
        }
        if (msg.roomId === currentSelectedRoomId) {
          updateInvestigationUi();
        }
        break;
      }
      case 'investigationUnavailable': {
        handleInvestigationUnavailable(msg);
        break;
      }
      case 'investigationError': {
        handleInvestigationError(msg);
        break;
      }
      case 'handoffResult': {
        handleHandoffResult(msg);
        break;
      }
      case 'reinspectionResult': {
        handleReinspectionResult(msg);
        break;
      }
      case 'architectureLens': {
        handleArchitectureLensResponse(msg);
        break;
      }
      case 'evidenceChain': {
        handleEvidenceChainResponse(msg);
        break;
      }
      case 'testRunState': {
        isTestRunning = msg.state === 'running';
        updateTestRunButtonUi();
        showTestRunState(msg);
        break;
      }
      case 'testRunResult': {
        showTestRunResult(msg);
        break;
      }
      case 'testRunEvidence': {
        handleTestRunEvidence(msg);
        break;
      }
      case 'roomSelected': {
        currentSelectedRoomId = msg.roomId;
        updateInspector();
        updateChatContextIndicator();
        if (currentBlueprintData) {
          renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
        }
        break;
      }
      case 'requestRejected': {
        const cmd = msg.command;
        const reason = msg.reason || 'Request rejected by host.';
        if (cmd === 'askCompanion') {
          stopWatchdogTimer();
          updateSendingState(false);
          hideThinkingBubble();
          renderErrorNotice(
            {
              kind: 'request_rejected',
              title: 'Request Rejected',
              message: reason,
              retryable: false,
            },
            lastSubmittedQuestion
          );
        } else if (cmd === 'investigateRoom') {
          activeInvestigationWatchdog = clearTimer(activeInvestigationWatchdog);
          setInvestigatingState(false);
          handleInvestigationError({
            roomId: msg.roomId || activeInvestigatingRoomId || currentSelectedRoomId,
            errorInfo: {
              kind: 'request_rejected',
              title: 'Investigation Request Rejected',
              message: reason,
              retryable: false,
            },
          });
        } else if (cmd === 'reinspectFinding') {
          activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);
          setReinspectingState(false);
          handleReinspectionError({
            roomId: msg.roomId || activeReinspectingRoomId || currentSelectedRoomId,
            error: reason,
          });
        } else if (cmd === 'handoffRepairPrompt') {
          activeHandoffWatchdog = clearTimer(activeHandoffWatchdog);
          setHandoffButtonsState(false);
          showHandoffFeedback('⚠️ Host handoff rejected: ' + reason, 'error');
        } else if (cmd === 'requestEvidenceChain') {
          renderEvidenceChain(msg.roomId || currentSelectedRoomId, {
            error: reason,
          });
        } else if (cmd === 'runProjectTests') {
          isTestRunning = false;
          updateTestRunButtonUi();
          showTestRunResult({
            status: 'unavailable',
            message: reason,
          });
        } else if (cmd === 'selectArchitectureLens') {
          if (graphTruthBanner) {
            graphTruthBanner.textContent = '';
            const strong = document.createElement('strong');
            strong.textContent = 'Architecture Lens:';
            graphTruthBanner.appendChild(strong);
            graphTruthBanner.appendChild(
              document.createTextNode(' Request rejected (' + reason + ')')
            );
          }
          if (lensInsufficientNotice) {
            lensInsufficientNotice.classList.remove('hidden');
            lensInsufficientNotice.textContent = '⚠️ Lens request rejected: ' + reason;
          }
          updateLensStatusPill(currentSelectedLensId, false);
        } else {
          stopWatchdogTimer();
          updateSendingState(false);
          hideThinkingBubble();
          activeInvestigationWatchdog = clearTimer(activeInvestigationWatchdog);
          setInvestigatingState(false);
          activeReinspectionWatchdog = clearTimer(activeReinspectionWatchdog);
          setReinspectingState(false);
          activeHandoffWatchdog = clearTimer(activeHandoffWatchdog);
          setHandoffButtonsState(false);
          isTestRunning = false;
          updateTestRunButtonUi();
          const chainLoading = document.querySelector('.evidence-chain-loading');
          if (chainLoading && currentSelectedRoomId) {
            renderEvidenceChain(currentSelectedRoomId, { error: reason });
          }
          if (graphTruthBanner && graphTruthBanner.textContent.includes('Requesting lens')) {
            graphTruthBanner.textContent = '';
            const s = document.createElement('strong');
            s.textContent = 'Architecture Lens:';
            graphTruthBanner.appendChild(s);
            graphTruthBanner.appendChild(document.createTextNode(' Request rejected (' + reason + ')'));
          }
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

  // Host-driven Payload Preview
  let payloadPreviewTimeout = null;

  function requestHostPayloadPreview() {
    payloadPreviewTimeout = clearTimer(payloadPreviewTimeout);

    const loadingState = document.getElementById('payloadLoadingState');
    const errorState = document.getElementById('payloadErrorState');
    const emptyState = document.getElementById('payloadEmptyState');
    const contentState = document.getElementById('payloadContentState');

    if (loadingState) loadingState.classList.remove('hidden');
    if (errorState) errorState.classList.add('hidden');
    if (emptyState) emptyState.classList.add('hidden');
    if (contentState) contentState.classList.add('hidden');

    vscode.postMessage({ command: 'requestPayloadPreview' });

    // Handle host timeout or unintegrated host command
    payloadPreviewTimeout = setTimeout(() => {
      payloadPreviewTimeout = null;
      if (loadingState) loadingState.classList.add('hidden');
      if (errorState) {
        errorState.classList.remove('hidden');
        const errText = document.getElementById('payloadErrorText');
        if (errText) {
          errText.textContent =
            "Host integration pending: no response received from host command 'requestPayloadPreview'.";
        }
      }
    }, 4000);
  }

  function handleHostPayloadResponse(msg) {
    payloadPreviewTimeout = clearTimer(payloadPreviewTimeout);

    const loadingState = document.getElementById('payloadLoadingState');
    const errorState = document.getElementById('payloadErrorState');
    const emptyState = document.getElementById('payloadEmptyState');
    const contentState = document.getElementById('payloadContentState');

    if (loadingState) loadingState.classList.add('hidden');

    if (msg.error) {
      if (errorState) {
        errorState.classList.remove('hidden');
        const errText = document.getElementById('payloadErrorText');
        if (errText) errText.textContent = String(msg.error);
      }
      if (emptyState) emptyState.classList.add('hidden');
      if (contentState) contentState.classList.add('hidden');
      return;
    }

    const payload = msg.payload;
    if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (errorState) errorState.classList.add('hidden');
      if (contentState) contentState.classList.add('hidden');
      return;
    }

    if (errorState) errorState.classList.add('hidden');
    if (emptyState) emptyState.classList.add('hidden');
    if (contentState) contentState.classList.remove('hidden');

    renderHostPayload(payload);
  }

  function renderHostPayload(payload) {
    const targetWsEl = document.getElementById('previewTargetWorkspace');
    const discEl = document.getElementById('previewDiscoveredCount');
    const inspEl = document.getElementById('previewInspectedCount');
    const exclEl = document.getElementById('previewExcludedCount');
    const codeView = document.getElementById('payloadCodeView');
    const provenanceTag = document.getElementById('payloadProvenanceTag');

    if (targetWsEl) {
      targetWsEl.textContent =
        payload.repository?.name || payload.workspaceName || payload.name || 'Workspace';
    }
    if (discEl) {
      discEl.textContent = String(
        payload.discoveredFilesCount ?? payload.metrics?.discoveredFilesCount ?? '—'
      );
    }
    if (inspEl) {
      inspEl.textContent = String(
        payload.inspectedFilesCount ?? payload.metrics?.inspectedFilesCount ?? '—'
      );
    }
    if (exclEl) {
      const skippedCount =
        payload.skippedFilesCount ??
        payload.metrics?.skippedSensitiveFilesCount ??
        (Array.isArray(payload.skippedFiles) ? payload.skippedFiles.length : '—');
      exclEl.textContent = String(skippedCount);
    }
    if (provenanceTag) {
      provenanceTag.textContent = payload.hostGenerated ? 'Host Verified' : 'Host Supplied';
    }

    if (codeView) {
      // Clean stringify, guaranteeing never to display raw credentials if any were passed
      const safePayload = Object.assign({}, payload);
      delete safePayload.apiKey;
      delete safePayload.token;
      delete safePayload.secret;
      codeView.textContent = JSON.stringify(safePayload, null, 2);
    }
  }

  function renderSuggestionsRow(questions) {
    const suggRow = document.getElementById('suggestionsRow');
    if (!suggRow) return;
    suggRow.textContent = '';
    if (!Array.isArray(questions) || questions.length === 0) return;

    questions.forEach((q) => {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';
      chip.textContent = q;
      chip.addEventListener('click', () => {
        submitQuery(q);
      });
      suggRow.appendChild(chip);
    });
  }

  function renderEmptyChatState() {
    const thread = document.getElementById('companionThread');
    if (!thread) return;
    thread.textContent = '';

    const emptyBox = document.createElement('div');
    emptyBox.className = 'chat-empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.textContent = '🐾';
    emptyBox.appendChild(icon);

    const title = document.createElement('div');
    title.className = 'empty-state-title';
    title.textContent = 'Architectural Companions';
    emptyBox.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'empty-state-desc';
    desc.textContent =
      'Ask Barkley about architectural modules, patterns, or relationships. Cleo audits evidence gaps and unverified claims.';
    emptyBox.appendChild(desc);

    thread.appendChild(emptyBox);
  }

  function renderErrorNotice(errorInfo, failedQuestion) {
    const thread = document.getElementById('companionThread');
    if (!thread) return;

    const card = document.createElement('div');
    card.className = 'chat-error-notice';

    const header = document.createElement('div');
    header.className = 'error-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'error-title-row';
    const icon = document.createElement('span');
    icon.textContent = '⚠️';
    const title = document.createElement('span');
    title.className = 'error-title';
    title.textContent = (errorInfo && errorInfo.title) || 'AI Provider Notice';
    titleRow.appendChild(icon);
    titleRow.appendChild(title);
    header.appendChild(titleRow);

    if (errorInfo && errorInfo.kind) {
      const badge = document.createElement('span');
      badge.className = 'error-badge';
      badge.textContent = String(errorInfo.kind).toUpperCase().replace(/_/g, ' ');
      header.appendChild(badge);
    }
    card.appendChild(header);

    const msgEl = document.createElement('div');
    msgEl.className = 'error-message';
    msgEl.textContent =
      (errorInfo && (errorInfo.message || errorInfo.error)) ||
      (typeof errorInfo === 'string'
        ? errorInfo
        : 'An unexpected error occurred while communicating with the AI provider.');
    card.appendChild(msgEl);

    if (
      errorInfo &&
      errorInfo.retryAfterSeconds !== undefined &&
      errorInfo.retryAfterSeconds !== null
    ) {
      const retryInfo = document.createElement('div');
      retryInfo.className = 'error-retry-text';
      retryInfo.textContent = '⏳ Provider cooldown: retry recommended in ' + errorInfo.retryAfterSeconds + 's';
      card.appendChild(retryInfo);
    }

    if (errorInfo && errorInfo.detailSafe) {
      const detail = document.createElement('div');
      detail.className = 'error-detail-text';
      detail.textContent = errorInfo.detailSafe;
      card.appendChild(detail);
    }

    const retryRow = document.createElement('div');
    retryRow.className = 'error-retry-row';

    const hint = document.createElement('span');
    hint.className = 'text-empty-hint';
    hint.textContent = 'Existing architecture & evidence remain fully available.';
    retryRow.appendChild(hint);

    if (errorInfo?.retryable !== false && failedQuestion) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-retry-chat';
      retryBtn.textContent = '↻ Retry Query';
      retryBtn.title = 'Retry: "' + failedQuestion.slice(0, 40) + '..."';
      retryBtn.addEventListener('click', () => {
        card.remove();
        submitQuery(failedQuestion);
      });
      retryRow.appendChild(retryBtn);
    }
    card.appendChild(retryRow);

    thread.appendChild(card);
    thread.scrollTop = thread.scrollHeight;
  }

  function renderCompanionAnalysis(analysis) {
    if (!analysis) return;
    const initialText = document.getElementById('initialAnalyzingState');
    if (initialText) initialText.remove();

    const thread = document.getElementById('companionThread');
    if (!thread) return;

    // Refresh suggested questions / follow-ups
    latestAnalysisQuestions =
      analysis.suggestedQuestions || analysis.suggestedFollowUps || [];
    renderSuggestionsRow(latestAnalysisQuestions);

    // If chat history exists, do NOT wipe the thread or restore empty state
    const hasExistingConversation = Boolean(
      thread.querySelector('.chat-bubble, .chat-error-notice')
    );
    if (hasExistingConversation) {
      return;
    }

    thread.textContent = '';
    const msgs = analysis.messages || [];
    if (msgs.length === 0) {
      renderEmptyChatState();
    } else {
      msgs.forEach((msg) => {
        thread.appendChild(createCompanionBubble(msg));
      });
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function appendCompanionReplies(messages, options = {}) {
    stopWatchdogTimer();
    updateSendingState(false);
    hideThinkingBubble();

    const initialText = document.getElementById('initialAnalyzingState');
    if (initialText) initialText.remove();

    const emptyBox = document.querySelector('.chat-empty-state');
    if (emptyBox) emptyBox.remove();

    const thread = document.getElementById('companionThread');
    if (!thread) return;

    if (Array.isArray(messages) && messages.length > 0) {
      messages.forEach((msg) => {
        thread.appendChild(createCompanionBubble(msg));
      });
    }

    const followUps = options.suggestedFollowUps || options.suggestedQuestions;
    if (Array.isArray(followUps) && followUps.length > 0) {
      renderSuggestionsRow(followUps);
    }

    if (options.errorInfo || options.error) {
      renderErrorNotice(options.errorInfo || options.error, lastSubmittedQuestion);
    }

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

    const leftHeader = document.createElement('div');
    leftHeader.className = 'bubble-left-header';

    const speaker = document.createElement('span');
    speaker.className = 'bubble-speaker ' + (isDog ? 'speaker-dog' : 'speaker-cat');
    speaker.textContent = msg.speakerName || (isDog ? 'Barkley' : 'Cleo');
    leftHeader.appendChild(speaker);

    const tagline = document.createElement('span');
    tagline.className = 'bubble-tagline';
    tagline.textContent =
      msg.tagline || (isDog ? 'Friendly · Architectural Teacher' : 'Sassy · Skeptical Reviewer');
    leftHeader.appendChild(tagline);
    header.appendChild(leftHeader);

    const metaBadge = document.createElement('span');
    metaBadge.className = 'bubble-badge';
    if (msg.isAiGenerated) {
      metaBadge.className += ' bubble-badge-ai';
      const provider = msg.providerUsed ? msg.providerUsed.toUpperCase() : 'CLOUD AI';
      metaBadge.textContent = msg.fallbackUsed ? 'AI (' + provider + ' · Fallback)' : 'AI (' + provider + ')';
    } else {
      metaBadge.className += ' bubble-badge-offline';
      metaBadge.textContent = 'Offline (no AI call)';
    }
    header.appendChild(metaBadge);
    contentCol.appendChild(header);

    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = msg.text || '';
    contentCol.appendChild(textEl);

    // Evidence references: strictly build file chips only from host evidenceRefs objects
    const refs = [];
    if (Array.isArray(msg.evidenceRefs)) {
      msg.evidenceRefs.forEach((r) => {
        if (r && typeof r === 'object' && r.file) {
          refs.push({
            file: r.file,
            line: r.line || 1,
            label: r.label,
            status: r.status,
            verified: r.verified,
            note: r.note,
          });
        }
      });
    }

    if (refs.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'evidence-chips';
      refs.forEach((ref) => {
        const a = document.createElement('a');
        const isVerified =
          (ref.status === 'verified' || ref.verified === true) &&
          ref.verified !== false &&
          ref.status !== 'unverified' &&
          ref.status !== 'uninspected' &&
          ref.status !== 'unverified_not_inspected';
        const isLineUnverified = ref.status === 'line_unverified';

        if (isVerified) {
          a.className = 'file-pill ref-pill-verified';
          a.textContent = '✓ ' + (ref.label || ((ref.file.split('/').pop() || ref.file) + ':' + ref.line));
          a.title = (ref.note ? ref.note + ' — ' : '') + ref.file + ':' + ref.line + ' (Inspected & verified evidence)';
        } else if (isLineUnverified) {
          a.className = 'file-pill ref-pill-line-unverified';
          a.textContent = '? ' + (ref.label || ((ref.file.split('/').pop() || ref.file) + ':' + ref.line + ' (line unverified)'));
          a.title = (ref.note ? ref.note + ' — ' : '') + ref.file + ':' + ref.line + ' (Inspected file; cited line beyond inspected excerpt)';
        } else {
          a.className = 'file-pill ref-pill-unverified';
          const baseName = ref.file.split('/').pop() || ref.file;
          a.textContent = '⚠ ' + (ref.label && ref.label.includes('unverified') ? ref.label : baseName + ' (unverified reference, not inspected)');
          a.title = (ref.note ? ref.note + ' — ' : '') + ref.file + ':1 (Unverified reference: file exists in workspace but was not inspected; opens at line 1)';
        }

        a.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ command: 'openFile', path: ref.file, line: ref.line || 1 });
        });
        chips.appendChild(a);
      });
      contentCol.appendChild(chips);
    }

    // Small honest count when the host reports references that could not be verified
    const droppedCount = Number(msg.droppedReferenceCount || msg.droppedCount || msg.droppedRefsCount || 0);
    const unverifiedCount = Number(msg.unverifiedReferenceCount || msg.unverifiedCount || msg.unverifiedRefsCount || 0);
    if (droppedCount > 0 || unverifiedCount > 0) {
      const unverifiedNotice = document.createElement('div');
      unverifiedNotice.className = 'refs-unverified-count-note';
      const noteParts = [];
      if (droppedCount > 0) {
        noteParts.push(droppedCount + ' cited reference' + (droppedCount === 1 ? '' : 's') + ' could not be found in workspace and ' + (droppedCount === 1 ? 'was' : 'were') + ' dropped');
      }
      if (unverifiedCount > 0) {
        noteParts.push(unverifiedCount + ' reference' + (unverifiedCount === 1 ? '' : 's') + ' could not be verified against workspace inspections');
      }
      unverifiedNotice.textContent = 'ℹ ' + noteParts.join('; ');
      contentCol.appendChild(unverifiedNotice);
    }

    // Follow-up suggestions
    if (Array.isArray(msg.suggestedFollowUps) && msg.suggestedFollowUps.length > 0) {
      const followUpsBox = document.createElement('div');
      followUpsBox.className = 'follow-ups-container';

      const lbl = document.createElement('span');
      lbl.className = 'follow-ups-label';
      lbl.textContent = 'Suggested Follow-ups';
      followUpsBox.appendChild(lbl);

      const list = document.createElement('div');
      list.className = 'follow-ups-list';
      msg.suggestedFollowUps.forEach((fu) => {
        const chip = document.createElement('button');
        chip.className = 'follow-up-chip';
        chip.textContent = '↳ ' + fu;
        chip.title = 'Ask: "' + fu + '"';
        chip.addEventListener('click', () => {
          submitQuery(fu);
        });
        list.appendChild(chip);
      });
      followUpsBox.appendChild(list);
      contentCol.appendChild(followUpsBox);
    }

    // Inline error notice if message carried errorInfo
    if (msg.errorInfo) {
      renderErrorNotice(msg.errorInfo, lastSubmittedQuestion);
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
        d:
          'M ' +
          x1 +
          ' ' +
          y1 +
          ' C ' +
          x1 +
          ' ' +
          (y1 + y2) / 2 +
          ', ' +
          x2 +
          ' ' +
          (y1 + y2) / 2 +
          ', ' +
          x2 +
          ' ' +
          y2,
        class: 'graph-edge',
        'marker-end': 'url(#graphArrow)',
      });

      if (edge.label) {
        pathEl.setAttribute('title', sanitizeSecretText(edge.label));
      }
      if (edge.filePath) {
        pathEl.style.cursor = 'pointer';
        pathEl.addEventListener('click', () => {
          vscode.postMessage({ command: 'openFile', path: edge.filePath, line: edge.line || 1 });
        });
      }

      edgesLayer.appendChild(pathEl);
    });

    graph.nodes.forEach((node) => {
      const isSelected = node.id === selectedGraphNodeId;
      const g = createSvgEl('g', {
        class: 'graph-node' + (isSelected ? ' selected' : ''),
        transform: 'translate(' + node.x + ',' + node.y + ')',
        'data-node-id': node.id,
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

      const labelText = sanitizeSecretText(node.label || '');
      const t1 = createSvgEl('text', {
        x: '12',
        y: '26',
        class: 'node-title',
      });
      t1.textContent = labelText.length > 22 ? labelText.slice(0, 20) + '...' : labelText;
      g.appendChild(t1);

      const subLabelText = sanitizeSecretText(node.subLabel || '');
      const t2 = createSvgEl('text', {
        x: '12',
        y: '46',
        class: 'node-sub',
      });
      t2.textContent = subLabelText;
      g.appendChild(t2);

      const classText = sanitizeSecretText(node.classification || 'observed');
      const t3 = createSvgEl('text', {
        x: '12',
        y: '62',
        class: 'node-tag',
      });
      t3.textContent =
        '[' +
        classText.toUpperCase() +
        '] ' +
        (node.filePath ? '📄 ' + node.filePath.split('/').pop() : '');
      g.appendChild(t3);

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedGraphNodeId = node.id;
        highlightSelectedGraphNode(node.id);

        if (currentBlueprintData && Array.isArray(currentBlueprintData.rooms)) {
          const matchingRoom = currentBlueprintData.rooms.find(
            (r) =>
              r.id === node.id ||
              (node.filePath && r.filePaths && r.filePaths.includes(node.filePath))
          );
          if (matchingRoom) {
            currentSelectedRoomId = matchingRoom.id;
            updateInspector();
            updateChatContextIndicator();
            renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
            vscode.postMessage({ command: 'selectRoom', roomId: matchingRoom.id });
          }
        }

        if (node.filePath) {
          vscode.postMessage({ command: 'openFile', path: node.filePath, line: node.line || 1 });
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

    applyGraphTransform();
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
