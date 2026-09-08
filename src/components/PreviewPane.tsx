import { useEffect, useRef, useState } from 'react';
import { getDisplayStream } from '../lib/capture';
import type { SourceInfo } from '../types';

interface Props {
  source: SourceInfo | null;
  enabled: boolean;
  fps: number;
  recording: boolean;
  elapsedLabel: string;
}

export default function PreviewPane({ source, enabled, fps, recording, elapsedLabel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    async function attach() {
      setError(null);
      if (!enabled || !source) return;
      try {
        stream = await getDisplayStream(source.id, source.width, source.height, fps);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const el = videoRef.current;
        if (el) {
          el.srcObject = stream;
          await el.play().catch(() => undefined);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    attach();
    return () => {
      cancelled = true;
      const el = videoRef.current;
      if (el) el.srcObject = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [source, enabled, fps]);

  return (
    <div className="preview">
      {recording ? (
        <div className="preview-state">
          <span className="rec-dot" />
          <span>Recording {elapsedLabel}</span>
          <span className="preview-hint">Preview is paused while recording</span>
        </div>
      ) : enabled ? (
        <video ref={videoRef} muted playsInline className="preview-video" />
      ) : (
        <div className="preview-state">
          <span>Live preview is off</span>
        </div>
      )}
      {error ? <div className="preview-error">{error}</div> : null}
      {source ? (
        <div className="preview-badge">
          {source.primary ? 'Primary screen' : source.name} &middot; {source.width} x{' '}
          {source.height}
        </div>
      ) : null}
    </div>
  );
}
