# Changelog

## 1.0.0

First public release.

### Capture

- Screenshots of a selected screen at native resolution through `desktopCapturer`,
  so the image is not resampled by the WebRTC pipeline.
- Region capture performed on a frozen frame, which keeps the selection precise
  because the image does not move while it is being selected.
- Screen list built by the application rather than taken from `source.name`, which
  the operating system returns localized.
- Screenshots taken with a shortcut never pull the window to the front: a minimized
  window stays minimized and a background window comes back unfocused.
- The window is not hidden at all when it sits on a different monitor than the one
  being captured.

### Recording

- Screen recording through `MediaRecorder` with VP9 and an explicit bitrate, in three
  size profiles. Region recording goes through a canvas pipeline.
- Fallback from `getUserMedia` desktop constraints to `getDisplayMedia`, served by
  `setDisplayMediaRequestHandler`, so a change in Electron cannot break capture outright.
- `backgroundThrottling` disabled so the recording loop keeps its frame rate while the
  window is minimized.

### Annotation

- Canvas editor with arrows, boxes, ellipses, numbered steps, text, highlight and redaction.
- Annotations stay editable after they are drawn: handles reshape a selection, and colour,
  thickness, step number and text apply to the selected item live.
- Leaving a screenshot with unsaved annotations asks whether to save, discard or stay.

### Export

- PDF export with one page per screenshot, orientation derived from the image, and a page
  per recording carrying its first frame and length.
- Recordings written as separate files next to the PDF, because embedding playable video in
  a PDF only works in Adobe Acrobat.
- Optional clearing of the session after a successful export, remembered between runs.

### Interface and shortcuts

- Global shortcuts that work while the window is minimized, rebindable in the application.
- Defaults avoid plain Ctrl combinations, which a global shortcut would take away from every
  other application, and Ctrl+Alt combinations, which AltGr reproduces on international
  keyboard layouts.
- Dark and light theme following the system preference on first run.

### Build

- Packaged with electron-builder into a zip holding the complete ready to run app folder.
- GitHub Actions workflow building and publishing on `v*` tags.
