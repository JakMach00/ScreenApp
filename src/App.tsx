import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './components/Editor';
import Gallery from './components/Gallery';
import ConfirmDialog from './components/ConfirmDialog';
import Hint from './components/Hint';
import RegionSelector from './components/RegionSelector';
import VideoPlayer from './components/VideoPlayer';
import ShortcutSettings from './components/ShortcutSettings';
import {
  bytesToBlob,
  cropImage,
  formatDuration,
  grabScreenshot,
  makeShot,
  stamp,
} from './lib/capture';
import { buildPdf } from './lib/pdf';
import { ScreenRecorder } from './lib/recorder';
import { mergeShortcuts } from './lib/shortcuts';
import { loadSetting, saveSetting } from './lib/storage';
import type {
  AudioSource,
  Rect,
  ShortcutMap,
  Shot,
  SourceInfo,
  UpdateInfo,
  VideoFormat,
} from './types';

type RegionPurpose = 'shot' | 'record';

interface FrozenFrame {
  url: string;
  width: number;
  height: number;
  purpose: RegionPurpose;
}

const QUALITY = {
  low: { label: 'Low (smallest file)', bitrate: 500_000, fps: 10, scale: 0.6 },
  medium: { label: 'Medium', bitrate: 1_200_000, fps: 15, scale: 0.8 },
  high: { label: 'High', bitrate: 3_000_000, fps: 20, scale: 1 },
};
type QualityKey = keyof typeof QUALITY;

type Theme = 'dark' | 'light';

const FORMAT_OPTIONS: { id: VideoFormat; label: string }[] = [
  { id: 'mp4', label: 'MP4 (H.264, plays everywhere)' },
  { id: 'webm', label: 'WebM (VP9, smaller files)' },
];

const AUDIO_OPTIONS: { id: AudioSource; label: string }[] = [
  { id: 'none', label: 'No audio' },
  { id: 'mic', label: 'Microphone' },
  { id: 'system', label: 'System audio' },
  { id: 'both', label: 'Microphone and system' },
];

export default function App() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceId, setSourceId] = useState<string>('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [frozen, setFrozen] = useState<FrozenFrame | null>(null);
  const [editorPos, setEditorPos] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string>('Ready.');
  const [busy, setBusy] = useState(false);
  const [lastDir, setLastDir] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    loadSetting<string | null>('dismissedVersion', null),
  );
  const [checkOnStart, setCheckOnStart] = useState<boolean>(() =>
    loadSetting('checkOnStart', true),
  );
  const [saveDir, setSaveDir] = useState<string | null>(() => loadSetting<string | null>('saveDir', null));
  const [useSaveDir, setUseSaveDir] = useState<boolean>(() => loadSetting('useSaveDir', false));

  const [quality, setQuality] = useState<QualityKey>(() => loadSetting('quality', 'medium'));
  const [audioSource, setAudioSource] = useState<AudioSource>(() =>
    loadSetting<AudioSource>('audioSource', 'none'),
  );
  const [videoFormat, setVideoFormat] = useState<VideoFormat>(() =>
    loadSetting<VideoFormat>('videoFormat', 'mp4'),
  );
  const [hideOnCapture, setHideOnCapture] = useState<boolean>(() =>
    loadSetting('hideOnCapture', true),
  );
  const [clearAfterExport, setClearAfterExport] = useState<boolean>(() =>
    loadSetting('clearAfterExport', true),
  );
  const [compressPdf, setCompressPdf] = useState<boolean>(() => loadSetting('compressPdf', true));
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() =>
    mergeShortcuts(loadSetting<Partial<ShortcutMap> | null>('shortcuts.v2', null)),
  );
  const [failedShortcuts, setFailedShortcuts] = useState<string[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [theme, setTheme] = useState<Theme>(() =>
    loadSetting<Theme>('theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );

  const recorderRef = useRef<ScreenRecorder>(new ScreenRecorder());
  const sourcesRef = useRef<SourceInfo[]>([]);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  const source = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? sources[0] ?? null,
    [sources, sourceId],
  );
  const images = useMemo(() => shots.filter((s) => s.kind === 'image'), [shots]);
  const playing = useMemo(
    () => shots.find((s) => s.id === playingId) ?? null,
    [shots, playingId],
  );

  useEffect(() => {
    saveSetting('theme', theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => saveSetting('quality', quality), [quality]);
  useEffect(() => saveSetting('audioSource', audioSource), [audioSource]);
  useEffect(() => saveSetting('videoFormat', videoFormat), [videoFormat]);
  useEffect(() => saveSetting('checkOnStart', checkOnStart), [checkOnStart]);
  useEffect(() => saveSetting('dismissedVersion', dismissedVersion), [dismissedVersion]);
  useEffect(() => saveSetting('hideOnCapture', hideOnCapture), [hideOnCapture]);
  useEffect(() => saveSetting('clearAfterExport', clearAfterExport), [clearAfterExport]);
  useEffect(() => saveSetting('compressPdf', compressPdf), [compressPdf]);
  useEffect(() => saveSetting('saveDir', saveDir), [saveDir]);
  useEffect(() => saveSetting('useSaveDir', useSaveDir), [useSaveDir]);

  const refreshSources = useCallback(async () => {
    try {
      const list = await window.api.listSources();
      setSources(list);
      setSourceId((current) => {
        const previous = sourcesRef.current.find((s) => s.id === current);
        const sameDisplay = previous
          ? list.find((s) => s.displayId && s.displayId === previous.displayId)
          : undefined;
        const match = sameDisplay ?? list.find((s) => s.id === current);
        return (match ?? list.find((s) => s.primary) ?? list[0])?.id ?? '';
      });
      sourcesRef.current = list;
    } catch (err) {
      setStatus(`Could not read the list of screens: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // Changing resolution, docking, or plugging a monitor in rebuilds the list
  // without a restart. Source ids change with it, so the current pick is
  // re-matched by display rather than by id.
  useEffect(() => {
    const off = window.api.onDisplaysChanged(() => void refreshSources());
    return off;
  }, [refreshSources]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  const checkForUpdate = useCallback(async (manual: boolean) => {
    try {
      const result = await window.api.checkUpdate();
      setUpdate(result);
      if (!manual) return;
      if (result.error) setStatus(`Update check failed: ${result.error}`);
      else if (result.newer) setStatus(`Version ${result.latest} is available.`);
      else setStatus(`You are running the latest version, ${result.current}.`);
    } catch (err) {
      if (manual) setStatus(`Update check failed: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    // Delayed so a slow or blocked network never holds up the first paint.
    if (!checkOnStart) return;
    const timer = window.setTimeout(() => void checkForUpdate(false), 2500);
    return () => window.clearTimeout(timer);
    // Deliberately runs once per launch rather than on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addShot = useCallback((shot: Shot) => {
    setShots((prev) => [...prev, shot]);
  }, []);

  /** Screenshot of the whole selected screen. */
  const captureFull = useCallback(async () => {
    if (!source || busy) return;
    setBusy(true);
    try {
      if (hideOnCapture) await window.api.hideWindow(source.displayId);
      const result = await grabScreenshot(source.id, source.width, source.height, null);
      addShot(makeShot({ kind: 'image', ...result }));
      setStatus(`Captured ${result.width} x ${result.height}.`);
    } catch (err) {
      setStatus(`Capture failed: ${String(err)}`);
    } finally {
      // Not forced: a window that was minimized when the shortcut fired stays
      // minimized instead of jumping to the front.
      await window.api.showWindow(false);
      setBusy(false);
    }
  }, [source, busy, hideOnCapture, addShot]);

  /** Freezes the screen and opens the region picker. */
  const openRegion = useCallback(
    async (purpose: RegionPurpose) => {
      if (!source || busy) return;
      setBusy(true);
      try {
        if (hideOnCapture) await window.api.hideWindow(source.displayId);
        const raw = await window.api.captureScreen(source.id, source.width, source.height);
        // Forced: the region picker needs a visible window to draw on.
        await window.api.showWindow(true);
        const url = URL.createObjectURL(bytesToBlob(raw.data, 'image/png'));
        setFrozen({ url, width: raw.width, height: raw.height, purpose });
      } catch (err) {
        await window.api.showWindow(true);
        setStatus(`Capture failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [source, busy, hideOnCapture],
  );

  const closeFrozen = useCallback(() => {
    setFrozen((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  const startRecording = useCallback(
    async (region: Rect | null) => {
      if (!source || recording) return;
      const q = QUALITY[quality];
      try {
        const warnings = await recorderRef.current.start(
          {
            sourceId: source.id,
            screenWidth: source.width,
            screenHeight: source.height,
            region,
            fps: q.fps,
            bitrate: q.bitrate,
            scale: q.scale,
            audio: audioSource,
            format: videoFormat,
          },
          () => {
            setStatus('The screen stream was interrupted.');
          },
        );
        setElapsed(0);
        setRecording(true);
        const base = region ? 'Recording a region of the screen.' : 'Recording the whole screen.';
        setStatus(warnings.length > 0 ? `${base} ${warnings.join(' ')}` : base);
      } catch (err) {
        setStatus(`Could not start recording: ${String(err)}`);
      }
    },
    [source, recording, quality, audioSource, videoFormat],
  );

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    try {
      const result = await recorderRef.current.stop();
      setRecording(false);
      addShot(
        makeShot({
          kind: 'video',
          blob: result.blob,
          width: result.width,
          height: result.height,
          thumbUrl: result.thumbUrl,
          durationMs: result.durationMs,
          hasAudio: result.hasAudio,
          ext: result.ext,
        }),
      );
      setStatus(`Recording saved, length ${formatDuration(result.durationMs)}.`);
    } catch (err) {
      setRecording(false);
      setStatus(`Could not stop the recording: ${String(err)}`);
    }
  }, [recording, addShot]);

  const handleRegionSelected = useCallback(
    async (rect: Rect) => {
      const current = frozen;
      if (!current) return;
      try {
        if (current.purpose === 'shot') {
          const result = await cropImage(current.url, rect);
          addShot(makeShot({ kind: 'image', ...result }));
          setStatus(`Region captured, ${result.width} x ${result.height}.`);
          closeFrozen();
        } else {
          closeFrozen();
          await startRecording(rect);
        }
      } catch (err) {
        setStatus(`Region selection failed: ${String(err)}`);
        closeFrozen();
      }
    },
    [frozen, addShot, closeFrozen, startRecording],
  );

  const openShot = useCallback(
    (index: number) => {
      const shot = shots[index];
      if (!shot) return;
      if (shot.kind === 'video') {
        setPlayingId(shot.id);
        return;
      }
      const pos = images.findIndex((s) => s.id === shot.id);
      if (pos >= 0) setEditorPos(pos);
    },
    [shots, images],
  );

  const deleteShot = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  const deleteAll = useCallback(() => {
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.url));
      return [];
    });
    setConfirmClear(false);
    setStatus('Session cleared.');
  }, []);

  const saveEdited = useCallback(
    (shotId: string, blob: Blob, thumbUrl: string) => {
      setShots((prev) =>
        prev.map((s) => {
          if (s.id !== shotId) return s;
          URL.revokeObjectURL(s.url);
          return { ...s, blob, url: URL.createObjectURL(blob), thumbUrl };
        }),
      );
      setStatus('Annotations saved.');
    },
    [],
  );

  const chooseSaveDir = useCallback(async () => {
    const picked = await window.api.chooseFolder();
    if (picked) {
      setSaveDir(picked);
      setUseSaveDir(true);
      setStatus(`Exports will go to ${picked}.`);
      return true;
    }
    return false;
  }, []);

  const openOutputFolder = useCallback(async () => {
    if (!lastDir) return;
    const result = await window.api.reveal(lastDir);
    if (!result.ok) setStatus(`Could not open the folder: ${result.error ?? 'unknown error'}`);
  }, [lastDir]);

  const replaceVideo = useCallback(
    (
      shotId: string,
      result: {
        blob: Blob;
        width: number;
        height: number;
        durationMs: number;
        thumbUrl: string;
        name: string;
        ext: string;
      },
    ) => {
      setShots((prev) =>
        prev.map((s) => {
          if (s.id !== shotId) return s;
          URL.revokeObjectURL(s.url);
          return {
            ...s,
            blob: result.blob,
            url: URL.createObjectURL(result.blob),
            thumbUrl: result.thumbUrl,
            width: result.width,
            height: result.height,
            durationMs: result.durationMs,
            name: result.name,
            ext: result.ext,
          };
        }),
      );
    },
    [],
  );

  const collectVideos = useCallback(
    async () =>
      Promise.all(
        shots
          .filter((s) => s.kind === 'video')
          .map(async (s) => ({
            data: new Uint8Array(await s.blob.arrayBuffer()),
            ext: s.ext || 'webm',
            name: s.name,
          })),
      ),
    [shots],
  );

  /** Writes the recordings on their own, without building a PDF. */
  const exportVideos = useCallback(async () => {
    const recordings = shots.filter((s) => s.kind === 'video');
    if (recordings.length === 0) {
      setStatus('There are no recordings to export.');
      return;
    }
    setBusy(true);
    setStatus('Saving recordings...');
    try {
      const videos = await collectVideos();
      const result = await window.api.exportBundle(
        null,
        videos,
        '',
        useSaveDir ? saveDir : null,
        'videos',
      );
      if (!result) {
        setStatus('Export cancelled.');
        return;
      }
      setLastDir(result.dir);
      setStatus(`Saved ${result.videoPaths.length} recording(s) to ${result.dir}.`);
      if (clearAfterExport) {
        setShots((prev) => {
          const remaining = prev.filter((s) => s.kind !== 'video');
          prev.filter((s) => s.kind === 'video').forEach((s) => URL.revokeObjectURL(s.url));
          return remaining;
        });
      }
    } catch (err) {
      setStatus(`Export failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [shots, collectVideos, useSaveDir, saveDir, clearAfterExport]);

  const exportAll = useCallback(async () => {
    if (shots.length === 0) {
      setStatus('There is nothing to export.');
      return;
    }
    setBusy(true);
    setStatus('Building the PDF...');
    try {
      const pdf =
        images.length > 0
          ? await buildPdf(shots, {
              title: `Documentation ${stamp()}`,
              compress: compressPdf,
            })
          : null;

      const videos = await collectVideos();

      const target = useSaveDir ? saveDir : null;
      const result = await window.api.exportBundle(
        pdf,
        videos,
        `documentation_${stamp()}.pdf`,
        target,
      );
      if (!result) {
        setStatus('Export cancelled.');
        return;
      }
      setLastDir(result.pdfPath || result.dir);
      setStatus(
        `Saved: ${result.pdfPath}${result.videoPaths.length ? ` and ${result.videoPaths.length} recording(s).` : '.'}` +
          (useSaveDir && !result.usedDefaultFolder
            ? ' The chosen folder was unavailable, so the dialog was used.'
            : ''),
      );
      if (clearAfterExport) {
        setShots((prev) => {
          prev.forEach((s) => URL.revokeObjectURL(s.url));
          return [];
        });
      }
    } catch (err) {
      setStatus(`Export failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [shots, images, collectVideos, compressPdf, clearAfterExport, useSaveDir, saveDir]);

  useEffect(() => {
    saveSetting('shortcuts.v2', shortcuts);
    window.api
      .applyShortcuts(shortcuts)
      .then((result) => {
        setFailedShortcuts(result.failed);
        if (result.failed.length > 0) {
          setStatus(
            `The system refused these shortcuts: ${result.failed.join(', ')}. Pick different ones in the shortcut settings.`,
          );
        }
      })
      .catch((err: unknown) => setStatus(`Could not register the shortcuts: ${String(err)}`));
  }, [shortcuts]);

  useEffect(() => {
    const off = window.api.onShortcut((action) => {
      // Ignore global shortcuts while a modal owns the screen.
      if (frozen || editorPos !== null || playing || showShortcuts) return;
      if (action === 'capture') void captureFull();
      else if (action === 'region') void openRegion('shot');
      else if (action === 'record') {
        if (recording) void stopRecording();
        else void startRecording(null);
      } else if (action === 'export') {
        if (images.length === 0) void exportVideos();
        else void exportAll();
      }
    });
    return off;
  }, [
    frozen,
    editorPos,
    playing,
    showShortcuts,
    recording,
    captureFull,
    openRegion,
    startRecording,
    stopRecording,
    exportAll,
    exportVideos,
    images.length,
  ]);

  const editing = editorPos !== null ? images[editorPos] ?? null : null;

  const videoCount = shots.length - images.length;
  const canExport = shots.length > 0;
  // Kept short so it never collides with the shortcut badge. Recordings are
  // always written next to the PDF, which the Export section explains.
  const exportLabel = images.length === 0 && videoCount > 0 ? 'Save recordings' : 'Save PDF';
  const runExport = images.length === 0 ? exportVideos : exportAll;
  const activeQuality = QUALITY[quality].label;
  const activeAudio = AUDIO_OPTIONS.find((o) => o.id === audioSource)?.label ?? 'No audio';

  const captureSection = (
    <section className="group" aria-label="Capture">
      <h2> Capture
      </h2>
      <button
        className="action"
        onClick={() => void captureFull()}
        disabled={busy}
        aria-label="Capture full screen"
      >
        <span>Full screen</span>
        {shortcuts.capture ? <kbd>{shortcuts.capture}</kbd> : null}
      </button>
      <button
        className="action"
        onClick={() => void openRegion('shot')}
        disabled={busy}
        aria-label="Capture a region"
      >
        <span>Selected region</span>
        {shortcuts.region ? <kbd>{shortcuts.region}</kbd> : null}
      </button>
    </section>
  );

  const recordingSection = (
    <section className="group" aria-label="Recording">
      <h2> Recording
      </h2>
      {recording ? (
        <button className="action danger" onClick={() => void stopRecording()}>
          <span>
            <span className="rec-dot" /> Stop {formatDuration(elapsed)}
          </span>
          {shortcuts.record ? <kbd>{shortcuts.record}</kbd> : null}
        </button>
      ) : (
        <>
          <button
            className="action"
            onClick={() => void startRecording(null)}
            disabled={busy}
            aria-label="Record full screen"
          >
            <span>Full screen</span>
            {shortcuts.record ? <kbd>{shortcuts.record}</kbd> : null}
          </button>
          <button
            className="action"
            onClick={() => void openRegion('record')}
            disabled={busy}
            aria-label="Record a region"
          >
            <span>Selected region</span>
          </button>
        </>
      )}
    </section>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">ScreenApp</span>
        </div>
        <button
          className="theme-switch"
          role="switch"
          aria-checked={theme === 'dark'}
          aria-label="Switch colour theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <span className="theme-track" aria-hidden="true">
            <span className="theme-knob" />
          </span>
          <span className="theme-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
        <span className="spacer" />
        {recording ? (
          <span className="rec-live">
            <span className="rec-dot" />
            Recording {formatDuration(elapsed)}
          </span>
        ) : null}
      </header>

      <div className="body">
        <aside className="side">
          <section className="group" aria-label="Source">
            <h2> Source
            </h2>
            <Hint text="The screen every capture and recording is taken from. The list rebuilds itself when a display changes resolution or is plugged in.">
              <label className="field">
                <span>Display</span>
                <select value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.primary ? ' (primary)' : ''} - {s.width} x {s.height}
                    </option>
                  ))}
                </select>
              </label>
            </Hint>
            <Hint text="The window is hidden for a moment so it does not appear in the screenshot. It is left alone when it is minimized or sitting on another monitor, and it never takes focus back.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={hideOnCapture}
                  onChange={(e) => setHideOnCapture(e.target.checked)}
                />
                Hide ScreenApp while capturing
              </label>
            </Hint>
          </section>

          {captureSection}
          {recordingSection}

          <section className="group" aria-label="Output">
            <h2> Output
            </h2>
            <Hint text="MP4 uses H.264 and opens in Windows Media Player Legacy. WebM uses VP9, giving noticeably smaller files, but older players cannot read it.">
              <label className="field">
                <span>Format</span>
                <select
                  value={videoFormat}
                  onChange={(e) => setVideoFormat(e.target.value as VideoFormat)}
                  disabled={recording}
                >
                  {FORMAT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </Hint>
            <Hint text="Microphone records the Windows default input, system audio records what the machine is playing. If a source is unavailable the recording continues silently and says why.">
              <label className="field">
                <span>Audio</span>
                <select
                  value={audioSource}
                  onChange={(e) => setAudioSource(e.target.value as AudioSource)}
                  disabled={recording}
                >
                  {AUDIO_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </Hint>
            <Hint text="Sets frame rate, bitrate and scale together. Low is about 3 to 4 MB per minute at 1080p and is enough for defect documentation, High keeps small text sharp.">
              <label className="field">
                <span>Quality</span>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as QualityKey)}
                  disabled={recording}
                >
                  {(Object.keys(QUALITY) as QualityKey[]).map((key) => (
                    <option key={key} value={key}>
                      {QUALITY[key].label}
                    </option>
                  ))}
                </select>
              </label>
            </Hint>
          </section>

          <section className="group" aria-label="Export">
            <h2> Export
            </h2>
            <Hint text="After a successful export the gallery is emptied, so the next task starts clean. Leave it off to keep the material and delete it yourself.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={clearAfterExport}
                  onChange={(e) => setClearAfterExport(e.target.checked)}
                />
                Clear after saving the PDF
              </label>
            </Hint>
            <Hint text="Screenshots go into the PDF as JPEG instead of PNG. The file gets much smaller, at the cost of slightly softer text. Turn it off when the document has to stay pixel exact.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={compressPdf}
                  onChange={(e) => setCompressPdf(e.target.checked)}
                />
                Compress images in the PDF
              </label>
            </Hint>
            <Hint text="Exports go straight to a folder you pick once, with no save dialog. Files are never overwritten, a repeated name gets a counter.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={useSaveDir}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      setUseSaveDir(false);
                      return;
                    }
                    if (saveDir) setUseSaveDir(true);
                    else void chooseSaveDir();
                  }}
                />
                Always use one folder
              </label>
            </Hint>
            {useSaveDir ? (
              <div className="folder-row">
                <span className="folder-path" title={saveDir ?? ''}>
                  {saveDir ?? 'No folder selected'}
                </span>
                <button onClick={() => void chooseSaveDir()}>Change</button>
              </div>
            ) : null}
            <button
              className="action primary"
              onClick={() => void runExport()}
              disabled={busy || !canExport}
            >
              <span>{exportLabel}</span>
              {shortcuts.export ? <kbd>{shortcuts.export}</kbd> : null}
            </button>
            {images.length > 0 && videoCount > 0 ? (
              <Hint
                inline
                text="Writes the recordings on their own into a folder you choose, with no PDF. Useful when a clip is worth sending on before the screenshots are finished."
              >
                <button className="action" onClick={() => void exportVideos()} disabled={busy}>
                  <span>Save recordings only</span>
                </button>
              </Hint>
            ) : null}
            {lastDir ? (
              <button className="link" onClick={() => void openOutputFolder()}>
                Open output folder
              </button>
            ) : null}
          </section>

          <section className="group" aria-label="Utilities">
            <h2> Utilities
            </h2>
            <button className="action" onClick={() => setShowShortcuts(true)}>
              <span>Keyboard shortcuts</span>
            </button>
            <button className="action" onClick={() => void checkForUpdate(true)}>
              <span>Check for updates</span>
            </button>
            <Hint text="Asks GitHub once at startup whether a newer release exists. Nothing is downloaded or installed, you get a link to the release page. Turn it off to make no network requests at all.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={checkOnStart}
                  onChange={(e) => setCheckOnStart(e.target.checked)}
                />
                Check on startup
              </label>
            </Hint>
            <p className="side-note">Everything stays on this device until you export it.</p>
          </section>
        </aside>

        <main className="workspace">
          {update && update.newer && update.latest && update.latest !== dismissedVersion ? (
            <div className="update-bar">
              <span>
                Version {update.latest} is available, this is {update.current}.
              </span>
              <span className="spacer" />
              <button
                className="primary"
                onClick={() => void window.api.openRelease(update.url ?? '')}
              >
                Open release page
              </button>
              <button onClick={() => setDismissedVersion(update.latest ?? null)}>Dismiss</button>
            </div>
          ) : null}

          <div className="workspace-head">
            <span className="counts">
              {images.length} screenshots
              <span className="dot-sep" />
              {videoCount} recordings
            </span>
            <span className="spacer" />
            <button onClick={() => setConfirmClear(true)} disabled={!canExport}>
              Delete all
            </button>
          </div>

          {shots.length === 0 ? (
            <div className="empty-state">
              <svg className="empty-mark" viewBox="0 0 64 64" aria-hidden="true">
                <rect
                  x="6"
                  y="14"
                  width="38"
                  height="36"
                  rx="6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                />
                <path
                  d="M48 26l10-6v24l-10-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
                <circle cx="25" cy="32" r="6" fill="currentColor" />
              </svg>
              <h3>Nothing captured yet</h3>
              <p>
                Pick a display on the left, then capture the screen or record it. Everything
                stays on this device until you export it.
              </p>
              <div className="empty-actions">
                <button
                  className="action primary"
                  onClick={() => void captureFull()}
                  disabled={busy}
                >
                  <span>Capture full screen</span>
                  {shortcuts.capture ? <kbd>{shortcuts.capture}</kbd> : null}
                </button>
                <button
                  className="action"
                  onClick={() => void startRecording(null)}
                  disabled={busy || recording}
                >
                  <span>Record full screen</span>
                  {shortcuts.record ? <kbd>{shortcuts.record}</kbd> : null}
                </button>
              </div>
              <p className="empty-meta">
                {source ? `${source.name} ${source.width} x ${source.height}` : 'No display found'}
                <span className="dot-sep" />
                {activeAudio}
                <span className="dot-sep" />
                {activeQuality}
              </p>
            </div>
          ) : (
            <Gallery shots={shots} onOpen={openShot} onDelete={deleteShot} />
          )}
        </main>
      </div>

      <footer className={busy ? 'statusbar busy' : 'statusbar'}>
        <span className={recording ? 'state-dot recording' : 'state-dot'} />
        <span className="status-text">{status}</span>
        <span className="version">v{__APP_VERSION__}</span>
      </footer>

      {confirmClear ? (
        <ConfirmDialog
          title="Delete everything"
          message={`This removes ${images.length} screenshot(s) and ${videoCount} recording(s) from the session. Anything already exported to disk is untouched.`}
          confirmLabel="Delete all"
          destructive
          onConfirm={deleteAll}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}

      {frozen ? (
        <RegionSelector
          imageUrl={frozen.url}
          imageWidth={frozen.width}
          imageHeight={frozen.height}
          hint={
            frozen.purpose === 'shot'
              ? 'Select the region to capture'
              : 'Select the region to record'
          }
          onSelect={(rect) => void handleRegionSelected(rect)}
          onCancel={closeFrozen}
        />
      ) : null}

      {editing ? (
        <Editor
          key={editing.id}
          shot={editing}
          index={editorPos ?? 0}
          total={images.length}
          onSave={(blob, thumbUrl) => saveEdited(editing.id, blob, thumbUrl)}
          onClose={() => setEditorPos(null)}
          onNavigate={(delta) =>
            setEditorPos((pos) => {
              if (pos === null) return null;
              const next = pos + delta;
              return next >= 0 && next < images.length ? next : pos;
            })
          }
        />
      ) : null}

      {showShortcuts ? (
        <ShortcutSettings
          shortcuts={shortcuts}
          failed={failedShortcuts}
          onChange={setShortcuts}
          onClose={() => setShowShortcuts(false)}
        />
      ) : null}

      {playing ? (
        <VideoPlayer
          shot={playing}
          bitrate={QUALITY[quality].bitrate}
          onReplace={(result) => replaceVideo(playing.id, result)}
          onStatus={setStatus}
          onClose={() => setPlayingId(null)}
        />
      ) : null}
    </div>
  );
}
