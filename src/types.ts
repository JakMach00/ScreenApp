export interface SourceInfo {
  id: string;
  name: string;
  displayId: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShotKind = 'image' | 'video';

export type AudioSource = 'none' | 'mic' | 'system' | 'both';

export interface Shot {
  id: string;
  kind: ShotKind;
  name: string;
  blob: Blob;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  createdAt: number;
  durationMs: number;
  hasAudio: boolean;
}

export type ToolId =
  | 'select'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'step'
  | 'text'
  | 'highlight'
  | 'redact';

export type ShapeType = 'arrow' | 'rect' | 'ellipse' | 'highlight' | 'redact';

export interface ShapeAnnotation {
  id: string;
  type: ShapeType;
  color: string;
  width: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface StepAnnotation {
  id: string;
  type: 'step';
  color: string;
  width: number;
  x: number;
  y: number;
  n: number;
  radius: number;
}

export interface TextAnnotation {
  id: string;
  type: 'text';
  color: string;
  width: number;
  x: number;
  y: number;
  text: string;
  size: number;
}

export type Annotation = ShapeAnnotation | StepAnnotation | TextAnnotation;

export interface CaptureResult {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ExportVideo {
  data: Uint8Array;
  ext: string;
}

export interface ExportResult {
  dir: string;
  pdfPath: string;
  videoPaths: string[];
  usedDefaultFolder: boolean;
}

export interface RevealResult {
  ok: boolean;
  error?: string;
}

export type ShortcutAction = 'capture' | 'region' | 'record' | 'export';

export type ShortcutMap = Record<ShortcutAction, string>;

export interface ShortcutResult {
  /** Accelerators the operating system refused to hand over. */
  failed: string[];
}

export interface ScreenAppApi {
  listSources: () => Promise<SourceInfo[]>;
  captureScreen: (sourceId: string, width: number, height: number) => Promise<CaptureResult>;
  setPreferredSource: (sourceId: string) => Promise<boolean>;
  setLoopbackAudio: (enabled: boolean) => Promise<boolean>;
  hideWindow: (displayId?: string) => Promise<boolean>;
  showWindow: (force?: boolean) => Promise<boolean>;
  applyShortcuts: (bindings: ShortcutMap) => Promise<ShortcutResult>;
  suspendShortcuts: () => Promise<boolean>;
  resumeShortcuts: () => Promise<ShortcutResult>;
  onShortcut: (callback: (action: ShortcutAction) => void) => () => void;
  exportBundle: (
    pdf: Uint8Array | null,
    videos: ExportVideo[],
    defaultName: string,
    targetDir?: string | null,
  ) => Promise<ExportResult | null>;
  chooseFolder: () => Promise<string | null>;
  reveal: (filePath: string) => Promise<RevealResult>;
}

declare global {
  interface Window {
    api: ScreenAppApi;
  }
}
