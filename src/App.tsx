import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './components/Editor';
import Gallery from './components/Gallery';
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
import type { AudioSource, Rect, ShortcutMap, Shot, SourceInfo } from './types';

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
  const [saveDir, setSaveDir] = useState<string | null>(() => loadSetting<string | null>('saveDir', null));
  const [useSaveDir, setUseSaveDir] = useState<boolean>(() => loadSetting('useSaveDir', false));

  const [quality, setQuality] = useState<QualityKey>(() => loadSetting('quality', 'medium'));
  const [audioSource, setAudioSource] = useState<AudioSource>(() =>
    loadSetting<AudioSource>('audioSource', 'none'),
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
  const [theme, setTheme] = useState<Theme>(() =>
    loadSetting<Theme>('theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  );

  const recorderRef = useRef<ScreenRecorder>(new ScreenRecorder());
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
  useEffect(() => saveSetting('hideOnCapture', hideOnCapture), [hideOnCapture]);
  useEffect(() => saveSetting('clearAfterExport', clearAfterExport), [clearAfterExport]);
  useEffect(() => saveSetting('compressPdf', compressPdf), [compressPdf]);
  useEffect(() => saveSetting('saveDir', saveDir), [saveDir]);
  useEffect(() => saveSetting('useSaveDir', useSaveDir), [useSaveDir]);

  useEffect(() => {
    window.api
      .listSources()
      .then((list) => {
        setSources(list);
        const primary = list.find((s) => s.primary) ?? list[0];
        if (primary) setSourceId(primary.id);
      })
      .catch((err: unknown) =>
        setStatus(`Could not read the list of screens: ${String(err)}`),
      );
  }, []);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

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
    [source, recording, quality, audioSource],
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
    if (shotsRef.current.length === 0) return;
    if (!window.confirm('Delete every screenshot and recording?')) return;
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.url));
      return [];
    });
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
          };
        }),
      );
    },
    [],
  );

  const exportAll = useCallback(async () => {
    if (shots.length === 0) {
      setStatus('There is nothing to export.');
      return;
    }
    setBusy(true);
    setStatus('Building the PDF...');
    try {
      const hasPdfContent = shots.length > 0;
      const pdf = hasPdfContent
        ? await buildPdf(shots, {
            title: `Documentation ${stamp()}`,
            compress: compressPdf,
            includeVideoPages: true,
          })
        : null;

      const videos = await Promise.all(
        shots
          .filter((s) => s.kind === 'video')
          .map(async (s) => ({
            data: new Uint8Array(await s.blob.arrayBuffer()),
            ext: 'webm',
          })),
      );

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
  }, [shots, compressPdf, clearAfterExport, useSaveDir, saveDir]);

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
      } else if (action === 'export') void exportAll();
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
  ]);

  const editing = editorPos !== null ? images[editorPos] ?? null : null;

  return (
    <div className="app">
      <aside className="side">
        <header className="brand">
          <h1>ScreenApp</h1>
          <button
            className="ghost"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Switch colour theme"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </header>

        <section className="group">
          <h2>Source</h2>
          <label className="field">
            <span>Screen</span>
            <select value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.primary ? ' (primary)' : ''} - {s.width} x {s.height}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={hideOnCapture}
              onChange={(e) => setHideOnCapture(e.target.checked)}
            />
            Hide window while capturing
          </label>
        </section>

        <section className="group">
          <h2>Capture</h2>
          <button className="primary" onClick={() => void captureFull()} disabled={busy}>
            <span>Whole screen</span>
            {shortcuts.capture ? <kbd>{shortcuts.capture}</kbd> : null}
          </button>
          <button onClick={() => void openRegion('shot')} disabled={busy}>
            <span>Region</span>
            {shortcuts.region ? <kbd>{shortcuts.region}</kbd> : null}
          </button>
        </section>

        <section className="group">
          <h2>Recording</h2>
          {recording ? (
            <button className="danger" onClick={() => void stopRecording()}>
              <span>
                <span className="rec-dot" /> Stop ({formatDuration(elapsed)})
              </span>
              {shortcuts.record ? <kbd>{shortcuts.record}</kbd> : null}
            </button>
          ) : (
            <>
              <button onClick={() => void startRecording(null)} disabled={busy}>
                <span>Record whole screen</span>
                {shortcuts.record ? <kbd>{shortcuts.record}</kbd> : null}
              </button>
              <button onClick={() => void openRegion('record')} disabled={busy}>
                <span>Record region</span>
              </button>
            </>
          )}
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
        </section>

        <section className="group">
          <h2>Export</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={clearAfterExport}
              onChange={(e) => setClearAfterExport(e.target.checked)}
            />
            Clear after saving the PDF
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={compressPdf}
              onChange={(e) => setCompressPdf(e.target.checked)}
            />
            Compress images in the PDF
          </label>
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
          {useSaveDir ? (
            <div className="folder-row">
              <span className="folder-path" title={saveDir ?? ''}>
                {saveDir ?? 'No folder selected'}
              </span>
              <button onClick={() => void chooseSaveDir()}>Change</button>
            </div>
          ) : null}
          <button className="primary" onClick={() => void exportAll()} disabled={busy}>
            <span>Save PDF and recordings</span>
            {shortcuts.export ? <kbd>{shortcuts.export}</kbd> : null}
          </button>
          {lastDir ? (
            <button className="link" onClick={() => void openOutputFolder()}>
              Open output folder
            </button>
          ) : null}
        </section>

        <footer className="side-foot">
          <button className="ghost" onClick={() => setShowShortcuts(true)}>
            Keyboard shortcuts
          </button>
        </footer>
      </aside>

      <main className="main">
        <div className="gallery-head">
          <span>
            {images.length} screenshots, {shots.length - images.length} recordings
          </span>
          {recording ? (
            <span className="rec-live">
              <span className="rec-dot" />
              Recording {formatDuration(elapsed)}
            </span>
          ) : null}
          <span className="spacer" />
          <button onClick={deleteAll} disabled={shots.length === 0}>
            Delete all
          </button>
        </div>

        <Gallery shots={shots} onOpen={openShot} onDelete={deleteShot} />

        <footer className={busy ? 'status busy' : 'status'}>{status}</footer>
      </main>

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
