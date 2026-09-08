import { useEffect, useRef, useState } from 'react';
import { formatDuration, formatSize } from '../lib/capture';
import { changeSpeed, speedName } from '../lib/transcode';
import type { Shot } from '../types';

interface Props {
  shot: Shot;
  /** Bitrate of the current recording quality profile. */
  bitrate: number;
  onReplace: (result: {
    blob: Blob;
    width: number;
    height: number;
    durationMs: number;
    thumbUrl: string;
    name: string;
  }) => void;
  onStatus: (message: string) => void;
  onClose: () => void;
}

const SPEEDS = [1, 1.1, 1.25, 1.5, 1.75, 2];

export default function VideoPlayer({ shot, bitrate, onReplace, onStatus, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, shot.url]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, shot.url]);

  const apply = async () => {
    setConfirming(false);
    setWorking(true);
    setProgress(0);
    onStatus(`Applying ${rate}x speed, this runs at playback speed.`);
    try {
      const result = await changeSpeed(
        shot.blob,
        rate,
        // A faster clip carries more motion per second, so the bitrate is
        // raised a little to keep small text readable.
        { fps: 24, bitrate: Math.round(bitrate * 1.3), hasAudio: shot.hasAudio },
        (ratio) => setProgress(ratio),
      );
      onReplace({ ...result, name: speedName(shot.name, rate) });
      onStatus(`Recording is now ${rate}x, length ${formatDuration(result.durationMs)}.`);
      setRate(1);
    } catch (err) {
      onStatus(`Could not change the speed: ${String(err)}`);
    } finally {
      setWorking(false);
      setProgress(0);
    }
  };

  return (
    <div className="modal">
      <div className="modal-bar">
        <span>{shot.name}</span>
        <span className="mono">
          {formatDuration(shot.durationMs)} - {formatSize(shot.blob.size)}
        </span>
        <span className="spacer" />
        <button onClick={onClose} disabled={working}>
          Close
        </button>
      </div>

      <div className="editor-tools">
        <span className="inline">Speed</span>
        {SPEEDS.map((value) => (
          <button
            key={value}
            className={rate === value ? 'tool active' : 'tool'}
            onClick={() => setRate(value)}
            disabled={working}
          >
            {value}x
          </button>
        ))}
        <span className="sep" />
        <label className="check" title={shot.hasAudio ? '' : 'This recording has no audio track.'}>
          <input
            type="checkbox"
            checked={muted}
            onChange={(e) => setMuted(e.target.checked)}
            disabled={!shot.hasAudio}
          />
          {shot.hasAudio ? 'Mute' : 'No audio track'}
        </label>
        <span className="spacer" />
        {working ? (
          <span className="inline">
            <progress value={progress} max={1} />
            {Math.round(progress * 100)}%
          </span>
        ) : null}
        <button
          className="primary"
          onClick={() => setConfirming(true)}
          disabled={working || rate === 1}
        >
          Apply {rate}x to the file
        </button>
      </div>

      <div className="modal-body">
        <video ref={videoRef} src={shot.url} controls autoPlay className="player" />
      </div>

      {confirming ? (
        <div className="confirm-backdrop">
          <div className="confirm">
            <h3>Apply {rate}x speed</h3>
            <p>
              The recording is re-encoded at {rate}x and replaces the current one. Conversion
              runs at playback speed, so a clip of {formatDuration(shot.durationMs)} takes about{' '}
              {formatDuration(shot.durationMs / rate)}. Re-encoding costs some image quality,
              and the original speed cannot be restored afterwards.
            </p>
            <div className="confirm-actions">
              <button className="primary" onClick={() => void apply()}>
                Convert
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
