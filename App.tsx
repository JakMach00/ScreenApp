import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './components/Editor';
import Gallery from './components/Gallery';
import PreviewPane from './components/PreviewPane';
import RegionSelector from './components/RegionSelector';
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
import { loadSetting, saveSetting } from './lib/storage';
import type { Rect, Shot, SourceInfo } from './types';

type RegionPurpose = 'shot' | 'record';

interface FrozenFrame {
  url: string;
  width: number;
  height: number;
  purpose: RegionPurpose;
}

const QUALITY = {
  low: { label: 'Mala (najmniejszy plik)', bitrate: 500_000, fps: 10, scale: 0.6 },
  medium: { label: 'Srednia', bitrate: 1_200_000, fps: 15, scale: 0.8 },
  high: { label: 'Wysoka', bitrate: 3_000_000, fps: 20, scale: 1 },
};
type QualityKey = keyof typeof QUALITY;

export default function App() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceId, setSourceId] = useState<string>('');
  const [preview, setPreview] = useState<boolean>(() => loadSetting('preview', true));
  const [shots, setShots] = useState<Shot[]>([]);
  const [frozen, setFrozen] = useState<FrozenFrame | null>(null);
  const [editorPos, setEditorPos] = useState<number | null>(null);
  const [playing, setPlaying] = useState<Shot | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string>('Gotowe.');
  const [busy, setBusy] = useState(false);
  const [lastDir, setLastDir] = useState<string | null>(null);

  const [quality, setQuality] = useState<QualityKey>(() => loadSetting('quality', 'medium'));
  const [hideOnCapture, setHideOnCapture] = useState<boolean>(() =>
    loadSetting('hideOnCapture', true),
  );
  const [clearAfterExport, setClearAfterExport] = useState<boolean>(() =>
    loadSetting('clearAfterExport', true),
  );
  const [compressPdf, setCompressPdf] = useState<boolean>(() => loadSetting('compressPdf', true));
  const [videoPages, setVideoPages] = useState<boolean>(() => loadSetting('videoPages', true));

  const recorderRef = useRef<ScreenRecorder>(new ScreenRecorder());
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  const source = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? sources[0] ?? null,
    [sources, sourceId],
  );
  const images = useMemo(() => shots.filter((s) => s.kind === 'image'), [shots]);

  useEffect(() => saveSetting('preview', preview), [preview]);
  useEffect(() => saveSetting('quality', quality), [quality]);
  useEffect(() => saveSetting('hideOnCapture', hideOnCapture), [hideOnCapture]);
  useEffect(() => saveSetting('clearAfterExport', clearAfterExport), [clearAfterExport]);
  useEffect(() => saveSetting('compressPdf', compressPdf), [compressPdf]);
  useEffect(() => saveSetting('videoPages', videoPages), [videoPages]);

  useEffect(() => {
    window.api
      .listSources()
      .then((list) => {
        setSources(list);
        const primary = list.find((s) => s.primary) ?? list[0];
        if (primary) setSourceId(primary.id);
      })
      .catch((err: unknown) =>
        setStatus(`Nie udalo sie odczytac listy ekranow: ${String(err)}`),
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
      if (hideOnCapture) await window.api.hideWindow();
      const result = await grabScreenshot(source.id, source.width, source.height, null);
      addShot(makeShot({ kind: 'image', ...result }));
      setStatus(`Zapisano zrzut ${result.width} x ${result.height}.`);
    } catch (err) {
      setStatus(`Blad zrzutu: ${String(err)}`);
    } finally {
      if (hideOnCapture) await window.api.showWindow();
      setBusy(false);
    }
  }, [source, busy, hideOnCapture, addShot]);

  /** Freezes the screen and opens the region picker. */
  const openRegion = useCallback(
    async (purpose: RegionPurpose) => {
      if (!source || busy) return;
      setBusy(true);
      try {
        if (hideOnCapture) await window.api.hideWindow();
        const raw = await window.api.captureScreen(source.id, source.width, source.height);
        if (hideOnCapture) await window.api.showWindow();
        const url = URL.createObjectURL(bytesToBlob(raw.data, 'image/png'));
        setFrozen({ url, width: raw.width, height: raw.height, purpose });
      } catch (err) {
        if (hideOnCapture) await window.api.showWindow();
        setStatus(`Blad przechwytywania: ${String(err)}`);
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
        await recorderRef.current.start(
          {
            sourceId: source.id,
            screenWidth: source.width,
            screenHeight: source.height,
            region,
            fps: q.fps,
            bitrate: q.bitrate,
            scale: q.scale,
          },
          () => {
            setStatus('Strumien ekranu zostal przerwany.');
          },
        );
        setElapsed(0);
        setRecording(true);
        setStatus(region ? 'Nagrywanie fragmentu ekranu.' : 'Nagrywanie calego ekranu.');
      } catch (err) {
        setStatus(`Nie udalo sie rozpoczac nagrywania: ${String(err)}`);
      }
    },
    [source, recording, quality],
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
        }),
      );
      setStatus(`Zapisano nagranie ${formatDuration(result.durationMs)}.`);
    } catch (err) {
      setRecording(false);
      setStatus(`Blad zatrzymania nagrywania: ${String(err)}`);
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
          setStatus(`Zapisano fragment ${result.width} x ${result.height}.`);
          closeFrozen();
        } else {
          closeFrozen();
          await startRecording(rect);
        }
      } catch (err) {
        setStatus(`Blad wyboru fragmentu: ${String(err)}`);
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
        setPlaying(shot);
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
    if (!window.confirm('Usunac wszystkie zrzuty i nagrania?')) return;
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.url));
      return [];
    });
    setStatus('Wyczyszczono sesje.');
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
      setStatus('Zapisano adnotacje.');
    },
    [],
  );

  const exportAll = useCallback(async () => {
    if (shots.length === 0) {
      setStatus('Nie ma czego eksportowac.');
      return;
    }
    setBusy(true);
    setStatus('Generowanie PDF...');
    try {
      const hasPdfContent = images.length > 0 || (videoPages && shots.some((s) => s.kind === 'video'));
      const pdf = hasPdfContent
        ? await buildPdf(shots, {
            title: `Dokumentacja ${stamp()}`,
            compress: compressPdf,
            includeVideoPages: videoPages,
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

      const result = await window.api.exportBundle(pdf, videos, `dokumentacja_${stamp()}.pdf`);
      if (!result) {
        setStatus('Eksport anulowany.');
        return;
      }
      setLastDir(result.pdfPath || result.dir);
      setStatus(
        `Zapisano: ${result.pdfPath}${result.videoPaths.length ? ` oraz ${result.videoPaths.length} nagran.` : '.'}`,
      );
      if (clearAfterExport) {
        setShots((prev) => {
          prev.forEach((s) => URL.revokeObjectURL(s.url));
          return [];
        });
      }
    } catch (err) {
      setStatus(`Blad eksportu: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [shots, images, videoPages, compressPdf, clearAfterExport]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (frozen || editorPos !== null || playing) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === 's') {
        event.preventDefault();
        void openRegion('shot');
      } else if (event.ctrlKey && key === 's') {
        event.preventDefault();
        void captureFull();
      } else if (event.ctrlKey && key === 'r') {
        event.preventDefault();
        if (recording) void stopRecording();
        else void startRecording(null);
      } else if (event.ctrlKey && key === 'e') {
        event.preventDefault();
        void exportAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    frozen,
    editorPos,
    playing,
    recording,
    openRegion,
    captureFull,
    startRecording,
    stopRecording,
    exportAll,
  ]);

  const editing = editorPos !== null ? images[editorPos] ?? null : null;

  return (
    <div className="app">
      <aside className="side">
        <h1>ScreenApp</h1>

        <label className="field">
          Ekran
          <select value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.primary ? ' (glowny)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="btn-group">
          <button className="primary" onClick={() => void captureFull()} disabled={busy}>
            Zrzut calego ekranu
            <kbd>Ctrl+S</kbd>
          </button>
          <button onClick={() => void openRegion('shot')} disabled={busy}>
            Zrzut fragmentu
            <kbd>Ctrl+Shift+S</kbd>
          </button>
        </div>

        <div className="btn-group">
          {recording ? (
            <button className="danger" onClick={() => void stopRecording()}>
              Zatrzymaj nagrywanie ({formatDuration(elapsed)})
              <kbd>Ctrl+R</kbd>
            </button>
          ) : (
            <>
              <button onClick={() => void startRecording(null)} disabled={busy}>
                Nagraj caly ekran
                <kbd>Ctrl+R</kbd>
              </button>
              <button onClick={() => void openRegion('record')} disabled={busy}>
                Nagraj fragment
              </button>
            </>
          )}
        </div>

        <label className="field">
          Jakosc nagrania
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

        <label className="check">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => setPreview(e.target.checked)}
          />
          Podglad na zywo
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={hideOnCapture}
            onChange={(e) => setHideOnCapture(e.target.checked)}
          />
          Ukryj okno podczas zrzutu
        </label>

        <div className="export">
          <label className="check">
            <input
              type="checkbox"
              checked={clearAfterExport}
              onChange={(e) => setClearAfterExport(e.target.checked)}
            />
            Wyczysc po zapisaniu PDF
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={compressPdf}
              onChange={(e) => setCompressPdf(e.target.checked)}
            />
            Kompresuj obrazy w PDF
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={videoPages}
              onChange={(e) => setVideoPages(e.target.checked)}
            />
            Strony z nagraniami w PDF
          </label>
          <button className="primary wide" onClick={() => void exportAll()} disabled={busy}>
            Zapisz PDF i nagrania
            <kbd>Ctrl+E</kbd>
          </button>
          {lastDir ? (
            <button className="link" onClick={() => void window.api.reveal(lastDir)}>
              Pokaz w folderze
            </button>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <PreviewPane source={source} enabled={preview && !recording} fps={12} />

        <div className="gallery-head">
          <span>
            Materialy: {images.length} zrzutow, {shots.length - images.length} nagran
          </span>
          <span className="spacer" />
          <button onClick={deleteAll} disabled={shots.length === 0}>
            Usun wszystko
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
              ? 'Zaznacz fragment do zrzutu'
              : 'Zaznacz fragment do nagrania'
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

      {playing ? (
        <div className="modal">
          <div className="modal-bar">
            <span>{playing.name}</span>
            <span className="spacer" />
            <button onClick={() => setPlaying(null)}>Zamknij</button>
          </div>
          <div className="modal-body">
            <video src={playing.url} controls autoPlay className="player" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
