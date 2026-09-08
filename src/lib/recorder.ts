import type { AudioSource, Rect, VideoFormat } from '../types';
import {
  getDisplayStream,
  getMicrophoneTrack,
  getSystemAudioTrack,
  makeThumb,
  mixAudioTracks,
} from './capture';

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
  /** Which audio to mix into the recording. */
  audio: AudioSource;
  /** Container to write. MP4 falls back to WebM when H.264 is unavailable. */
  format: VideoFormat;
}

export interface RecordResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
  thumbUrl: string;
  hasAudio: boolean;
  ext: string;
}

/**
 * MP4 with H.264 plays in Windows Media Player Legacy, which cannot open WebM.
 * Chromium can write it directly since version 126, but the H.264 encoder is
 * not guaranteed on every machine, so support is checked at runtime and WebM
 * is used as the fallback.
 */
export function pickMimeType(withAudio = false, format: VideoFormat = 'webm'): string {
  const mp4 = withAudio
    ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4']
    : ['video/mp4;codecs=avc1.42E01E', 'video/mp4'];
  const webm = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  const candidates = format === 'mp4' ? [...mp4, ...webm] : webm;
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

export function extForMimeType(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
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
  private audioTracks: MediaStreamTrack[] = [];
  private audioContext: AudioContext | null = null;
  private hasAudio = false;
  private ext = 'webm';
  private startedAt = 0;
  private thumbUrl = '';
  private outWidth = 0;
  private outHeight = 0;

  get active(): boolean {
    return this.recorder !== null;
  }

  /**
   * Collects the requested audio. A refused microphone or a machine without a
   * loopback device must not kill the recording, so failures come back as
   * warnings and the capture continues without sound.
   */
  private async collectAudio(options: RecordOptions): Promise<string[]> {
    const warnings: string[] = [];
    const wanted: ('mic' | 'system')[] = [];
    if (options.audio === 'mic' || options.audio === 'both') wanted.push('mic');
    if (options.audio === 'system' || options.audio === 'both') wanted.push('system');

    for (const kind of wanted) {
      try {
        const track =
          kind === 'mic' ? await getMicrophoneTrack() : await getSystemAudioTrack(options.sourceId);
        this.audioTracks.push(track);
      } catch (err) {
        warnings.push(
          kind === 'mic'
            ? `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`
            : `System audio unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return warnings;
  }

  async start(options: RecordOptions, onInterrupted?: () => void): Promise<string[]> {
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

    const warnings = await this.collectAudio(options);
    let audioTrack: MediaStreamTrack | null = null;
    if (this.audioTracks.length === 1) {
      audioTrack = this.audioTracks[0];
    } else if (this.audioTracks.length > 1) {
      const mixed = mixAudioTracks(this.audioTracks);
      audioTrack = mixed.track;
      this.audioContext = mixed.context;
    }
    this.hasAudio = audioTrack !== null;

    const output = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioTrack ? [audioTrack] : []),
    ]);

    const mimeType = pickMimeType(this.hasAudio, options.format);
    this.ext = extForMimeType(mimeType);
    if (options.format === 'mp4' && this.ext !== 'mp4') {
      warnings.push('MP4 is not available on this machine, the recording is WebM.');
    }

    const recorder = new MediaRecorder(output, {
      mimeType,
      videoBitsPerSecond: options.bitrate,
      audioBitsPerSecond: 96000,
    });
    this.chunks = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
    return warnings;
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
      hasAudio: this.hasAudio,
      ext: this.ext,
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
    for (const track of this.audioTracks) track.stop();
    this.audioTracks = [];
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.canvasStream = null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.hasAudio = false;
  }
}
