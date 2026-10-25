import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogEvent, LogLevel, LogTemplate } from '../../domain/resilience/types.ts';
import './LogStream.css';

interface LogStreamProps {
  logs: LogEvent[];
  templates: LogTemplate[];
  selectedRoomId?: string | null;
  selectedRoomName?: string | null;
  /** Accepted for compatibility; the Lines view filters to the focused service only. */
  focusedRelatedIds?: string[] | null;
}

const ROW_HEIGHT = 20;
const OVERSCAN = 8;
const STICK_THRESHOLD = 24;

const isProblem = (level: LogLevel) => level !== 'INFO';

const TemplateText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split('<*>');
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && <span className="ls-wild">{'<*>'}</span>}
        </React.Fragment>
      ))}
    </>
  );
};

export const LogStream: React.FC<LogStreamProps> = ({
  logs,
  templates,
  selectedRoomId,
  selectedRoomName,
}) => {
  const [viewMode, setViewMode] = useState<'lines' | 'patterns'>('lines');
  const [showInfo, setShowInfo] = useState(false);
  const [serviceFilterCleared, setServiceFilterCleared] = useState(false);
  const [templateFilter, setTemplateFilter] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(240);
  const [newCount, setNewCount] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const prevLastIdRef = useRef<string | null>(null);

  // A newly focused service re-enables its filter chip.
  useEffect(() => {
    setServiceFilterCleared(false);
  }, [selectedRoomId]);

  const serviceFilter = selectedRoomId && !serviceFilterCleared ? selectedRoomId : null;
  const activeTemplate = templateFilter ? templates.find((t) => t.id === templateFilter) : undefined;

  const displayedLogs = useMemo(
    () =>
      logs.filter((l) => {
        if (serviceFilter && l.serviceId !== serviceFilter) return false;
        if (templateFilter) return l.templateId === templateFilter;
        return showInfo || isProblem(l.level);
      }),
    [logs, serviceFilter, templateFilter, showInfo],
  );

  const problemCount = useMemo(() => logs.filter((l) => isProblem(l.level)).length, [logs]);
  const newPatternCount = useMemo(() => templates.filter((t) => t.isNew).length, [templates]);
  const hiddenInfoCount = useMemo(
    () =>
      showInfo || templateFilter
        ? 0
        : logs.filter((l) => l.level === 'INFO' && (!serviceFilter || l.serviceId === serviceFilter))
            .length,
    [logs, showInfo, templateFilter, serviceFilter],
  );

  const sortedTemplates = useMemo(
    () =>
      [...templates].sort((a, b) => {
        const pa = isProblem(a.level) ? 1 : 0;
        const pb = isProblem(b.level) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return b.lastSeenTick - a.lastSeenTick;
      }),
    [templates],
  );

  // Filter changes jump back to the newest line (runs before the stick effect below).
  useLayoutEffect(() => {
    stickRef.current = true;
  }, [serviceFilter, templateFilter, showInfo, viewMode]);

  // Stick to bottom on new lines unless the user scrolled up; then count unseen lines.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const lastId = displayedLogs.length ? displayedLogs[displayedLogs.length - 1].id : null;
    const prevLastId = prevLastIdRef.current;
    prevLastIdRef.current = lastId;
    if (viewMode !== 'lines' || !el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
      setNewCount(0);
    } else if (lastId !== prevLastId && prevLastId !== null) {
      const prevIdx = displayedLogs.findIndex((l) => l.id === prevLastId);
      const added = prevIdx >= 0 ? displayedLogs.length - 1 - prevIdx : displayedLogs.length;
      if (added > 0) setNewCount((c) => c + added);
    }
  }, [displayedLogs, viewMode]);

  // Track viewport height for windowing.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [viewMode]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    setScrollTop(t.scrollTop);
    const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < STICK_THRESHOLD;
    stickRef.current = atBottom;
    if (atBottom) setNewCount(0);
  };

  const scrollToBottom = () => {
    const el = viewportRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setNewCount(0);
  };

  const pickTemplate = (id: string) => {
    setTemplateFilter(id);
    setViewMode('lines');
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    displayedLogs.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = displayedLogs.slice(start, end);

  return (
    <div className="panel-card ls-card">
      <div className="ls-header">
        <div className="ls-header-text">
          <span className="ls-title">Logs</span>
          <span className="ls-subtitle">Simulated server logs, mined for repeating problem patterns</span>
          <span className="ls-summary">
            <span className={problemCount ? 'ls-sum-warn' : undefined}>
              {problemCount} warnings/errors
            </span>
            {' · '}
            <span className={newPatternCount ? 'ls-sum-new' : undefined}>
              {newPatternCount} new pattern{newPatternCount === 1 ? '' : 's'}
            </span>{' '}
            in the last 10 ticks
          </span>
        </div>
        <div className="ls-tabs" role="group" aria-label="Log view">
          <button
            type="button"
            className="ls-btn"
            aria-pressed={viewMode === 'lines'}
            onClick={() => setViewMode('lines')}
          >
            Lines
          </button>
          <button
            type="button"
            className="ls-btn"
            aria-pressed={viewMode === 'patterns'}
            onClick={() => setViewMode('patterns')}
          >
            Patterns ({templates.length})
          </button>
        </div>
      </div>

      {viewMode === 'lines' ? (
        <>
          <div className="ls-toolbar">
            <button
              type="button"
              className="ls-btn"
              aria-pressed={showInfo}
              onClick={() => setShowInfo((v) => !v)}
              disabled={!!templateFilter}
            >
              Show routine INFO{hiddenInfoCount ? ` (${hiddenInfoCount} hidden)` : ''}
            </button>
            {serviceFilter && (
              <span className="ls-chip">
                Only {selectedRoomName || serviceFilter}
                <button
                  type="button"
                  className="ls-chip-x"
                  aria-label={`Clear filter: ${selectedRoomName || serviceFilter}`}
                  onClick={() => setServiceFilterCleared(true)}
                >
                  ×
                </button>
              </span>
            )}
            {templateFilter && (
              <span className="ls-chip" title={activeTemplate?.template}>
                Pattern {templateFilter}
                <button
                  type="button"
                  className="ls-chip-x"
                  aria-label="Clear pattern filter"
                  onClick={() => setTemplateFilter(null)}
                >
                  ×
                </button>
              </span>
            )}
          </div>

          <div className="ls-body">
            <div
              ref={viewportRef}
              className="ls-viewport"
              onScroll={handleScroll}
              aria-live="off"
              role="log"
              aria-label="Log lines"
            >
              {displayedLogs.length === 0 ? (
                <div className="ls-empty">
                  {logs.length === 0
                    ? 'No logs yet.'
                    : 'No warnings or errors match. Turn on “Show routine INFO” to see everything.'}
                </div>
              ) : (
                <div style={{ height: displayedLogs.length * ROW_HEIGHT, position: 'relative' }}>
                  {visible.map((log, i) => (
                    <div
                      key={log.id}
                      className={`ls-row ls-row-${log.level}`}
                      style={{ top: (start + i) * ROW_HEIGHT }}
                      title={log.message}
                    >
                      <span className="ls-tick">t{log.tick}</span>
                      <span className={`ls-level ls-level-${log.level}`}>{log.level}</span>
                      <span className="ls-svc">{log.serviceId}</span>
                      <span className="ls-msg">{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {newCount > 0 && (
              <button type="button" className="ls-jump" onClick={scrollToBottom}>
                ↓ {newCount} new
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="ls-body">
          <div className="ls-viewport ls-patterns">
            <p className="ls-explain">
              Similar log lines grouped into patterns; variable parts like IDs and timings become{' '}
              <span className="ls-wild">{'<*>'}</span>. Click a pattern to see its lines.
            </p>
            {sortedTemplates.length === 0 && <div className="ls-empty">No patterns mined yet.</div>}
            {sortedTemplates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`ls-pattern ls-row-${tpl.level}`}
                onClick={() => pickTemplate(tpl.id)}
                title={`${tpl.template}\nServices: ${tpl.serviceIds.join(', ')}`}
              >
                <span className="ls-pattern-top">
                  <span className={`ls-level ls-level-${tpl.level}`}>{tpl.level}</span>
                  {tpl.isNew && <span className="ls-new">NEW</span>}
                  <span className="ls-pattern-text">
                    <TemplateText text={tpl.template} />
                  </span>
                </span>
                <span className="ls-pattern-meta">
                  <span>×{tpl.count}</span>
                  <span className="ls-pattern-svcs">{tpl.serviceIds.join(', ')}</span>
                  <span>first t{tpl.firstSeenTick}</span>
                  <span>last t{tpl.lastSeenTick}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
