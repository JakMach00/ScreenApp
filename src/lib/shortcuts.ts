import type { ShortcutAction, ShortcutMap } from '../types';

/**
 * Defaults avoid two traps:
 * 1. Plain Ctrl combinations, because a global shortcut takes the key away
 *    from every other application (Ctrl+S would stop saving files elsewhere).
 * 2. Ctrl+Alt combinations, because AltGr on Polish, German and other
 *    international layouts sends Ctrl+Alt, so Ctrl+Alt+S would fire while the
 *    user is simply typing an accented character.
 */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  capture: 'Ctrl+Shift+F9',
  region: 'Ctrl+Shift+F10',
  record: 'Ctrl+Shift+F11',
  export: 'Ctrl+Shift+F12',
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  capture: 'Capture whole screen',
  region: 'Capture region',
  record: 'Start and stop recording',
  export: 'Save PDF and rec',
};

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'];

const KEY_ALIASES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Enter: 'Return',
  '+': 'Plus',
};

/**
 * Turns a keyboard event into an Electron accelerator, or null when the
 * combination cannot be registered globally.
 */
export function toAccelerator(event: React.KeyboardEvent | KeyboardEvent): string | null {
  const key = event.key;
  if (MODIFIER_KEYS.includes(key)) return null;
  if (key === 'Escape' || key === 'Tab') return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  let name = KEY_ALIASES[key] ?? key;
  if (/^[a-z]$/.test(name)) name = name.toUpperCase();
  // AltGr yields an accented character instead of a letter, so recover the
  // physical key from the event code to keep the accelerator readable.
  if (name.length === 1 && !/^[A-Z0-9]$/.test(name)) {
    const code = String(event.code || '');
    const match = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code);
    if (match) name = match[1];
  }

  const standalone = /^F\d{1,2}$/.test(name) || name === 'PrintScreen';
  if (parts.length === 0 && !standalone) return null;

  parts.push(name);
  return parts.join('+');
}

/**
 * True for combinations that AltGr also produces. On an international layout
 * these fire while typing, which is almost never what the user wants.
 */
export function conflictsWithAltGr(accelerator: string): boolean {
  return accelerator.includes('Ctrl+') && accelerator.includes('Alt+');
}

export function isDuplicate(map: ShortcutMap, action: ShortcutAction, accelerator: string): boolean {
  return (Object.keys(map) as ShortcutAction[]).some(
    (key) => key !== action && map[key] === accelerator,
  );
}

export function mergeShortcuts(stored: Partial<ShortcutMap> | null): ShortcutMap {
  return { ...DEFAULT_SHORTCUTS, ...(stored ?? {}) };
}
