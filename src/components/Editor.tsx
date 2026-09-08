import { useCallback, useEffect, useRef, useState } from 'react';
import { canvasToBlob, loadImage, makeThumb, uid } from '../lib/capture';
import type { Annotation, ShapeAnnotation, ShapeType, Shot, ToolId } from '../types';

interface Props {
  shot: Shot;
  index: number;
  total: number;
  onSave: (blob: Blob, thumbUrl: string) => void;
  onClose: () => void;
  onNavigate: (delta: number) => void;
}

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];
const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'rect', label: 'Box' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'step', label: 'Step' },
  { id: 'text', label: 'Text' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'redact', label: 'Redact' },
];

/** Handle radius in screen pixels, converted to image pixels when hit tested. */
const HANDLE_SCREEN_RADIUS = 6;

type PendingNav = { kind: 'nav'; delta: number } | { kind: 'close' } | null;

function isShape(a: Annotation): a is ShapeAnnotation {
  return a.type !== 'step' && a.type !== 'text';
}

function textFontSize(width: number): number {
  return Math.round(width * 7 + 12);
}

function stepRadius(width: number): number {
  return Math.round(width * 4 + 12);
}

/** Points the user can grab to reshape an annotation. */
function handlePoints(a: Annotation): { id: string; x: number; y: number }[] {
  if (!isShape(a)) return [];
  if (a.type === 'arrow') {
    return [
      { id: 'p1', x: a.x1, y: a.y1 },
      { id: 'p2', x: a.x2, y: a.y2 },
    ];
  }
  return [
    { id: 'x1y1', x: a.x1, y: a.y1 },
    { id: 'x2y1', x: a.x2, y: a.y1 },
    { id: 'x1y2', x: a.x1, y: a.y2 },
    { id: 'x2y2', x: a.x2, y: a.y2 },
  ];
}

function moveHandle(a: ShapeAnnotation, id: string, p: { x: number; y: number }): ShapeAnnotation {
  switch (id) {
    case 'p1':
    case 'x1y1':
      return { ...a, x1: p.x, y1: p.y };
    case 'p2':
    case 'x2y2':
      return { ...a, x2: p.x, y2: p.y };
    case 'x2y1':
      return { ...a, x2: p.x, y1: p.y };
    case 'x1y2':
      return { ...a, x1: p.x, y2: p.y };
    default:
      return a;
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, a: ShapeAnnotation) {
  const head = Math.max(10, a.width * 4);
  const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const length = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  const bodyEnd = Math.max(0, length - head * 0.9);
  const ex = a.x1 + Math.cos(angle) * bodyEnd;
  const ey = a.y1 + Math.sin(angle) * bodyEnd;

  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(
    a.x2 - Math.cos(angle - Math.PI / 7) * head,
    a.y2 - Math.sin(angle - Math.PI / 7) * head,
  );
  ctx.lineTo(
    a.x2 - Math.cos(angle + Math.PI / 7) * head,
    a.y2 - Math.sin(angle + Math.PI / 7) * head,
  );
  ctx.closePath();
  ctx.fill();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save();
  if (a.type === 'step') {
    const r = a.radius;
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 1.25)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(a.n), a.x, a.y + r * 0.05);
  } else if (a.type === 'text') {
    ctx.font = `bold ${a.size}px Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(3, a.size * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(a.text, a.x, a.y);
    ctx.fillStyle = a.color;
    ctx.fillText(a.text, a.x, a.y);
  } else {
    const x = Math.min(a.x1, a.x2);
    const y = Math.min(a.y1, a.y2);
    const w = Math.abs(a.x2 - a.x1);
    const h = Math.abs(a.y2 - a.y1);
    if (a.type === 'arrow') {
      drawArrow(ctx, a);
    } else if (a.type === 'rect') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.strokeRect(x, y, w, h);
    } else if (a.type === 'ellipse') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.type === 'highlight') {
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = a.color;
      ctx.fillRect(x, y, w, h);
    } else if (a.type === 'redact') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x, y, w, h);
    }
  }
  ctx.restore();
}

function bounds(ctx: CanvasRenderingContext2D, a: Annotation) {
  if (a.type === 'step') {
    return { x: a.x - a.radius, y: a.y - a.radius, w: a.radius * 2, h: a.radius * 2 };
  }
  if (a.type === 'text') {
    ctx.save();
    ctx.font = `bold ${a.size}px Arial, sans-serif`;
    const w = ctx.measureText(a.text || ' ').width;
    ctx.restore();
    return { x: a.x, y: a.y, w, h: a.size * 1.2 };
  }
  const pad = a.width + 6;
  return {
    x: Math.min(a.x1, a.x2) - pad,
    y: Math.min(a.y1, a.y2) - pad,
    w: Math.abs(a.x2 - a.x1) + pad * 2,
    h: Math.abs(a.y2 - a.y1) + pad * 2,
  };
}

export default function Editor({ shot, index, total, onSave, onClose, onNavigate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{
    mode: 'create' | 'move' | 'handle';
    id: string;
    handle?: string;
    ox: number;
    oy: number;
  } | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<ToolId>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(5);
  const [nextStep, setNextStep] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<PendingNav>(null);

  const selected = annotations.find((a) => a.id === selectedId) || null;

  /** Image pixels per screen pixel, used so handles stay a constant size. */
  const viewScale = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 1;
    const box = canvas.getBoundingClientRect();
    if (box.width === 0) return 1;
    return canvas.width / box.width;
  }, []);

  const redraw = useCallback(
    (withSelection: boolean) => {
      const canvas = canvasRef.current;
      const img = imageRef.current;
      if (!canvas || !img) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const a of annotations) drawAnnotation(ctx, a);

      if (!withSelection || !selectedId) return;
      const sel = annotations.find((a) => a.id === selectedId);
      if (!sel) return;

      const scale = viewScale();
      const b = bounds(ctx, sel);
      ctx.save();
      ctx.strokeStyle = '#00e5ff';
      ctx.setLineDash([8 * scale, 6 * scale]);
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);

      const r = HANDLE_SCREEN_RADIUS * scale;
      for (const point of handlePoints(sel)) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeStyle = '#00e5ff';
        ctx.stroke();
      }
      ctx.restore();
    },
    [annotations, selectedId, viewScale],
  );

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setAnnotations([]);
    setSelectedId(null);
    setNextStep(1);
    setDirty(false);
    loadImage(shot.url)
      .then((img) => {
        if (cancelled) return;
        imageRef.current = img;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      cancelled = true;
    };
  }, [shot.url]);

  useEffect(() => {
    if (ready) redraw(true);
  }, [ready, redraw]);

  const toImage = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * canvas.width,
      y: ((event.clientY - box.top) / box.height) * canvas.height,
    };
  };

  /** Handles of the selected item are grabbable no matter which tool is active. */
  const hitHandle = (x: number, y: number): string | null => {
    if (!selected) return null;
    const r = HANDLE_SCREEN_RADIUS * viewScale() * 1.6;
    for (const point of handlePoints(selected)) {
      if (Math.hypot(point.x - x, point.y - y) <= r) return point.id;
    }
    return null;
  };

  const hitTest = (x: number, y: number): Annotation | null => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return null;
    for (let i = annotations.length - 1; i >= 0; i -= 1) {
      const b = bounds(ctx, annotations[i]);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return annotations[i];
    }
    return null;
  };

  const handleDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    const p = toImage(event);

    const handle = hitHandle(p.x, p.y);
    if (handle && selected) {
      dragRef.current = { mode: 'handle', id: selected.id, handle, ox: p.x, oy: p.y };
      return;
    }

    if (tool === 'select') {
      const hit = hitTest(p.x, p.y);
      setSelectedId(hit ? hit.id : null);
      if (hit) dragRef.current = { mode: 'move', id: hit.id, ox: p.x, oy: p.y };
      return;
    }

    if (tool === 'step') {
      const a: Annotation = {
        id: uid(),
        type: 'step',
        color,
        width,
        x: p.x,
        y: p.y,
        n: nextStep,
        radius: stepRadius(width),
      };
      setAnnotations((prev) => [...prev, a]);
      setNextStep((n) => n + 1);
      setSelectedId(a.id);
      setDirty(true);
      dragRef.current = { mode: 'move', id: a.id, ox: p.x, oy: p.y };
      return;
    }

    if (tool === 'text') {
      const a: Annotation = {
        id: uid(),
        type: 'text',
        color,
        width,
        x: p.x,
        y: p.y,
        text: 'Text',
        size: textFontSize(width),
      };
      setAnnotations((prev) => [...prev, a]);
      setSelectedId(a.id);
      setDirty(true);
      dragRef.current = { mode: 'move', id: a.id, ox: p.x, oy: p.y };
      return;
    }

    const a: ShapeAnnotation = {
      id: uid(),
      type: tool as ShapeType,
      color,
      width,
      x1: p.x,
      y1: p.y,
      x2: p.x,
      y2: p.y,
    };
    setAnnotations((prev) => [...prev, a]);
    setSelectedId(a.id);
    setDirty(true);
    dragRef.current = { mode: 'create', id: a.id, ox: p.x, oy: p.y };
  };

  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const drag = dragRef.current;
    const p = toImage(event);

    if (!drag) {
      // Hover feedback so it is obvious that a shape can be reshaped.
      if (canvas) {
        if (hitHandle(p.x, p.y)) canvas.style.cursor = 'grab';
        else if (tool === 'select') canvas.style.cursor = 'default';
        else canvas.style.cursor = 'crosshair';
      }
      return;
    }

    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== drag.id) return a;
        if (drag.mode === 'handle' && isShape(a) && drag.handle) {
          return moveHandle(a, drag.handle, p);
        }
        if (drag.mode === 'create' && isShape(a)) {
          return { ...a, x2: p.x, y2: p.y };
        }
        const dx = p.x - drag.ox;
        const dy = p.y - drag.oy;
        if (isShape(a)) {
          return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
        }
        return { ...a, x: a.x + dx, y: a.y + dy };
      }),
    );
    if (drag.mode === 'move') dragRef.current = { ...drag, ox: p.x, oy: p.y };
    setDirty(true);
  };

  const handleUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.mode !== 'create') return;
    // Drop zero sized shapes created by a stray click.
    setAnnotations((prev) =>
      prev.filter((a) => {
        if (a.id !== drag.id || !isShape(a)) return true;
        return Math.abs(a.x2 - a.x1) > 3 || Math.abs(a.y2 - a.y1) > 3;
      }),
    );
  };

  /** Property changes apply to the selected item as well as to new ones. */
  const applyColor = (value: string) => {
    setColor(value);
    if (!selectedId) return;
    setAnnotations((prev) => prev.map((a) => (a.id === selectedId ? { ...a, color: value } : a)));
    setDirty(true);
  };

  const applyWidth = (value: number) => {
    setWidth(value);
    if (!selectedId) return;
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== selectedId) return a;
        if (a.type === 'step') return { ...a, width: value, radius: stepRadius(value) };
        if (a.type === 'text') return { ...a, width: value, size: textFontSize(value) };
        return { ...a, width: value };
      }),
    );
    setDirty(true);
  };

  const applyStepNumber = (value: number) => {
    const n = Math.max(1, value || 1);
    if (selected && selected.type === 'step') {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === selected.id && a.type === 'step' ? { ...a, n } : a)),
      );
      setDirty(true);
      return;
    }
    setNextStep(n);
  };

  const undo = useCallback(() => {
    setAnnotations((prev) => prev.slice(0, -1));
    setSelectedId(null);
    setDirty(true);
  }, []);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    setAnnotations((prev) => prev.filter((a) => a.id !== selectedId));
    setSelectedId(null);
    setDirty(true);
  }, [selectedId]);

  const save = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    redraw(false);
    const blob = await canvasToBlob(canvas);
    onSave(blob, makeThumb(canvas));
    setDirty(false);
    redraw(true);
  }, [onSave, redraw]);

  /** Navigation and closing go through here so unsaved work is never dropped. */
  const requestLeave = useCallback(
    (target: PendingNav) => {
      if (!target) return;
      if (dirty) {
        setPendingNav(target);
        return;
      }
      if (target.kind === 'close') onClose();
      else onNavigate(target.delta);
    },
    [dirty, onClose, onNavigate],
  );

  const resolvePending = useCallback(
    async (action: 'save' | 'discard') => {
      const target = pendingNav;
      setPendingNav(null);
      if (!target) return;
      if (action === 'save') await save();
      if (target.kind === 'close') onClose();
      else onNavigate(target.delta);
    },
    [pendingNav, save, onClose, onNavigate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (pendingNav) return;
      if (event.key === 'Escape') requestLeave({ kind: 'close' });
      else if (event.key === 'Delete' || event.key === 'Backspace') removeSelected();
      else if (event.ctrlKey && event.key.toLowerCase() === 'z') undo();
      else if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingNav, requestLeave, removeSelected, undo, save]);

  const stepFieldValue = selected && selected.type === 'step' ? selected.n : nextStep;

  return (
    <div className="modal">
      <div className="modal-bar">
        <button onClick={() => requestLeave({ kind: 'nav', delta: -1 })} disabled={index <= 0}>
          Previous
        </button>
        <span className="mono">
          {index + 1} / {total}
        </span>
        <button
          onClick={() => requestLeave({ kind: 'nav', delta: 1 })}
          disabled={index >= total - 1}
        >
          Next
        </button>
        <span className="spacer" />
        <button className="primary" onClick={() => void save()} disabled={!dirty}>
          Save changes
        </button>
        <button onClick={() => requestLeave({ kind: 'close' })}>Close</button>
      </div>

      <div className="editor-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={tool === t.id ? 'tool active' : 'tool'}
            onClick={() => setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={color === c ? 'swatch active' : 'swatch'}
            style={{ background: c }}
            onClick={() => applyColor(c)}
            title={c}
          />
        ))}
        <span className="sep" />
        <label className="inline">
          Thickness
          <input
            type="range"
            min={2}
            max={14}
            value={width}
            onChange={(e) => applyWidth(Number(e.target.value))}
          />
        </label>
        <label className="inline">
          {selected && selected.type === 'step' ? 'Step number' : 'Next step number'}
          <input
            type="number"
            min={1}
            value={stepFieldValue}
            onChange={(e) => applyStepNumber(Number(e.target.value))}
          />
        </label>
        {selected && selected.type === 'text' ? (
          <label className="inline grow">
            Content
            <input
              type="text"
              value={selected.text}
              onChange={(e) => {
                const value = e.target.value;
                setAnnotations((prev) =>
                  prev.map((a) => (a.id === selected.id && a.type === 'text' ? { ...a, text: value } : a)),
                );
                setDirty(true);
              }}
            />
          </label>
        ) : null}
        <span className="spacer" />
        <button onClick={undo} disabled={annotations.length === 0}>
          Undo
        </button>
        <button onClick={removeSelected} disabled={!selectedId}>
          Delete selected
        </button>
        {dirty ? <span className="dirty">Unsaved changes</span> : null}
      </div>

      <div className="modal-body">
        <canvas
          ref={canvasRef}
          className="editor-canvas"
          onMouseDown={handleDown}
          onMouseMove={handleMove}
          onMouseUp={handleUp}
          onMouseLeave={handleUp}
        />
      </div>

      {pendingNav ? (
        <div className="confirm-backdrop">
          <div className="confirm">
            <h3>Unsaved changes</h3>
            <p>
              This screenshot has annotations that have not been saved. Leaving now discards
              them.
            </p>
            <div className="confirm-actions">
              <button className="primary" onClick={() => void resolvePending('save')}>
                Save and continue
              </button>
              <button className="danger" onClick={() => void resolvePending('discard')}>
                Discard changes
              </button>
              <button onClick={() => setPendingNav(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
