import { makeThumb } from './capture';
import { pickMimeType } from './recorder';

export interface SpeedResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
  thumbUrl: string;
}

export interface SpeedOptions {
  /** Frames per second of the produced file. */
  fps: number;
  /** Target bitrate in bits per second. */
  bitrate: number;
  /** Whether the source carries an audio track that has to survive. */
  hasAudio?: boolean;
}

function even(value: number): number {
  const v = Math.max(2, Math.round(value));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Files produced by MediaRecorder often report a duration of Infinity because
 * they carry no seek index. Seeking far past the end forces the browser to
 * work the real length out.
 */
function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve(video.duration);
  }
  return new Promise((resolve) => {
    const settle = () => {
      video.removeEventListener('timeupdate', settle);
      const value = video.duration;
      video.currentTime = 0;
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };
    video.addEventListener('timeupdate', settle);
    video.currentTime = 1e6;
    window.setTimeout(settle, 3000);
  });
}

/**
 * Re-encodes a recording at a higher playback speed. The source is played back
 * faster into a canvas and the canvas stream is recorded, so the produced file
 * really is shorter rather than just tagged with a rate.
 */
export async function changeSpeed(
  source: Blob,
  factor: number,
  options: SpeedOptions,
  onProgress?: (ratio: number) => void,
): Promise<SpeedResult> {
  const withAudio = options.hasAudio === true;
  if (factor <= 1) throw new Error('Speed must be greater than 1.');

  const url = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.src = url;
  video.muted = !withAudio;
  video.playsInline = true;
  video.preload = 'auto';
  // Keeps speech at its normal pitch when the clip is played back faster.
  video.preservesPitch = true;

  let timer = 0;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not read the recording.'));
    });

    const duration = await resolveDuration(video);
    const width = even(video.videoWidth);
    const height = even(video.videoHeight);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D context available for the conversion.');

    video.currentTime = 0;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.oncanplay = () => resolve();
    });

    ctx.drawImage(video, 0, 0, width, height);
    const thumbUrl = makeThumb(canvas);

    stream = canvas.captureStream(options.fps);

    // The element is routed into an offline destination rather than the
    // speakers, so the conversion stays silent while keeping the audio.
    let audioTrack: MediaStreamTrack | null = null;
    if (withAudio) {
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      audioContext.createMediaElementSource(video).connect(destination);
      audioTrack = destination.stream.getAudioTracks()[0] ?? null;
    }

    const output = new MediaStream([
      ...stream.getVideoTracks(),
      ...(audioTrack ? [audioTrack] : []),
    ]);

    const recorder = new MediaRecorder(output, {
      mimeType: pickMimeType(Boolean(audioTrack)),
      videoBitsPerSecond: options.bitrate,
      audioBitsPerSecond: 96000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    });

    const draw = () => {
      ctx.drawImage(video, 0, 0, width, height);
      if (onProgress && duration > 0) {
        onProgress(Math.min(1, video.currentTime / duration));
      }
    };

    recorder.start(500);
    video.playbackRate = factor;
    const started = performance.now();
    timer = window.setInterval(draw, Math.max(20, Math.round(1000 / options.fps)));

    // The guard keeps a damaged file from hanging the conversion forever.
    const guardMs = duration > 0 ? (duration / factor) * 1000 + 15000 : 600000;
    await Promise.race([
      new Promise<void>((resolve) => {
        video.onended = () => resolve();
        void video.play();
      }),
      new Promise<void>((resolve) => window.setTimeout(resolve, guardMs)),
    ]);

    window.clearInterval(timer);
    timer = 0;
    draw();
    // Give the encoder a moment to take the final frames.
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    recorder.stop();

    const blob = await finished;
    if (onProgress) onProgress(1);

    return {
      blob,
      width,
      height,
      durationMs: performance.now() - started,
      thumbUrl,
    };
  } finally {
    if (timer) window.clearInterval(timer);
    if (audioContext) void audioContext.close();
    if (stream) stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Keeps one speed marker in the file name instead of stacking them up. */
export function speedName(name: string, factor: number): string {
  const base = name.replace(/\.webm$/i, '').replace(/_[\d.]+x$/i, '');
  return `${base}_${String(factor).replace(/\.0$/, '')}x.webm`;
}
