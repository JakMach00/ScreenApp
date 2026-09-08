import type { Rect, Shot, ShotKind } from '../types';

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Live stream of one screen. Electron routes this through chromeMediaSource,
 * so the constraints have to be passed in the legacy "mandatory" shape.
 */
export async function getDisplayStream(
  sourceId: string,
  width: number,
  height: number,
  fps: number,
): Promise<MediaStream> {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minWidth: Math.min(1280, width),
        maxWidth: width,
        minHeight: Math.min(720, height),
        maxHeight: height,
        maxFrameRate: fps,
      },
    },
  };
  try {
    // The Electron desktop constraints are not part of the standard typings.
    return await navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints);
  } catch (err) {
    // Fallback for Electron builds where the legacy constraints are rejected.
    await window.api.setPreferredSource(sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: fps, width: { max: width }, height: { max: height } },
    });
    if (!stream) throw err;
    return stream;
  }
}

/**
 * Bytes coming over IPC arrive as Uint8Array. Copying the view into a plain
 * ArrayBuffer keeps both the runtime and the TypeScript BlobPart type happy.
 */
export function bytesToBlob(data: Uint8Array, type: string): Blob {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Blob([copy as ArrayBuffer], { type });
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not read the image back from the canvas.'));
    }, type);
  });
}

/** Small preview used by the gallery. Kept as a data URL so it survives revokes. */
export function makeThumb(source: HTMLImageElement | HTMLCanvasElement, maxW = 320): string {
  const sw = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const sh = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const scale = Math.min(1, maxW / Math.max(1, sw));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

/** Full resolution screenshot of one screen, optionally cropped. */
export async function grabScreenshot(
  sourceId: string,
  width: number,
  height: number,
  region: Rect | null,
): Promise<{ blob: Blob; width: number; height: number; thumbUrl: string }> {
  const raw = await window.api.captureScreen(sourceId, width, height);
  const blob = bytesToBlob(raw.data, 'image/png');
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const crop: Rect = region ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.w));
    canvas.height = Math.max(1, Math.round(crop.h));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context available.');
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    const out = await canvasToBlob(canvas);
    return {
      blob: out,
      width: canvas.width,
      height: canvas.height,
      thumbUrl: makeThumb(canvas),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Crops an already captured image (used by the region picker). */
export async function cropImage(
  url: string,
  region: Rect,
): Promise<{ blob: Blob; width: number; height: number; thumbUrl: string }> {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.w));
  canvas.height = Math.max(1, Math.round(region.h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context available.');
  ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas);
  return { blob, width: canvas.width, height: canvas.height, thumbUrl: makeThumb(canvas) };
}

/** Microphone track from whatever Windows has set as the default input. */
export async function getMicrophoneTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('The microphone returned no audio track.');
  return track;
}

/**
 * System audio, meaning whatever the machine is playing. It only arrives
 * through getDisplayMedia with the main process answering 'loopback', so the
 * video track that comes with it is dropped straight away.
 */
export async function getSystemAudioTrack(sourceId: string): Promise<MediaStreamTrack> {
  await window.api.setPreferredSource(sourceId);
  await window.api.setLoopbackAudio(true);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Windows returned no system audio.');
    return track;
  } finally {
    await window.api.setLoopbackAudio(false);
  }
}

/** Mixes several audio tracks into one, needed when recording mic and system. */
export function mixAudioTracks(tracks: MediaStreamTrack[]): {
  track: MediaStreamTrack;
  context: AudioContext;
} {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  for (const track of tracks) {
    context.createMediaStreamSource(new MediaStream([track])).connect(destination);
  }
  return { track: destination.stream.getAudioTracks()[0], context };
}

export function makeShot(params: {
  kind: ShotKind;
  blob: Blob;
  width: number;
  height: number;
  thumbUrl: string;
  durationMs?: number;
  name?: string;
  hasAudio?: boolean;
  ext?: string;
}): Shot {
  const created = new Date();
  const ext = params.kind === 'image' ? 'png' : params.ext ?? 'webm';
  return {
    id: uid(),
    kind: params.kind,
    name: params.name ?? `${params.kind === 'image' ? 'screenshot' : 'recording'}_${stamp(created)}.${ext}`,
    blob: params.blob,
    url: URL.createObjectURL(params.blob),
    thumbUrl: params.thumbUrl,
    width: params.width,
    height: params.height,
    createdAt: created.getTime(),
    durationMs: params.durationMs ?? 0,
    hasAudio: params.hasAudio ?? false,
    ext,
  };
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
