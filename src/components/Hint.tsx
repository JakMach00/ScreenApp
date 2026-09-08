import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  text: string;
  children: ReactNode;
}

const DELAY_MS = 1000;
const TIP_WIDTH = 260;
const TIP_GAP = 12;

/**
 * Explains a control after a deliberate pause. The delay keeps the tooltip out
 * of the way while someone is simply moving the mouse across the sidebar, and
 * the tooltip is rendered in a portal so the scrolling panel cannot clip it.
 */
export default function Hint({ text, children }: Props) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // The anchor uses display: contents so it does not disturb the sidebar
  // layout, which means it generates no box of its own. Bubbling mouseover and
  // mouseout are therefore used rather than enter and leave.
  const handleOver = (event: React.MouseEvent) => {
    if (position || timerRef.current) return;
    // The anchor itself uses display: contents and therefore has no box of its
    // own, so measuring it would return zeros and pin the tooltip to the top
    // left corner. The hovered control is measured instead.
    const hovered = (event.target as HTMLElement | null)?.closest(
      'label, button, select, .field, .check',
    ) as HTMLElement | null;
    const element = hovered ?? (anchorRef.current?.firstElementChild as HTMLElement | null);
    if (!element) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      const overflowsRight = box.right + TIP_WIDTH + TIP_GAP * 2 > window.innerWidth;
      const top = Math.max(
        8,
        Math.min(box.top + box.height / 2 - 28, window.innerHeight - 140),
      );
      setPosition({
        top,
        left: overflowsRight
          ? Math.max(8, box.left - TIP_WIDTH - TIP_GAP)
          : box.right + TIP_GAP,
      });
    }, DELAY_MS);
  };

  const handleOut = (event: React.MouseEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && anchorRef.current && anchorRef.current.contains(next)) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    setPosition(null);
  };

  return (
    <span
      ref={anchorRef}
      className="hint-anchor"
      onMouseOver={handleOver}
      onMouseOut={handleOut}
    >
      {children}
      {position
        ? createPortal(
            <div className="tip" style={{ top: position.top, left: position.left }}>
              {text}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
