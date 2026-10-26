import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { RepoConnectBar } from './components/RepoConnectBar';
import { ScanDetailsDrawer } from './components/ScanDetailsDrawer';
import { IsometricHouse } from './components/IsometricHouse';
import { RoomInspector } from './components/RoomInspector';
import { ChatPanel, type ChatMessageItem } from './components/ChatPanel';
import { SAMPLE_ROOMS, SAMPLE_PROJECT } from './data/sampleData';
import { mapScanResultToHouse } from './domain/github/architectureMapper';
import type { GitHubScanResult } from './domain/github/types';
import type { ArchitecturalRoom } from './types';
import type { RoomInvestigationFinding } from './domain/investigation/types';
import type { FixLifecycleState } from './domain/lifecycle/types';
import type { WorkspaceSession, WorkspaceSummary } from './domain/workspace/types';
import {
  loadWorkspace,
  saveWorkspace,
  deleteWorkspace,
  getRecentProjects,
  getActiveWorkspaceId,
  setActiveWorkspaceId as setActiveWorkspaceStorageId,
} from './domain/workspace/workspaceStorage';
import { ResilienceDashboard } from './components/resilience/ResilienceDashboard.tsx';
import type { RiskTier, ResilienceSnapshot } from './domain/resilience/types.ts';
import { buildResilienceContext } from './domain/resilience/index.ts';

export const App: React.FC = () => {
  const [rooms, setRooms] = useState<ArchitecturalRoom[]>(SAMPLE_ROOMS);
  const [selectedRoom, setSelectedRoom] = useState<ArchitecturalRoom | null>(SAMPLE_ROOMS[0]);
  const [isSampleActive, setIsSampleActive] = useState<boolean>(true);
  const [lastScanResult, setLastScanResult] = useState<GitHubScanResult | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isSavedData, setIsSavedData] = useState<boolean>(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<WorkspaceSummary[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [findingsByRoomId, setFindingsByRoomId] = useState<Record<string, RoomInvestigationFinding>>({});
  const [fixLifecyclesByRoomId, setFixLifecyclesByRoomId] = useState<Record<string, FixLifecycleState>>({});
  const [externalRepoUrl] = useState<string>('');

  // Part 2.5: Application View Mode ('blueprint' | 'resilience')
  // Live Risk -> chat: a queued question plus the service it is about.
  const [queuedPrompt, setQueuedPrompt] = useState<{ id: number; text: string } | null>(null);
  const [askFocusId, setAskFocusId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lb.chat') !== 'closed';
    } catch {
      return true;
    }
  });
  const setChatOpen = (open: boolean) => {
    setIsChatOpen(open);
    try {
      localStorage.setItem('lb.chat', open ? 'open' : 'closed');
    } catch {
      /* storage unavailable: keep in-memory state */
    }
  };
  const [viewMode, setViewMode] = useState<'blueprint' | 'resilience'>(() => {
    try {
      const saved = localStorage.getItem('lb.view');
      return saved === 'resilience' ? 'resilience' : 'blueprint';
    } catch {
      return 'blueprint';
    }
  });

  const [activeSnapshot, setActiveSnapshot] = useState<ResilienceSnapshot | null>(null);
  const [riskByRoomId, setRiskByRoomId] = useState<Record<string, RiskTier>>({});
  const applyStrategyRef = useRef<((stratId: string, targetServiceId?: string) => void) | null>(null);
  const clearStrategyRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (viewMode === 'resilience') setSelectedRoom(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleViewModeChange = (nextMode: 'blueprint' | 'resilience') => {
    setViewMode(nextMode);
    try {
      localStorage.setItem('lb.view', nextMode);
    } catch {
      // Safe fallback if local storage is restricted
    }
  };

  const activeScanIdRef = useRef<number>(0);

  // Restore workspace session on initial mount
  useEffect(() => {
    fetch('/api/health').catch(() => {
      // Fallback safely if health check endpoint fails
    });

    const recents = getRecentProjects();
    setRecentProjects(recents);

    const savedActiveId = getActiveWorkspaceId();
    if (savedActiveId) {
      const session = loadWorkspace(savedActiveId);
      if (session) {
        setLastScanResult(session.scanResult);
        setRooms(session.rooms);
        setSelectedRoom(
          session.rooms.find((r) => r.id === session.selectedRoomId) ||
          session.rooms[0] ||
          null
        );
        setIsSampleActive(false);
        setIsSavedData(true); // Restored data is honestly labeled as saved data
        setActiveWorkspaceId(session.id);
        setChatMessages(session.chatMessages || []);
        setFindingsByRoomId(session.findingsByRoomId || {});
        setFixLifecyclesByRoomId(session.fixLifecyclesByRoomId || {});
      }
    }
  }, []);



  const handleSelectRoom = (room: ArchitecturalRoom | null) => {
    if (!room) {
      setSelectedRoom(null);
      return;
    }
    const nextSelected = selectedRoom?.id === room.id ? null : room;
    setSelectedRoom(nextSelected);

    if (!isSampleActive && lastScanResult && activeWorkspaceId) {
      const existing = loadWorkspace(activeWorkspaceId);
      if (existing) {
        saveWorkspace({
          ...existing,
          selectedRoomId: nextSelected?.id || null,
        });
      }
    }
  };

  const handleScanComplete = (result: GitHubScanResult) => {
    activeScanIdRef.current += 1;

    const mapped = mapScanResultToHouse(result);
    const newRooms = mapped.rooms;
    const initialSelectedRoom = newRooms[0] || null;

    setLastScanResult(result);
    setIsSampleActive(false);
    setIsSavedData(false); // Live fresh scan
    setRooms(newRooms);
    setSelectedRoom(initialSelectedRoom);

    const workspaceId = `${result.owner}/${result.repo}`;
    setActiveWorkspaceId(workspaceId);
    setActiveWorkspaceStorageId(workspaceId);

    const initialChat: ChatMessageItem[] = [
      {
        id: `fresh-dog-${Date.now()}`,
        sender: 'dog',
        text: `Woof! Scanned ${workspaceId} at ${result.commitSha?.slice(0, 7) || 'latest'}. Discovered ${newRooms.length} rooms!`,
        timestamp: 'Scan',
      },
      {
        id: `fresh-cat-${Date.now()}`,
        sender: 'cat',
        text:
          result.ciEvaluation?.outcome === 'failed'
            ? `CI is currently FAILING for commit ${result.commitSha?.slice(0, 7)}. Blocker evidence found in architecture.`
            : `Scan completed cleanly. Ready to inspect architecture evidence.`,
        timestamp: 'Scan',
      },
    ];
    setChatMessages(initialChat);
    setFindingsByRoomId({});
    setFixLifecyclesByRoomId({});

    const session: WorkspaceSession = {
      id: workspaceId,
      owner: result.owner,
      repo: result.repo,
      branch: result.metadata?.defaultBranch || 'main',
      commitSha: result.commitSha || 'unknown',
      scannedAt: result.scannedAt || new Date().toISOString(),
      isSavedData: false,
      scanResult: result,
      rooms: newRooms,
      selectedRoomId: initialSelectedRoom?.id || null,
      chatMessages: initialChat,
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    saveWorkspace(session);
    setRecentProjects(getRecentProjects());
  };

  const handleChatMessagesChange = (newMsgs: ChatMessageItem[]) => {
    setChatMessages(newMsgs);
    if (!isSampleActive && lastScanResult && activeWorkspaceId) {
      const existing = loadWorkspace(activeWorkspaceId);
      if (existing) {
        saveWorkspace({
          ...existing,
          chatMessages: newMsgs,
        });
      }
    }
  };

  const handleFindingChange = (roomId: string, newFinding: RoomInvestigationFinding | null) => {
    setFindingsByRoomId((prev) => {
      const updated = { ...prev };
      if (newFinding) {
        updated[roomId] = newFinding;
      } else {
        delete updated[roomId];
      }
      if (!isSampleActive && lastScanResult && activeWorkspaceId) {
        const existing = loadWorkspace(activeWorkspaceId);
        if (existing) {
          saveWorkspace({
            ...existing,
            findingsByRoomId: updated,
          });
        }
      }
      return updated;
    });
  };

  const handleLifecycleChange = (roomId: string, state: FixLifecycleState | null) => {
    setFixLifecyclesByRoomId((prev) => {
      const updated = { ...prev };
      if (state) {
        updated[roomId] = state;
      } else {
        delete updated[roomId];
      }
      if (!isSampleActive && lastScanResult && activeWorkspaceId) {
        const existing = loadWorkspace(activeWorkspaceId);
        if (existing) {
          saveWorkspace({
            ...existing,
            fixLifecyclesByRoomId: updated,
          });
        }
      }
      return updated;
    });
  };

  const handleRoomUpdated = (updatedRoom: ArchitecturalRoom) => {
    const nextRooms = rooms.map((r) => (r.id === updatedRoom.id ? updatedRoom : r));
    setRooms(nextRooms);
    setSelectedRoom(updatedRoom);

    if (!isSampleActive && lastScanResult && activeWorkspaceId) {
      const existing = loadWorkspace(activeWorkspaceId);
      if (existing) {
        saveWorkspace({
          ...existing,
          rooms: nextRooms,
          selectedRoomId: updatedRoom.id,
        });
      }
    }
  };

  const handleSelectRecentProject = (id: string) => {
    activeScanIdRef.current += 1;

    const session = loadWorkspace(id);
    if (!session) return;

    setLastScanResult(session.scanResult);
    setRooms(session.rooms);
    setSelectedRoom(
      session.rooms.find((r) => r.id === session.selectedRoomId) ||
      session.rooms[0] ||
      null
    );
    setIsSampleActive(false);
    setIsSavedData(true); // Honestly labeled as saved data
    setActiveWorkspaceId(session.id);
    setActiveWorkspaceStorageId(session.id);
    setChatMessages(session.chatMessages || []);
    setFindingsByRoomId(session.findingsByRoomId || {});
    setFixLifecyclesByRoomId(session.fixLifecyclesByRoomId || {});
    setRecentProjects(getRecentProjects());
  };

  const handleDeleteRecentProject = (id: string) => {
    deleteWorkspace(id);
    const updated = getRecentProjects();
    setRecentProjects(updated);

    if (activeWorkspaceId === id) {
      handleResetSample();
    }
  };

  const handleResetSample = () => {
    activeScanIdRef.current += 1;
    setRooms(SAMPLE_ROOMS);
    setSelectedRoom(SAMPLE_ROOMS[0]);
    setIsSampleActive(true);
    setLastScanResult(null);
    setIsDrawerOpen(false);
    setIsSavedData(false);
    setActiveWorkspaceId(null);
    setActiveWorkspaceStorageId(null);
    setChatMessages([]);
    setFindingsByRoomId({});
    setFixLifecyclesByRoomId({});
  };

  const hasRiskAlert = Boolean(
    riskByRoomId &&
      Object.values(riskByRoomId).some(
        (tier) => tier === 'high' || tier === 'critical' || tier === 'failed'
      )
  );

  const handleNavigateToResilience = (roomId: string) => {
    const target = rooms.find((r) => r.id === roomId);
    if (target) {
      setSelectedRoom(target);
    }
    setViewMode('resilience');
  };

  const currentSourceName = isSampleActive
    ? SAMPLE_PROJECT.name
    : `${lastScanResult?.owner}/${lastScanResult?.repo}`;

  const currentProjectName = isSampleActive
    ? 'BookNook'
    : (lastScanResult ? `${lastScanResult.owner}/${lastScanResult.repo}` : 'BookNook');

  return (
    <div className="app-shell">
      <Header
        sourceName={currentSourceName}
        sourceStatusLabel={isSampleActive ? SAMPLE_PROJECT.statusLabel : undefined}
        isRealRepo={!isSampleActive}
        branchName={lastScanResult?.metadata?.defaultBranch}
        scanStatus={lastScanResult?.status}
        isSavedData={isSavedData}
        commitSha={lastScanResult?.commitSha}
        scannedAt={lastScanResult?.scannedAt}
        activeViewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        hasRiskAlert={hasRiskAlert}
      />

      <RepoConnectBar
        onScanComplete={handleScanComplete}
        onResetSample={handleResetSample}
        isSampleActive={isSampleActive}
        onOpenDetails={() => setIsDrawerOpen(true)}
        lastScanResult={lastScanResult}
        recentProjects={recentProjects}
        activeWorkspaceId={activeWorkspaceId}
        onSelectRecentProject={handleSelectRecentProject}
        onDeleteRecentProject={handleDeleteRecentProject}
        isSavedData={isSavedData}
        externalUrl={externalRepoUrl}
      />

      <main className="app-body">
        {/* Center / Left: Interactive Software Architecture House */}
        <section className="workspace-house-container" aria-label="Architecture House Workspace">
          <div className="workspace-toolbar">
            <div className="toolbar-title">
              <span>Interactive Architecture Map</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                ({isSampleActive ? 'Sample Data' : isSavedData ? 'Saved Scan (Not refreshed)' : 'Real Scanned Repository'} · Click any room to inspect evidence)
              </span>
            </div>

            {/* Status Legend */}
            <div className="house-legend" role="note" aria-label="Room Status Legend">
              <div className="legend-item">
                <span className="legend-swatch verified" />
                <span>Verified</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch progress" />
                <span>Implemented</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch planned" />
                <span>Planned</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch blocked" />
                <span>Blocked</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch unknown" />
                <span>Unknown</span>
              </div>
            </div>
          </div>

          {/* Workspace Area: Blueprint Isometric House vs Resilience Cascading Dashboard */}
          <div
            className="workspace-house-container"
            style={{
              flex: 1,
              display: viewMode === 'resilience' ? 'flex' : 'none',
              overflow: 'hidden',
              position: 'relative',
              width: '100%',
              height: '100%',
            }}
          >
            {viewMode === 'resilience' && (
              <RoomInspector
                room={selectedRoom}
                onClose={() => setSelectedRoom(null)}
                scanResult={lastScanResult}
                isSampleActive={isSampleActive}
                onRoomUpdated={handleRoomUpdated}
                savedFinding={selectedRoom ? findingsByRoomId[selectedRoom.id] : undefined}
                onFindingChange={handleFindingChange}
                savedLifecycleState={selectedRoom ? fixLifecyclesByRoomId[selectedRoom.id] : undefined}
                onLifecycleChange={handleLifecycleChange}
                allRooms={rooms}
                onSelectRoom={(roomId) => {
                  const targetRoom = rooms.find((r) => r.id === roomId);
                  if (targetRoom) {
                    handleSelectRoom(targetRoom);
                  }
                }}
                resilienceSnapshot={activeSnapshot}
                onApplyRecoveryStrategy={(stratId, targetId) => applyStrategyRef.current?.(stratId, targetId)}
                onClearRecoveryStrategy={() => clearStrategyRef.current?.()}
                onNavigateToResilience={handleNavigateToResilience}
              />
            )}

            <ResilienceDashboard
              onAskAi={(question, focusId) => {
                setAskFocusId(focusId);
                setChatOpen(true);
                setQueuedPrompt({ id: Date.now(), text: question });
              }}
              allRooms={rooms}
              selectedRoom={selectedRoom}
              onSelectRoom={handleSelectRoom}
              hasScanResult={!isSampleActive && Boolean(lastScanResult)}
              projectName={currentProjectName}
              onRiskChange={(mapping) => setRiskByRoomId(mapping)}
              onSnapshotChange={setActiveSnapshot}
              onRegisterApplyStrategy={(fn) => {
                applyStrategyRef.current = fn;
              }}
              onRegisterClearStrategy={(fn) => {
                clearStrategyRef.current = fn;
              }}
            />
          </div>

          <div
            className="svg-canvas-wrapper"
            style={{ display: viewMode === 'blueprint' ? 'flex' : 'none' }}
          >
            {viewMode === 'blueprint' && (
              <RoomInspector
                room={selectedRoom}
                onClose={() => setSelectedRoom(null)}
                scanResult={lastScanResult}
                isSampleActive={isSampleActive}
                onRoomUpdated={handleRoomUpdated}
                savedFinding={selectedRoom ? findingsByRoomId[selectedRoom.id] : undefined}
                onFindingChange={handleFindingChange}
                savedLifecycleState={selectedRoom ? fixLifecyclesByRoomId[selectedRoom.id] : undefined}
                onLifecycleChange={handleLifecycleChange}
                allRooms={rooms}
                onSelectRoom={(roomId) => {
                  const targetRoom = rooms.find((r) => r.id === roomId);
                  if (targetRoom) {
                    handleSelectRoom(targetRoom);
                  }
                }}
                resilienceSnapshot={activeSnapshot}
                onApplyRecoveryStrategy={(stratId, targetId) => applyStrategyRef.current?.(stratId, targetId)}
                onClearRecoveryStrategy={() => clearStrategyRef.current?.()}
                onNavigateToResilience={handleNavigateToResilience}
              />
            )}

            <IsometricHouse
              rooms={rooms}
              selectedRoomId={selectedRoom?.id ?? null}
              onSelectRoom={handleSelectRoom}
              foundationTechnologies={
                isSampleActive
                  ? ['PostgreSQL', 'Docker']
                  : (lastScanResult?.detectedTechnologies || [])
              }
              riskByRoomId={riskByRoomId}
            />
          </div>
        </section>

        {/* Right side: Persistent Chat Panel */}
        {isChatOpen ? (
        <ChatPanel
          onMinimize={() => {
            // A consumed question must not be re-sent when the chat remounts.
            setQueuedPrompt(null);
            setAskFocusId(null);
            setChatOpen(false);
          }}
          resilienceContext={
            viewMode === 'resilience' && activeSnapshot
              ? buildResilienceContext(activeSnapshot, askFocusId ?? activeSnapshot.rootCause.candidates[0]?.serviceId ?? '')
              : undefined
          }
          queuedPrompt={queuedPrompt}
          selectedRoom={selectedRoom}
          scanResult={lastScanResult}
          isSampleActive={isSampleActive}
          rooms={rooms}
          initialMessages={chatMessages}
          investigationFindings={findingsByRoomId}
          onFindingChange={handleFindingChange}
          onMessagesChange={handleChatMessagesChange}
          onSelectRoom={(roomId) => {
            const targetRoom = rooms.find((r) => r.id === roomId);
            if (targetRoom) {
              handleSelectRoom(targetRoom);
            }
          }}
        />
        ) : (
          <button type="button" className="chat-reopen" onClick={() => setChatOpen(true)} aria-label="Open Barkley and Cleo chat">
            💬 <span>Barkley &amp; Cleo</span>
          </button>
        )}
      </main>

      {/* Telemetry & Inspected Files Drawer */}
      <ScanDetailsDrawer
        scanResult={lastScanResult}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />
    </div>
  );
};

export default App;
