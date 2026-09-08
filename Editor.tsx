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
  { id: 'select', label: 'Wybor' },
  { id: 'arrow', label: 'Strzalka' },
  { id: 'rect', label: 'Ramka' },
  { id: 'ellipse', label: 'Elipsa' },
  { id: 'step', label: 'Krok' },
  { id: 'text', label: 'Tekst' },
  { id: 'highlight', label: 'Zakreslacz' },
  { id: 'redact', label: 'Cenzura' },
];

function isShape(a: Annotation): a is ShapeAnnotation {
  return a.type !== 'step' && a.type !== 'text';
}

function textFontSize(width: number): number {
  return Math.round(width * 7 + 12);
}

function stepRadius(width: number): number {
  return Math.round(width * 4 + 12);
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  a: ShapeAnnotation,
) {
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
  const dragRef = useRef<{ mode: 'create' | 'move'; id: string; ox: number; oy: number } | null>(
    null,
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<ToolId>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(5);
  const [nextStep, setNextStep] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);

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
      if (withSelection && selectedId) {
        const sel = annotations.find((a) => a.id === selectedId);
        if (sel) {
          const b = bounds(ctx, sel);
          ctx.save();
          ctx.strokeStyle = '#00e5ff';
          ctx.setLineDash([8, 6]);
          ctx.lineWidth = 2;
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.restore();
        }
      }
    },
    [annotations, selectedId],
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

  const hitTest = (x: number, y: number): Annotation | null => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
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
        text: 'Tekst',
        size: textFontSize(width),
      };
      setAnnotations((prev) => [...prev, a]);
      setSelectedId(a.id);
      setDirty(true);
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
    const drag = dragRef.current;
    if (!drag) return;
    const p = toImage(event);

    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== drag.id) return a;
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

  const undo = useCallback(() => {
    setAnnotations((prev) => prev.slice(0, -1));
    setSelectedId(null);
    setDirty(true);
  }, []);

  const removeSelected = useCallback(() => {
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'Delete' || event.key === 'Backspace') removeSelected();
      else if (event.ctrlKey && event.key.toLowerCase() === 'z') undo();
      else if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, removeSelected, undo, save]);

  const selected = annotations.find((a) => a.id === selectedId) || null;

  return (
    <div className="modal">
      <div className="modal-bar">
        <button onClick={() => onNavigate(-1)} disabled={index <= 0}>
          Poprzedni
        </button>
        <span className="mono">
          {index + 1} / {total}
        </span>
        <button onClick={() => onNavigate(1)} disabled={index >= total - 1}>
          Nastepny
        </button>
        <span className="spacer" />
        <button className="primary" onClick={() => void save()}>
          Zapisz zmiany
        </button>
        <button onClick={onClose}>Zamknij</button>
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
            onClick={() => setColor(c)}
            title={c}
          />
        ))}
        <span className="sep" />
        <label className="inline">
          Grubosc
          <input
            type="range"
            min={2}
            max={14}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
        <label className="inline">
          Nastepny krok
          <input
            type="number"
            min={1}
            value={nextStep}
            onChange={(e) => setNextStep(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        {selected && selected.type === 'text' ? (
          <label className="inline grow">
            Tresc
            <input
              type="text"
              value={selected.text}
              onChange={(e) =>
                setAnnotations((prev) =>
                  prev.map((a) =>
                    a.id === selected.id && a.type === 'text' ? { ...a, text: e.target.value } : a,
                  ),
                )
              }
            />
          </label>
        ) : null}
        <span className="spacer" />
        <button onClick={undo} disabled={annotations.length === 0}>
          Cofnij
        </button>
        <button onClick={removeSelected} disabled={!selectedId}>
          Usun zaznaczone
        </button>
        {dirty ? <span className="dirty">Niezapisane zmiany</span> : null}
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
    </div>
  );
}
