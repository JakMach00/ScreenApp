import { useEffect, useRef, useState } from 'react';
import type { Rect } from '../types';

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  hint: string;
  onSelect: (rect: Rect) => void;
  onCancel: () => void;
}

interface DragState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export default function RegionSelector({
  imageUrl,
  imageWidth,
  imageHeight,
  hint,
  onSelect,
  onCancel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const localPoint = (event: React.MouseEvent) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(0, event.clientX - box.left), box.width),
      y: Math.min(Math.max(0, event.clientY - box.top), box.height),
    };
  };

  const scale = () => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 1;
    return imageWidth / box.width;
  };

  const norm = (d: DragState) => ({
    left: Math.min(d.x0, d.x1),
    top: Math.min(d.y0, d.y1),
    width: Math.abs(d.x1 - d.x0),
    height: Math.abs(d.y1 - d.y0),
  });

  const handleDown = (event: React.MouseEvent) => {
    const p = localPoint(event);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const handleMove = (event: React.MouseEvent) => {
    if (!drag) return;
    const p = localPoint(event);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };

  const handleUp = () => {
    if (!drag) return;
    const box = norm(drag);
    const k = scale();
    setDrag(null);
    if (box.width < 6 || box.height < 6) return;
    onSelect({
      x: Math.round(box.left * k),
      y: Math.round(box.top * k),
      w: Math.round(box.width * k),
      h: Math.round(box.height * k),
    });
  };

  const box = drag ? norm(drag) : null;
  const k = scale();

  return (
    <div className="modal">
      <div className="modal-bar">
        <span>{hint}</span>
        <span className="spacer" />
        {box ? (
          <span className="mono">
            {Math.round(box.width * k)} x {Math.round(box.height * k)} px
          </span>
        ) : null}
        <button onClick={onCancel}>Cancel (Esc)</button>
      </div>
      <div className="modal-body">
        <div
          ref={wrapRef}
          className="region-wrap"
          onMouseDown={handleDown}
          onMouseMove={handleMove}
          onMouseUp={handleUp}
        >
          <img src={imageUrl} alt="" draggable={false} style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }} />
          {box ? (
            <div
              className="region-box"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
