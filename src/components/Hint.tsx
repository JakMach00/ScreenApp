import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  text: string;
  /** Keeps the icon in the flow instead of overlaying the top right corner. */
  inline?: boolean;
  children: ReactNode;
}

const DELAY_MS = 1000;
const TIP_WIDTH = 260;
const TIP_GAP = 12;

/**
 * Explains a control on hover, after a short pause so the tooltip stays out of
 * the way while the pointer is only crossing the panel. The info icon makes it
 * discoverable, and focusing that icon shows the same text without a mouse.
 */
export default function Hint({ text, inline, children }: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const place = () => {
    const box = anchorRef.current?.getBoundingClientRect();
    if (!box) return;
    const overflowsRight = box.right + TIP_WIDTH + TIP_GAP * 2 > window.innerWidth;
    setPosition({
      top: Math.max(8, Math.min(box.top + box.height / 2 - 30, window.innerHeight - 140)),
      left: overflowsRight ? Math.max(8, box.left - TIP_WIDTH - TIP_GAP) : box.right + TIP_GAP,
    });
  };

  const scheduleShow = () => {
    if (position || timerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      place();
    }, DELAY_MS);
  };

  const hide = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    setPosition(null);
  };

  const handleOut = (event: React.MouseEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && anchorRef.current && anchorRef.current.contains(next)) return;
    hide();
  };

  return (
    <div
      ref={anchorRef}
      className={inline ? 'hint-anchor inline' : 'hint-anchor'}
      onMouseOver={scheduleShow}
      onMouseOut={handleOut}
    >
      <div className="hint-body">{children}</div>
      <span
        className="hint-icon"
        role="button"
        tabIndex={0}
        aria-label="What this option does"
        onFocus={place}
        onBlur={hide}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
          <rect x="7.2" y="6.9" width="1.6" height="5" rx="0.6" fill="currentColor" />
        </svg>
      </span>
      {position
        ? createPortal(
            <div className="tip" style={{ top: position.top, left: position.left }}>
              {text}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
