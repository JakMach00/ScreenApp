import { formatDuration, formatSize } from '../lib/capture';
import type { Shot } from '../types';

interface Props {
  shots: Shot[];
  onOpen: (index: number) => void;
  onDelete: (id: string) => void;
}

export default function Gallery({ shots, onOpen, onDelete }: Props) {
  if (shots.length === 0) {
    return (
      <div className="gallery empty">Nothing captured yet. Start with the buttons on the left.</div>
    );
  }

  return (
    <div className="gallery">
      {shots.map((shot, index) => (
        <div className="card" key={shot.id}>
          <button className="card-thumb" onClick={() => onOpen(index)} title="Open">
            <img src={shot.thumbUrl} alt={shot.name} />
            {shot.kind === 'video' ? (
              <span className="card-badge">{formatDuration(shot.durationMs)}</span>
            ) : null}
          </button>
          <div className="card-meta">
            <span className="card-name" title={shot.name}>
              {shot.name}
            </span>
            <span className="card-sub">
              {shot.width} x {shot.height} - {formatSize(shot.blob.size)}
            </span>
          </div>
          <button className="card-del" onClick={() => onDelete(shot.id)} title="Delete">
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
