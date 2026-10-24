import React, { useState, useRef, useEffect } from 'react';
import { PixelPetAvatar } from './PixelPetAvatar.tsx';
import { WorkflowDiagramView } from './WorkflowDiagramView.tsx';
import { AiUsageLimitNotice } from './AiUsageLimitNotice.tsx';
import type { ArchitecturalRoom } from '../types.ts';
import type { RoomInvestigationFinding } from '../domain/investigation/types.ts';
import type {
  ChatApiResponse,
  CompanionReplyMessage,
  CompanionSpeaker,
  ExecutionTimingMetadata,
  ExplanationLevel,
  WorkflowDiagram,
  AiErrorInfo,
} from '../server/types.ts';
import { scopeRepoContext } from '../server/contextBuilder.ts';
import type { GitHubScanResult } from '../domain/github/types.ts';

export interface ChatMessageItem {
  id: string;
  sender: 'user' | CompanionSpeaker;
  text: string;
  timestamp: string;
  evidenceReference?: string;
  timing?: ExecutionTimingMetadata;
  workflowDiagram?: WorkflowDiagram;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  suggestedFollowUps?: string[];
  cached?: boolean;
}

export interface ChatPanelProps {
  selectedRoom: ArchitecturalRoom | null;
  scanResult: GitHubScanResult | null;
  isSampleActive: boolean;
  rooms: ArchitecturalRoom[];
  initialMessages?: ChatMessageItem[];
  investigationFindings?: Record<string, RoomInvestigationFinding>;
  onMessagesChange?: (messages: ChatMessageItem[]) => void;
  onSelectRoom?: (roomId: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  selectedRoom,
  scanResult,
  isSampleActive,
  rooms,
  initialMessages,
  investigationFindings,
  onMessagesChange,
  onSelectRoom,
}) => {
  const [messages, setMessages] = useState<ChatMessageItem[]>(() => {
    if (initialMessages && initialMessages.length > 0) {
      return initialMessages;
    }
    return [
      {
        id: 'init-dog',
        sender: 'dog',
        text: "Hi! I'm Barkley. I'm here to explain how this project works in simple, friendly terms with analogies—no overwhelming code jargon!",
        timestamp: 'Ready',
      },
      {
        id: 'init-cat',
        sender: 'cat',
        text: "And I'm Cleo. I review the claims against actual source files, verified code facts, and CI check runs.",
        timestamp: 'Ready',
      },
    ];
  });

  const currentProjectKey = isSampleActive
    ? 'sample:booknook-demo'
    : `${scanResult?.owner}/${scanResult?.repo}@${scanResult?.commitSha ? scanResult.commitSha.slice(0, 7) : 'latest'}`;
  const prevProjectKeyRef = useRef(currentProjectKey);
  const [activeTypingSpeaker, setActiveTypingSpeaker] = useState<CompanionSpeaker | null>(null);
  const revealCancelledRef = useRef(false);

  useEffect(() => {
    if (prevProjectKeyRef.current !== currentProjectKey) {
      prevProjectKeyRef.current = currentProjectKey;
      revealCancelledRef.current = true;
      setActiveTypingSpeaker(null);
      if (initialMessages && initialMessages.length > 0) {
        setMessages(initialMessages);
      } else {
        const resetMessages: ChatMessageItem[] = [
          {
            id: `reset-dog-${Date.now()}`,
            sender: 'dog',
            text: isSampleActive
              ? "Switched to sample BookNook repository. Previous conversation cleared. Let's explore its architecture together!"
              : `Switched project to ${currentProjectKey}. Previous conversation cleared. Ask me anything about how this codebase is structured!`,
            timestamp: 'Reset',
          },
          {
            id: `reset-cat-${Date.now()}`,
            sender: 'cat',
            text: isSampleActive
              ? "Showing sample architecture. All claims will be matched against sample data."
              : `Project ${currentProjectKey} loaded. I will only accept real files and verified evidence from this scan.`,
            timestamp: 'Reset',
          },
        ];
        setMessages(resetMessages);
        onMessagesChange?.(resetMessages);
      }
      chatAbortControllerRef.current?.abort();
      setErrorMessage(null);
      setErrorInfo(null);
      setSetupRequired(false);
    }
  }, [currentProjectKey, isSampleActive, initialMessages, onMessagesChange]);

  const updateAndNotifyMessages = (newMsgs: ChatMessageItem[]) => {
    setMessages(newMsgs);
    onMessagesChange?.(newMsgs);
  };

  const [explanationLevel, setExplanationLevel] = useState<ExplanationLevel>('beginner');
  const [inputVal, setInputVal] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progressStage, setProgressStage] = useState<string>('');
  const [setupRequired, setSetupRequired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<AiErrorInfo | null>(null);
  const [showHelpModal, setShowHelpModal] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<unknown>(null);

  const handleToggleVoiceInput = () => {
    if (isListening) {
      if (recognitionRef.current) {
        try {
          (recognitionRef.current as { stop: () => void }).stop();
        } catch {
          // ignore
        }
      }
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: new () => any }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setErrorMessage('Speech recognition is not supported in this browser. Please type your message.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: { resultIndex: number; results: Array<Array<{ transcript: string }>> }) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript) {
          setInputVal((prev) => {
            const trimmedPrev = prev.trim();
            return trimmedPrev ? `${trimmedPrev} ${transcript}` : transcript;
          });
        }
      };

      recognition.onerror = (event: { error: string }) => {
        setIsListening(false);
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setErrorMessage(`Voice input error: ${event.error || 'microphone unavailable'}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: unknown) {
      setIsListening(false);
      const msg = err instanceof Error ? err.message : 'Microphone error';
      setErrorMessage(`Could not start voice input: ${msg}`);
    }
  };

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          (recognitionRef.current as { abort: () => void }).abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceToBottom < 80;
  };

  // Abort any in-flight request when component unmounts
  useEffect(() => {
    return () => {
      chatAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, activeTypingSpeaker]);

  // Generate adaptive contextual suggestion chips
  const suggestionChips: Array<{ label: string; query: string }> = [];

  if (selectedRoom) {
    suggestionChips.push({
      label: `Explain how ${selectedRoom.name} works`,
      query: `Explain how ${selectedRoom.name} works: what are its primary responsibilities and patterns?`,
    });
    suggestionChips.push({
      label: `What happens when a user sends a request?`,
      query: `What happens when a user sends a request to ${selectedRoom.name}? Trace the path step by step.`,
    });
    suggestionChips.push({
      label: `Why does this module depend on that one?`,
      query: `Why does ${selectedRoom.name} depend on other modules? Explain the coupling and separation of concerns.`,
    });
    suggestionChips.push({
      label: `Explain functions step by step`,
      query: `Explain the key functions in ${selectedRoom.name} step by step based on the inspected code.`,
    });
    suggestionChips.push({
      label: `What happens if this component fails?`,
      query: `What happens if ${selectedRoom.name} fails or throws an unhandled error? What is the blast radius?`,
    });
    suggestionChips.push({
      label: `Show me a workflow diagram`,
      query: `Show me a workflow diagram of ${selectedRoom.name}.`,
    });
  } else {
    suggestionChips.push({
      label: `Explain how this project works`,
      query: `Explain how this project works. How does the architecture hang together across layers?`,
    });
    suggestionChips.push({
      label: `What happens when a user sends a request?`,
      query: `What happens when a user sends a request? Trace the flow step by step from client to storage.`,
    });
    suggestionChips.push({
      label: `Why does this module depend on that one?`,
      query: `Why does this module depend on that one? Explain the coupling and architectural boundaries.`,
    });
    suggestionChips.push({
      label: `Explain this function step by step`,
      query: `Explain the main entry point and core function step by step from the inspected source files.`,
    });
    suggestionChips.push({
      label: `What happens if this component fails?`,
      query: `What happens if a core component fails or encounters an unhandled exception?`,
    });
    suggestionChips.push({
      label: `What can this application actually do?`,
      query: `What can this application actually do, and what are its current architectural limitations?`,
    });
    suggestionChips.push({
      label: `Show me a workflow diagram`,
      query: `Show me a workflow diagram of the main request and data flow.`,
    });
  }

  suggestionChips.push({
    label: `💡 What can you help me understand?`,
    query: `What can you help me understand about this codebase and The Living Blueprint?`,
  });

  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const isSendingRef = useRef(false);

  const handleSendMessage = async (textToSend: string, isRetry = false) => {
    const trimmed = textToSend.trim();
    if (!trimmed || isLoading || isSendingRef.current) return;

    // Prevent duplicate send during rapid clicks and abort any active in-flight request
    isSendingRef.current = true;
    chatAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    chatAbortControllerRef.current = abortController;

    let newMessages = messages;
    let currentMessageId = '';

    if (!isRetry) {
      currentMessageId = `user-${Date.now()}`;
      const userMessageItem: ChatMessageItem = {
        id: currentMessageId,
        sender: 'user',
        text: trimmed,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      newMessages = [...messages, userMessageItem];
      updateAndNotifyMessages(newMessages);
      setInputVal('');
    } else {
      currentMessageId = messages[messages.length - 1]?.id || '';
    }

    setIsLoading(true);
    setProgressStage('Preparing repository evidence & context...');
    setErrorMessage(null);
    setErrorInfo(null);
    const requestProjectKey = currentProjectKey;

    const stageTimer1 = setTimeout(() => {
      setProgressStage('Consulting Barkley & Cleo (waiting for verified response)...');
    }, 450);
    const stageTimer2 = setTimeout(() => {
      setProgressStage('Validating evidence and structured schema...');
    }, 4500);

    revealCancelledRef.current = false;
    setActiveTypingSpeaker('dog');

    // Build context payload from current scan / sample state
    const rawRepoContext = !isSampleActive && scanResult
      ? {
          owner: scanResult.owner,
          repo: scanResult.repo,
          branch: scanResult.metadata?.defaultBranch || 'main',
          commitSha: scanResult.commitSha,
          totalFiles: scanResult.totalFilesDiscovered,
          inspectedFiles: scanResult.inspectedFiles.map((f) => ({
            path: f.path,
            category: f.category,
            contentExcerpt: f.contentExcerpt,
            sizeBytes: f.sizeBytes,
          })),
          discoveredFilePaths: scanResult.discoveredFilePaths || scanResult.inspectedFiles.map((f) => f.path),
          detectedTechnologies: scanResult.detectedTechnologies,
          dependencies: selectedRoom?.dependencies,
          investigationFindings,
          roomSummaries: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            layer: r.layer,
            status: r.status,
            evidence: r.evidence,
            filePaths: r.filePaths,
            ciStatus: r.metrics?.ciStatus,
            ciCheckName: r.metrics?.ciCheckName,
          })),
          ciEvaluation: scanResult.ciEvaluation
            ? {
                status:
                  scanResult.ciEvaluation.outcome === 'failed'
                    ? 'failing'
                    : scanResult.ciEvaluation.outcome === 'verified'
                    ? 'passing'
                    : 'inconclusive',
                isVerified: scanResult.ciEvaluation.outcome === 'verified',
                reason: scanResult.ciEvaluation.outcomeReason,
                checkRunsCount: scanResult.ciEvaluation.relevantTestChecks.length,
                failedChecks: scanResult.ciEvaluation.relevantTestChecks
                  .filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
                  .map((c) => c.name),
              }
            : undefined,
        }
      : undefined;

    const repoContext = rawRepoContext
      ? scopeRepoContext(rawRepoContext, {
          selectedRoomId: selectedRoom?.id,
          selectedRoomFilePaths: selectedRoom?.filePaths,
          dependencies: selectedRoom?.dependencies,
        })
      : isSampleActive
      ? {
          owner: 'example',
          repo: 'booknook-demo',
          branch: 'main',
          totalFiles: 42,
          inspectedFiles: [
            {
              path: 'src/auth/jwt.ts',
              category: 'source',
              contentExcerpt: 'export function signToken(user: User): string { ... }',
            },
            {
              path: 'src/catalog/books.ts',
              category: 'source',
              contentExcerpt: 'export const getBooks = () => { return []; }',
            },
            {
              path: 'tests/auth.test.ts',
              category: 'test',
              contentExcerpt: 'describe("JWT authentication", () => { ... })',
            },
          ],
          discoveredFilePaths: ['src/auth/jwt.ts', 'src/catalog/books.ts', 'tests/auth.test.ts'],
          detectedTechnologies: ['TypeScript', 'React', 'PostgreSQL', 'Docker'],
          investigationFindings,
          roomSummaries: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            layer: r.layer,
            status: r.status,
            evidence: r.evidence,
            filePaths: r.filePaths,
            ciStatus: r.metrics?.ciStatus,
            ciCheckName: r.metrics?.ciCheckName,
          })),
        }
      : undefined;

    // Format bounded history
    const historyPayload = newMessages
      .slice(-6)
      .filter((m) => m.id !== currentMessageId)
      .map((m) => ({
        role: m.sender === 'user' ? ('user' as const) : ('assistant' as const),
        text: m.text,
        speaker: m.sender !== 'user' ? m.sender : undefined,
      }));

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          message: trimmed,
          explanationLevel,
          history: historyPayload,
          selectedRoomId: selectedRoom?.id,
          repoContext,
          investigationFindings,
          bypassCache: isRetry,
        }),
      });

      if (revealCancelledRef.current || prevProjectKeyRef.current !== requestProjectKey) {
        return;
      }

      const data: ChatApiResponse = await response.json();
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);

      if (revealCancelledRef.current || prevProjectKeyRef.current !== requestProjectKey) {
        return;
      }

      if (!response.ok || !data.success) {
        setActiveTypingSpeaker(null);
        if (data.code === 'CONFIG_REQUIRED') {
          setSetupRequired(true);
        } else {
          setErrorMessage(data.error || 'Failed to communicate with AI provider.');
          setErrorInfo(data.errorInfo || null);
          setFailedMessage(trimmed);
        }
        return;
      }

      // Model returned valid replies in single response (dog, dog?, cat, dog...)
      const companionReplies: CompanionReplyMessage[] =
        data.replies && data.replies.length > 0
          ? data.replies
          : data.reply
          ? [data.reply]
          : [];

      if (companionReplies.length === 0) {
        setActiveTypingSpeaker(null);
        return;
      }

      let currentAccumulated = [...newMessages];

      // Progressive conversational reveal with character thinking animations & natural delays
      for (let i = 0; i < companionReplies.length; i++) {
        if (revealCancelledRef.current || prevProjectKeyRef.current !== requestProjectKey) {
          return;
        }

        const reply = companionReplies[i];

        // Trigger thinking animation for this specific speaker
        setActiveTypingSpeaker(reply.speaker);
        if (reply.speaker === 'cat') {
          setProgressStage('Cleo is analyzing technical facts...');
        } else if (i > 0 && companionReplies[i - 1].speaker === 'cat') {
          setProgressStage('Barkley is explaining what Cleo pointed out...');
        } else if (i > 0) {
          setProgressStage('Barkley is continuing thoughts...');
        } else {
          setProgressStage('Barkley is explaining...');
        }

        // Pacing delay: for reply 0 dog was already thinking during fetch (brief 350ms breather);
        // for subsequent replies (or dog continuing / cat joining / dog explaining), brief natural human pause (650ms-850ms)
        const delay = i === 0 ? 350 : Math.min(850, Math.max(650, reply.text.length * 3));
        await new Promise((res) => setTimeout(res, delay));

        if (revealCancelledRef.current || prevProjectKeyRef.current !== requestProjectKey) {
          return;
        }

        const isLastReply = i === companionReplies.length - 1;
        const item: ChatMessageItem = {
          id: `reply-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          sender: reply.speaker,
          text: reply.text,
          evidenceReference: reply.speaker === 'cat' ? reply.evidenceReference : undefined,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timing: isLastReply ? data.timing : undefined,
          workflowDiagram: reply.workflowDiagram || (i === 0 ? data.workflowDiagram : undefined),
          providerUsed: data.providerUsed,
          suggestedFollowUps: isLastReply
            ? reply.suggestedFollowUps || companionReplies[0].suggestedFollowUps
            : reply.suggestedFollowUps,
          cached: Boolean(data.cached || data.timing?.cached),
        };

        currentAccumulated = [...currentAccumulated, item];
        updateAndNotifyMessages(currentAccumulated);

        // Transition typing speaker for the next turn
        if (!isLastReply) {
          const nextSpeaker = companionReplies[i + 1].speaker;
          setActiveTypingSpeaker(nextSpeaker);
        }
      }

      setActiveTypingSpeaker(null);
      setProgressStage('');
      setFailedMessage(null);
      setErrorInfo(null);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (prevProjectKeyRef.current !== requestProjectKey || revealCancelledRef.current) {
        return;
      }
      setActiveTypingSpeaker(null);
      const msg = err instanceof Error ? err.message : 'Network failure';
      setErrorMessage(`Request failed: ${msg}. You can retry.`);
      setErrorInfo({
        kind: 'network_error',
        title: 'Network connection issue',
        message: 'Unable to reach the AI provider network. Please check your internet connection.',
        retryable: true,
        proHint: false,
      });
      setFailedMessage(trimmed);
    } finally {
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      setProgressStage('');
      setActiveTypingSpeaker(null);
      setIsLoading(false);
      isSendingRef.current = false;
    }
  };

  const handleStopGenerating = () => {
    revealCancelledRef.current = true;
    chatAbortControllerRef.current?.abort();
    setActiveTypingSpeaker(null);
    setIsLoading(false);
    isSendingRef.current = false;
    if (isListening && recognitionRef.current) {
      try {
        (recognitionRef.current as { stop: () => void }).stop();
      } catch {
        // ignore
      }
      setIsListening(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(inputVal);
    }
  };

  const handleClearChat = () => {
    revealCancelledRef.current = true;
    chatAbortControllerRef.current?.abort();
    setActiveTypingSpeaker(null);
    setIsLoading(false);
    isSendingRef.current = false;
    if (isListening && recognitionRef.current) {
      try {
        (recognitionRef.current as { stop: () => void }).stop();
      } catch {
        // ignore
      }
      setIsListening(false);
    }
    setMessages([
      {
        id: 'reset-dog',
        sender: 'dog',
        text: "Clean slate! What part of the architecture should we inspect next?",
        timestamp: 'Ready',
      },
      {
        id: 'reset-cat',
        sender: 'cat',
        text: "Standing by with actual code facts and verification evidence.",
        timestamp: 'Ready',
      },
    ]);
    onMessagesChange?.([]);
    setErrorMessage(null);
    setErrorInfo(null);
  };

  return (
    <aside className="chat-panel-container" aria-label="AI Companions Group Chat">
      {/* Centred header at top of panel */}
      <div className="chat-panel-header">
        <div className="chat-companion-avatars-row">
          <div className="pet-header-avatar">
            <PixelPetAvatar speaker="dog" size={24} />
            <span className="pet-header-name">Barkley</span>
          </div>
          <span className="avatar-divider">&</span>
          <div className="pet-header-avatar">
            <PixelPetAvatar speaker="cat" size={24} />
            <span className="pet-header-name">Cleo</span>
          </div>
        </div>
        <div className="chat-panel-subheading">One model · Two distinct personalities</div>

        {/* Compact explanation level selector */}
        <div className="chat-level-selector" role="radiogroup" aria-label="Explanation level">
          <span className="level-selector-label">Level:</span>
          {(['beginner', 'intermediate', 'technical'] as const).map((lvl) => (
            <button
              key={lvl}
              type="button"
              role="radio"
              aria-checked={explanationLevel === lvl}
              className={`btn-level-chip ${explanationLevel === lvl ? 'active-level' : ''}`}
              onClick={() => setExplanationLevel(lvl)}
              title={`Switch explanation mode to ${lvl}`}
            >
              {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn-help-capabilities"
          onClick={() => setShowHelpModal(true)}
          title="Learn about The Living Blueprint's educational capabilities, architecture, and honest limitations"
        >
          💡 What can you help me understand?
        </button>
      </div>

      {/* Setup notification if API key is not configured */}
      {setupRequired && (
        <div className="chat-setup-banner">
          <strong>AI Provider Key Required</strong>
          <p>
            To activate live companion dialogue, add <code>GEMINI_API_KEY</code> to your{' '}
            <code>.env</code> file on the server.
          </p>
        </div>
      )}

      {/* Quick context chip for selected room */}
      {selectedRoom && (
        <div className="chat-selected-room-bar">
          <span>Focusing on: <strong>{selectedRoom.name}</strong></span>
          <button
            type="button"
            className="btn-ask-room"
            onClick={() =>
              handleSendMessage(
                `Tell me about ${selectedRoom.name}: what evidence exists and what is missing?`
              )
            }
            disabled={isLoading}
          >
            Ask about this room →
          </button>
        </div>
      )}

      {/* Group Chat Messages Scrollable Stream */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="chat-messages-scroll"
        role="log"
        aria-live="polite"
      >
        {messages.map((msg) => {
          if (msg.sender === 'user') {
            return (
              <div key={msg.id} className="user-message-row">
                <div className="user-bubble">
                  <p className="message-body">{msg.text}</p>
                  <span className="user-timestamp">{msg.timestamp}</span>
                </div>
              </div>
            );
          }

          const isDog = msg.sender === 'dog';

          return (
            <div
              key={msg.id}
              className={`companion-group-row ${isDog ? 'companion-dog-row' : 'companion-cat-row'}`}
            >
              <div className="companion-avatar-col">
                <PixelPetAvatar speaker={msg.sender} size={30} />
              </div>
              <div className="companion-bubble-col">
                <div className="companion-bubble-header">
                  <span className="companion-name-label">
                    {isDog ? 'Barkley (Dog)' : 'Cleo (Cat)'}
                  </span>
                  <span className="companion-time-label">{msg.timestamp}</span>
                </div>
                <p className="message-body">{msg.text}</p>
                {msg.evidenceReference && (
                  <div className="evidence-ref-tag">
                    Ref: <code>{msg.evidenceReference}</code>
                  </div>
                )}
                {msg.workflowDiagram && (
                  <WorkflowDiagramView
                    diagram={msg.workflowDiagram}
                    rooms={rooms}
                    codeIndex={scanResult?.codeIndex}
                    onSelectRoom={onSelectRoom}
                  />
                )}
                {msg.suggestedFollowUps && msg.suggestedFollowUps.length > 0 && (
                  <div className="suggested-followups-row">
                    <span className="followups-label">Explore further:</span>
                    <div className="followups-chip-list">
                      {msg.suggestedFollowUps.map((prompt, pIdx) => (
                        <button
                          key={pIdx}
                          type="button"
                          className="btn-followup-chip"
                          onClick={() => handleSendMessage(prompt)}
                          disabled={isLoading}
                          title={`Ask: ${prompt}`}
                        >
                          {prompt} →
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {msg.timing && (
                  <div
                    className="companion-timing-badge"
                    title={`End-to-end: ${msg.timing.totalMs}ms | Provider: ${msg.timing.provider || msg.timing.providerUsed || 'gemini'} (${msg.timing.upstreamMs}ms) | Fallback: ${msg.timing.fallbackMs || 0}ms | Validation: ${msg.timing.validationMs}ms | Context: ${msg.timing.contextPrepMs}ms | Tokens: ${msg.timing.totalTokens ?? 'n/a'}`}
                  >
                    {(msg.timing.fallbackUsed || msg.timing.provider === 'groq' || msg.timing.providerUsed === 'groq' || msg.timing.provider === 'cloudflare' || msg.timing.providerUsed === 'cloudflare') && (
                      <span className="backup-ai-indicator" title={`Generated by ${msg.timing.provider === 'cloudflare' || msg.timing.providerUsed === 'cloudflare' ? 'Cloudflare Workers AI' : 'Groq'} backup AI`}>🛡️ Using backup AI (${msg.timing.provider === 'cloudflare' || msg.timing.providerUsed === 'cloudflare' ? 'Cloudflare' : 'Groq'}) · </span>
                    )}
                    ⚡ {msg.timing.totalMs}ms (model: {msg.timing.upstreamMs}ms{msg.timing.fallbackMs ? `, fallback: ${msg.timing.fallbackMs}ms` : ''})
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Genuine Character-Specific Typing Indicator */}
        {activeTypingSpeaker && (
          <div
            className={`companion-group-row typing-fragment-row ${
              activeTypingSpeaker === 'dog' ? 'companion-dog-row' : 'companion-cat-row'
            }`}
            role="status"
            aria-label={`${activeTypingSpeaker === 'dog' ? 'Barkley' : 'Cleo'} is thinking`}
          >
            <div className="companion-avatar-col">
              <PixelPetAvatar speaker={activeTypingSpeaker} size={30} isTyping />
            </div>
            <div className="companion-bubble-col typing-bubble-col">
              <div className="companion-bubble-header">
                <span className="companion-name-label">
                  {activeTypingSpeaker === 'dog' ? 'Barkley (Dog)' : 'Cleo (Cat)'}
                </span>
                <span className="typing-status-hint">
                  {progressStage || (activeTypingSpeaker === 'dog' ? 'Barkley is explaining...' : 'Cleo is verifying code...')}
                </span>
              </div>
              <div className="character-typing-dots">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error or Rate-Limit Usage Notice */}
      {(errorMessage || errorInfo) && !setupRequired && (
        <AiUsageLimitNotice
          errorInfo={errorInfo}
          errorMessage={errorMessage}
          onRetry={failedMessage ? () => handleSendMessage(failedMessage, true) : undefined}
          onDismiss={() => {
            setErrorMessage(null);
            setErrorInfo(null);
            setFailedMessage(null);
          }}
          isLoading={isLoading}
          onExploreRoom={selectedRoom && onSelectRoom ? () => onSelectRoom(selectedRoom.id) : undefined}
          onViewEvidence={selectedRoom && onSelectRoom ? () => onSelectRoom(selectedRoom.id) : undefined}
          hasSelectedRoom={Boolean(selectedRoom)}
          selectedRoomName={selectedRoom?.name}
          contextType="chat"
        />
      )}

      {/* Interactive Input Footer Area */}
      <div className="chat-input-area">
        {/* Contextual Educational Suggestion Chips */}
        <div className="chat-suggestions-bar" role="group" aria-label="Educational prompt suggestions">
          <span className="suggestions-label">Suggestions:</span>
          <div className="suggestions-scroll">
            {suggestionChips.map((chip, idx) => (
              <button
                key={idx}
                type="button"
                className="btn-suggestion-chip"
                onClick={() => handleSendMessage(chip.query)}
                disabled={isLoading}
                title={chip.query}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          className={`chat-input-box active-chat ${isListening ? 'listening-active' : ''}`}
          placeholder={isListening ? 'Listening to your microphone...' : 'Ask Barkley & Cleo about this codebase... (Enter to send, Shift+Enter for newline)'}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={2}
          aria-label="Ask pet companions about repository architecture"
        />

        <div className="chat-input-actions">
          <div className="chat-input-left-buttons">
            <button
              type="button"
              className="btn-clear-chat"
              onClick={handleClearChat}
              disabled={isLoading || messages.length <= 1}
              title="Clear conversation history"
            >
              Clear chat
            </button>

            <button
              type="button"
              className={`btn-voice-input ${isListening ? 'listening' : ''}`}
              onClick={handleToggleVoiceInput}
              disabled={isLoading}
              title={isListening ? 'Stop listening' : 'Speak your question'}
              aria-label={isListening ? 'Stop listening' : 'Start voice input'}
            >
              {isListening ? '🔴 Stop' : '🎤 Speak'}
            </button>
          </div>

          <span className="chat-input-hint">
            {isListening ? '🎙 Listening... speak now' : 'Enter to send · Shift+Enter newline'}
          </span>

          {isLoading ? (
            <button
              type="button"
              className="btn-stop-generating"
              onClick={handleStopGenerating}
              title="Stop response generation"
            >
              ⏹ Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn-send-active"
              onClick={() => handleSendMessage(inputVal)}
              disabled={!inputVal.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>

      {/* Educational Capabilities & Limitations Modal */}
      {showHelpModal && (
        <div
          className="workflow-modal-backdrop"
          onClick={() => setShowHelpModal(false)}
          role="dialog"
          aria-modal="true"
          aria-label="The Living Blueprint Capabilities and Limitations"
        >
          <div className="workflow-modal-window help-capabilities-modal" onClick={(e) => e.stopPropagation()}>
            <div className="diagram-header-bar">
              <div className="diagram-title-group">
                <span className="diagram-icon">🏛️</span>
                <h4 className="diagram-title">The Living Blueprint — Capabilities & Boundaries</h4>
              </div>
              <button
                type="button"
                className="btn-diagram-expand"
                onClick={() => setShowHelpModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <div className="capabilities-body">
              <section className="cap-section">
                <h5>✅ What The Living Blueprint Does</h5>
                <ul>
                  <li><strong>Repository Ingestion:</strong> Discovers git tree structure, manifests, source, tests, and configuration without modifying your code.</li>
                  <li><strong>Dynamic Isometric House:</strong> Generates a living architectural house model mapping code into Foundation, Storage, Services, API Gateway, Presentation, and CI layers.</li>
                  <li><strong>Deterministic Status Engine:</strong> Computes room statuses (<code>Planned</code>, <code>Implemented</code>, <code>Verified</code>, <code>Blocked</code>, <code>Unknown</code>) strictly from verified evidence.</li>
                  <li><strong>CI Verification & Retest Supersession:</strong> Classifies real GitHub Check Runs and supersedes prior test failures when new runs pass.</li>
                  <li><strong>Room Investigations:</strong> Uses Gemini to inspect excerpts, diagnose defects, and provide copy-ready repair prompts.</li>
                  <li><strong>Static Workflow Walkthroughs:</strong> Simulates step-by-step code-derived data flow through architectural layers for students.</li>
                </ul>
              </section>

              <section className="cap-section limitations-section">
                <h5>⚠️ Constraints & Honest Limitations</h5>
                <ul>
                  <li><strong>Static Source Inspection:</strong> The tool statically inspects file excerpts; it does NOT execute arbitrary remote code or provide a sandbox runner.</li>
                  <li><strong>Bounded File Scope:</strong> To stay fast and avoid rate limits, only architectural files are inspected. Uninspected files are explicitly flagged.</li>
                  <li><strong>Static Simulations:</strong> Workflow diagrams model static code structure and static data flow, NOT live runtime traces.</li>
                  <li><strong>GitHub API Limits:</strong> Public unauthenticated access is subject to GitHub rate limits and tree size constraints.</li>
                  <li><strong>Read-Only Guarantee:</strong> The Living Blueprint never modifies, writes, or pushes commits to your repository.</li>
                  <li><strong>Live AI Credentials:</strong> Live companion dialogue requires a configured <code>GEMINI_API_KEY</code>.</li>
                </ul>
              </section>

              <div className="cap-modal-footer">
                <button
                  type="button"
                  className="btn-ask-companion-help"
                  onClick={() => {
                    setShowHelpModal(false);
                    handleSendMessage("What can you help me understand about this codebase and The Living Blueprint?");
                  }}
                >
                  Ask Barkley & Cleo in Chat →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
