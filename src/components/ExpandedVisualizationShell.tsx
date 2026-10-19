import React, { useEffect, useRef } from 'react';

export interface ExpandedVisualizationShellProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  badges?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  legend?: React.ReactNode;
  footer?: React.ReactNode;
  triggerRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
}

/**
 * Shared, reusable expanded-visualization shell for all graph and diagram views (T32.1).
 * Provides ~95vw × 92vh layout on desktop, full-screen on mobile, Escape-to-close,
 * keyboard accessibility, focus restoration, and dark-coffee styling.
 */
export const ExpandedVisualizationShell: React.FC<ExpandedVisualizationShellProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  eyebrow = 'EXPANDED ARCHITECTURE & FLOW WORKSPACE',
  badges,
  badge,
  actions,
  legend,
  footer,
  triggerRef,
  children,
  className = '',
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Focus management and body scroll locking
  useEffect(() => {
    if (!isOpen) return;

    // Capture previously focused element to restore later if triggerRef is not provided
    previousActiveElementRef.current = document.activeElement as HTMLElement | null;

    // Prevent background scrolling while expanded view is open
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus close button on open
    const focusTimer = setTimeout(() => {
      if (closeButtonRef.current) {
        closeButtonRef.current.focus();
      } else if (dialogRef.current) {
        dialogRef.current.focus();
      }
    }, 50);

    // Global Escape key listener
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown, true);

      // Restore focus to original trigger or previously focused element
      setTimeout(() => {
        if (triggerRef?.current && typeof triggerRef.current.focus === 'function') {
          triggerRef.current.focus();
        } else if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
          previousActiveElementRef.current.focus();
        }
      }, 30);
    };
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return (
    <div
      className="expanded-graph-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={`expanded-graph-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {/* Header Bar */}
        <div className="expanded-graph-header">
          <div className="expanded-graph-header-left">
            {eyebrow && <span className="expanded-graph-eyebrow">{eyebrow}</span>}
            <div className="expanded-graph-title-row">
              <h2 className="expanded-graph-title">{title}</h2>
              {(badges || badge) && (
                <div className="expanded-graph-badges">
                  {badges || (typeof badge === 'string' ? <span className="expanded-header-badge">{badge}</span> : badge)}
                </div>
              )}
            </div>
            {subtitle && <p className="expanded-graph-subtitle">{subtitle}</p>}
          </div>

          <div className="expanded-graph-header-right">
            {actions && <div className="expanded-graph-actions">{actions}</div>}
            <button
              ref={closeButtonRef}
              type="button"
              className="btn-close-expanded-graph"
              onClick={onClose}
              title="Close expanded view (Esc)"
              aria-label="Close expanded view"
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Optional Secondary Legend Bar */}
        {legend && <div className="expanded-graph-legend-bar">{legend}</div>}

        {/* Dedicated Main Graph Content Surface */}
        <div className="expanded-graph-body">{children}</div>

        {/* Optional Footer Bar */}
        {footer && <div className="expanded-graph-footer">{footer}</div>}
      </div>
    </div>
  );
};
