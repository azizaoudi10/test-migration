import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface AnchoredPopoverProps {
  /** Class names for the popover panel (e.g. 'term-menu' or 'select-pop'). */
  className: string;
  onClose(): void;
  children: ReactNode;
  /** Click coordinates (context menus). */
  point?: { x: number; y: number };
  /** Element to anchor to (selects); re-measured on scroll/resize. */
  anchorEl?: HTMLElement | null;
  /** Width the panel to the anchor's width (select popovers). */
  matchWidth?: boolean;
  /** Render the full-screen dismiss backdrop (context menus/selects). */
  backdrop?: boolean;
  ariaLabel?: string;
  role?: 'menu' | 'listbox' | 'dialog';
  /** For listbox popovers: the active option id. */
  ariaActiveDescendant?: string;
}

const MARGIN = 8;
const GAP = 4;

/**
 * A portal-rendered popover that never leaves the viewport: it flips above
 * the anchor when there is not enough room below, clamps horizontally, and
 * re-measures on window resize/scroll (including scrolls inside the Settings
 * scrollport, which would otherwise clip an absolutely positioned panel).
 */
export function AnchoredPopover(props: AnchoredPopoverProps): React.JSX.Element {
  const { className, onClose, children, point, anchorEl, matchWidth, backdrop, ariaLabel, role, ariaActiveDescendant } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width?: number } | null>(null);

  useLayoutEffect(() => {
    let raf = 0;
    const place = (): void => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left: number;
      let top: number;
      let width: number | undefined;
      if (anchorEl) {
        const a = anchorEl.getBoundingClientRect();
        width = matchWidth ? a.width : undefined;
        left = a.left;
        const h = rect.height;
        const below = a.bottom + GAP;
        // flip above when the panel would overflow the bottom and there is
        // more room above the anchor
        top = below + h > vh - MARGIN && a.top - h - GAP >= MARGIN ? a.top - h - GAP : below;
      } else if (point) {
        left = point.x;
        top = point.y;
        const h = rect.height;
        const w = rect.width;
        if (left + w > vw - MARGIN) left = Math.max(MARGIN, vw - w - MARGIN);
        if (top + h > vh - MARGIN) top = Math.max(MARGIN, point.y - h);
      } else {
        return;
      }
      if (width !== undefined) {
        if (left + width > vw - MARGIN) left = Math.max(MARGIN, vw - width - MARGIN);
      } else if (left + rect.width > vw - MARGIN) {
        left = Math.max(MARGIN, vw - rect.width - MARGIN);
      }
      if (top < MARGIN) top = MARGIN;
      setPos({ left, top, width });
    };
    const schedule = (): void => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchorEl, point?.x, point?.y, matchWidth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      {backdrop !== false && (
        <div
          className="term-menu-backdrop"
          onMouseDown={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      )}
      <div
        ref={panelRef}
        className={className}
        role={role ?? 'menu'}
        aria-label={ariaLabel}
        aria-activedescendant={ariaActiveDescendant}
        style={{
          left: pos?.left ?? point?.x ?? 0,
          top: pos?.top ?? point?.y ?? 0,
          width: pos?.width,
          visibility: pos === null ? 'hidden' : 'visible',
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
