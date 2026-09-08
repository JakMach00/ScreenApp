import type { Rect } from '../types';
import { getDisplayStream, makeThumb } from './capture';

export interface RecordOptions {
  sourceId: string;
  /** Native pixel size of the recorded screen. */
  screenWidth: number;
  screenHeight: number;
  /** Region in native screen pixels, or null for the whole screen. */
  region: Rect | null;
  fps: number;
  /** Target bitrate in bits per second. Lower means smaller files. */
  bitrate: number;
  /** Downscale factor applied to the output, 1 = native size. */
  scale: number;
}

export interface RecordResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
  thumbUrl: string;
}

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

/** Even dimensions keep every encoder happy. */
function even(value: number): number {
  const v = Math.max(2, Math.round(value));
  return v % 2 === 0 ? v : v - 1;
}

export class ScreenRecorder {
  private stream: MediaStream | null = null;
  private canvasStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: number | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private thumbUrl = '';
  private outWidth = 0;
  private outHeight = 0;

  get active(): boolean {
    return this.recorder !== null;
  }

  async start(options: RecordOptions, onInterrupted?: () => void): Promise<void> {
    if (this.recorder) throw new Error('A recording is already running.');

    const stream = await getDisplayStream(
      options.sourceId,
      options.screenWidth,
      options.screenHeight,
      options.fps,
    );
    this.stream = stream;

    const track = stream.getVideoTracks()[0];
    if (track && onInterrupted) track.addEventListener('ended', onInterrupted);

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.videoWidth > 0) resolve();
      else video.onloadedmetadata = () => resolve();
    });
    this.video = video;

    // The stream may be delivered at a different size than the native screen,
    // so region coordinates have to be rescaled before cropping.
    const sx = video.videoWidth / options.screenWidth;
    const sy = video.videoHeight / options.screenHeight;
    const region = options.region;
    const src = region
      ? {
          x: Math.round(region.x * sx),
          y: Math.round(region.y * sy),
          w: Math.round(region.w * sx),
          h: Math.round(region.h * sy),
        }
      : { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };

    const canvas = document.createElement('canvas');
    canvas.width = even(src.w * options.scale);
    canvas.height = even(src.h * options.scale);
    this.outWidth = canvas.width;
    this.outHeight = canvas.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D context available for recording.');

    const draw = () => {
      if (!this.video) return;
      ctx.drawImage(this.video, src.x, src.y, src.w, src.h, 0, 0, canvas.width, canvas.height);
    };
    draw();
    this.thumbUrl = makeThumb(canvas);

    this.timer = window.setInterval(draw, Math.max(20, Math.round(1000 / options.fps)));

    const canvasStream = canvas.captureStream(options.fps);
    this.canvasStream = canvasStream;

    const recorder = new MediaRecorder(canvasStream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: options.bitrate,
    });
    this.chunks = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
  }

  async stop(): Promise<RecordResult> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('No recording is active.');

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      recorder.stop();
    });

    const durationMs = performance.now() - this.startedAt;
    const result: RecordResult = {
      blob,
      width: this.outWidth,
      height: this.outHeight,
      durationMs,
      thumbUrl: this.thumbUrl,
    };
    this.cleanup();
    return result;
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    for (const track of this.canvasStream ? this.canvasStream.getTracks() : []) track.stop();
    for (const track of this.stream ? this.stream.getTracks() : []) track.stop();
    this.canvasStream = null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
