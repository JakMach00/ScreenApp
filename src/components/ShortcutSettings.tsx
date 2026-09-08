import { useEffect, useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  conflictsWithAltGr,
  isDuplicate,
  toAccelerator,
} from '../lib/shortcuts';
import type { ShortcutAction, ShortcutMap } from '../types';

interface Props {
  shortcuts: ShortcutMap;
  failed: string[];
  onChange: (next: ShortcutMap) => void;
  onClose: () => void;
}

const ACTIONS: ShortcutAction[] = ['capture', 'region', 'record', 'export'];

export default function ShortcutSettings({ shortcuts, failed, onChange, onClose }: Props) {
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // While a combination is being recorded the global shortcuts must be off,
  // otherwise pressing one would fire its action instead of being captured.
  useEffect(() => {
    if (capturing) void window.api.suspendShortcuts();
    else void window.api.resumeShortcuts();
  }, [capturing]);

  useEffect(() => {
    return () => {
      void window.api.resumeShortcuts();
    };
  }, []);

  const handleKey = (action: ShortcutAction, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setCapturing(null);
      setMessage(null);
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      onChange({ ...shortcuts, [action]: '' });
      setCapturing(null);
      setMessage('Shortcut cleared.');
      return;
    }

    const accelerator = toAccelerator(event);
    if (!accelerator) {
      setMessage('That combination cannot be a global shortcut. Use a modifier or a function key.');
      return;
    }
    if (isDuplicate(shortcuts, action, accelerator)) {
      setMessage(`${accelerator} is already assigned to another action.`);
      return;
    }
    onChange({ ...shortcuts, [action]: accelerator });
    setCapturing(null);
    setMessage(
      conflictsWithAltGr(accelerator)
        ? `${accelerator} is also produced by AltGr on international layouts, so it can fire while typing.`
        : null,
    );
  };

  return (
    <div className="modal">
      <div className="modal-bar">
        <span>Keyboard shortcuts</span>
        <span className="spacer" />
        <button onClick={() => onChange({ ...DEFAULT_SHORTCUTS })}>Restore defaults</button>
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="modal-body column">
        <table className="shortcuts">
          <tbody>
            {ACTIONS.map((action) => {
              const value = shortcuts[action];
              const notes: string[] = [];
              if (value && failed.includes(value)) notes.push('taken by another program');
              if (value && conflictsWithAltGr(value)) notes.push('collides with AltGr typing');
              return (
                <tr key={action}>
                  <td>{SHORTCUT_LABELS[action]}</td>
                  <td>
                    <button
                      className={capturing === action ? 'capture-key active' : 'capture-key'}
                      onClick={() => {
                        setCapturing(action);
                        setMessage(null);
                      }}
                      onKeyDown={(event) => {
                        if (capturing === action) handleKey(action, event);
                      }}
                    >
                      {capturing === action ? 'Press a combination...' : value || 'none'}
                    </button>
                  </td>
                  <td className="conflict">{notes.join(', ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="hint">
          These shortcuts are global and work while the window is minimized or in the background.
          Click a field, press the combination, Escape cancels, Delete clears the binding.
          Avoid Ctrl+Alt combinations: on Polish and other international layouts AltGr sends
          Ctrl+Alt, so AltGr+S would trigger a capture while typing an accented character.
          Windows also reserves some combinations for itself, Win+Shift+S among them, and no
          application can take those over.
        </p>
        {message ? <p className="warn">{message}</p> : null}
      </div>
    </div>
  );
}
