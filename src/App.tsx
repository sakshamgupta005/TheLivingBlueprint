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
import { GuidedWalkthrough } from './components/GuidedWalkthrough';
import { evaluateWalkthroughSteps } from './domain/walkthrough/walkthroughEngine';
import type { WalkthroughStep } from './domain/walkthrough/types';
import {
  loadWorkspace,
  saveWorkspace,
  deleteWorkspace,
  getRecentProjects,
  getActiveWorkspaceId,
  setActiveWorkspaceId as setActiveWorkspaceStorageId,
} from './domain/workspace/workspaceStorage';

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
  const [externalRepoUrl, setExternalRepoUrl] = useState<string>('');
  const [isWalkthroughOpen, setIsWalkthroughOpen] = useState<boolean>(true);
  const [isAiConfigured, setIsAiConfigured] = useState<boolean>(true);

  const activeScanIdRef = useRef<number>(0);

  // Restore workspace session on initial mount
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data.aiConfigured === 'boolean') {
          setIsAiConfigured(data.aiConfigured);
        }
      })
      .catch(() => {
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

  const walkthroughEvaluation = evaluateWalkthroughSteps({
    isSampleActive,
    lastScanResult,
    selectedRoom,
    rooms,
    chatMessages,
    findingsByRoomId,
    fixLifecyclesByRoomId,
    isAiConfigured,
  });

  const handleWalkthroughAction = (actionId: NonNullable<WalkthroughStep['actionId']>) => {
    switch (actionId) {
      case 'prefill_demo':
        setExternalRepoUrl('https://github.com/sakshamgupta005/patchboard-tasks-api');
        break;
      case 'select_room':
        if (rooms.length > 0) {
          handleSelectRoom(rooms[0]);
        }
        break;
      case 'focus_blocked_room': {
        const blocked = rooms.find(
          (r) => r.status === 'blocked' || r.metrics?.ciStatus === 'failing'
        );
        if (blocked) {
          setSelectedRoom(blocked);
        } else if (rooms.length > 0) {
          setSelectedRoom(rooms[0]);
        }
        break;
      }
      case 'ask_chat': {
        const targetRoom = selectedRoom || rooms[0];
        if (targetRoom) {
          const queryText = `Tell me about ${targetRoom.name}: what verification evidence exists and what is failing?`;
          const newMsg: ChatMessageItem = {
            id: `user-walkthrough-${Date.now()}`,
            sender: 'user',
            text: queryText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          handleChatMessagesChange([...chatMessages, newMsg]);
        }
        break;
      }
      case 'investigate':
      case 'open_fix_report':
        break;
    }
  };

  const handleSelectRoom = (room: ArchitecturalRoom) => {
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

  const currentSourceName = isSampleActive
    ? SAMPLE_PROJECT.name
    : `${lastScanResult?.owner}/${lastScanResult?.repo}`;

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

          {/* Compact Guided Demonstration Walkthrough */}
          <GuidedWalkthrough
            evaluation={walkthroughEvaluation}
            isOpen={isWalkthroughOpen}
            onToggleOpen={() => setIsWalkthroughOpen(!isWalkthroughOpen)}
            onAction={handleWalkthroughAction}
          />

          <div className="svg-canvas-wrapper">
            <IsometricHouse
              rooms={rooms}
              selectedRoomId={selectedRoom?.id ?? null}
              onSelectRoom={handleSelectRoom}
              foundationTechnologies={
                isSampleActive
                  ? ['PostgreSQL', 'Docker']
                  : (lastScanResult?.detectedTechnologies || [])
              }
            />

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
            />
          </div>
        </section>

        {/* Right side: Persistent Chat Panel */}
        <ChatPanel
          selectedRoom={selectedRoom}
          scanResult={lastScanResult}
          isSampleActive={isSampleActive}
          rooms={rooms}
          initialMessages={chatMessages}
          investigationFindings={findingsByRoomId}
          onMessagesChange={handleChatMessagesChange}
          onSelectRoom={(roomId) => {
            const targetRoom = rooms.find((r) => r.id === roomId);
            if (targetRoom) {
              handleSelectRoom(targetRoom);
            }
          }}
        />
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
