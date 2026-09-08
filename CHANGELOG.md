# Changelog

## 1.7.2

- No sidebar action is styled as preselected any more. The accent is left to the export button
  and to the first action in the empty workspace.
- The export button reads "Save PDF", or "Save recordings" for a recordings only session, and
  stays disabled until something has been captured. The longer label did not fit next to the
  shortcut badge. Recordings are still written next to the PDF.

## 1.7.1

- The Capture full screen button in the sidebar is no longer filled with the accent colour. A
  filled button among a stack of plain ones reads as a selected state rather than as emphasis.
  The accent now marks only the export action and the call to action in the empty workspace.

## 1.7.2

- No sidebar action is styled as preselected any more. The accent is left to the export button
  and to the first action in the empty workspace.
- The export button reads "Save PDF", or "Save recordings" for a recordings only session, and
  stays disabled until something has been captured. The longer label did not fit next to the
  shortcut badge. Recordings are still written next to the PDF.

## 1.7.1

- Every option carrying an explanation now shows a small info icon, so it is obvious that
  hovering it says what the option does. Focusing the icon shows the same text without a mouse.
- Restored the accent on the main capture action, which had been lost with the mode switch.

## 1.7.0

Interface only, no change to capture, recording, export, shortcuts or IPC.

- Split the window into a title bar, sidebar, workspace and status bar, with the sidebar and the
  workspace scrolling independently.
- Grouped the sidebar into Source, Capture, Recording, Output, Export and Utilities, numbered by
  a CSS counter so the mode switch cannot put the numbers out of order.
- Replaced the mode switch and the brand mark in the title bar with an animated light and dark
  toggle. The empty workspace offers both capture and record as first actions.
- Reworked the empty workspace: what to do next, the primary action with its shortcut, and the
  display, audio and quality currently in use.
- Moved to a single lime accent used only for the primary action, active states and positive
  status, with consistent button heights and visible hover, focus, disabled and checked states.
- Replaced the native confirm on Delete all with an in-app dialog that says what will be removed.
- Editor: clicking an existing step or text label with the same tool active moves it instead of
  creating another one on top.
- Editor: undoing or deleting the most recent step returns its number to the sequence.
- Editor: the highlighter starts yellow.

## 1.6.0

- Checks GitHub at startup for a newer release and offers a link to the release page. Nothing is
  downloaded or installed.
- The check runs through the main process so it follows system proxy settings, times out after
  eight seconds, and stays silent on failure unless it was started by hand.
- A dismissed version is not announced again, and the check can be switched off entirely.
- Manual "Check for updates" button in the sidebar.
- PDF pages now hold the screenshot and nothing else, with no file name and no timestamp header.
- Recordings no longer produce PDF pages, they are exported as files only.
- The screen list is rebuilt when a display changes resolution or is added or removed, instead
  of staying stale until the next restart.
- No sidebar button looks preselected on launch.
- Tooltips appear after one second and next to the control rather than in the corner of the
  screen.

## 1.5.0

- Recordings can be exported without a PDF. With no screenshots the export button switches to
  recordings only, and when both are present a separate button writes just the clips.
- Recordings exported on their own keep their own file names and go to a folder of your choice.
- Every sidebar option explains itself in a tooltip after a two second hover.
- The running version is shown in the bottom right corner, read from package.json at build time.

## 1.4.0

- Recordings can be written as MP4 (H.264), which Windows Media Player Legacy can open, or as
  WebM (VP9) for smaller files. MP4 is the default.
- MP4 support is checked at runtime and falls back to WebM with a note when the H.264 encoder is
  missing, instead of failing the recording.
- Exported file names and the speed conversion follow the container the clip was recorded in.

## 1.3.0

- Audio recording from the Windows default devices: microphone, system audio through loopback,
  or both mixed. Off by default.
- Audio problems degrade to a silent recording with a reason on the status bar instead of
  aborting the capture.
- The speed conversion keeps the audio track and holds its pitch.
- The Mute toggle is disabled and labelled for clips that carry no audio track.

## 1.2.0

- Recordings can be sped up to 1.1x, 1.25x, 1.5x, 1.75x or 2x. The speed row changes the preview
  instantly, and applying it re-encodes the file so exports really are shorter.
- Conversion runs at playback speed with a progress figure and only replaces the clip once the
  new file exists.
- Mute toggle in the player. Recordings contain no audio track, so it affects playback only.

## 1.1.0

- Fixed "Open output folder", which used `shell.showItemInFolder` and failed silently on
  Windows. It now opens the folder through `shell.openPath` and reports any error.
- Added an optional fixed export folder. It is off by default, so the save dialog keeps
  appearing until the option is switched on and a folder is picked.
- Exports no longer overwrite: a name already in use gets a counter.
- If the chosen folder is unavailable, the export falls back to the dialog and says so.

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
- Optional fixed export folder, off by default, which skips the save dialog while it is set.
- Exports never overwrite: a name already in use gets a counter.

### Interface and shortcuts

- Global shortcuts that work while the window is minimized, rebindable in the application.
- Defaults avoid plain Ctrl combinations, which a global shortcut would take away from every
  other application, and Ctrl+Alt combinations, which AltGr reproduces on international
  keyboard layouts.
- Dark and light theme following the system preference on first run.

### Build

- Packaged with electron-builder into a zip holding the complete ready to run app folder.
- GitHub Actions workflow building and publishing on `v*` tags.
