import { useEffect, useRef } from 'react';
import type { AgentMessage, ContentBlock } from '@shared/types';
import type { ITheme } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';

// Direct-write registry: allows streamChunk handler to write to terminal
// without going through React state, eliminating rendering latency.
const terminalWriters = new Map<string, (text: string) => void>();

export function registerTerminalWriter(agentId: string, writer: (text: string) => void): void {
  terminalWriters.set(agentId, writer);
}

export function unregisterTerminalWriter(agentId: string): void {
  terminalWriters.delete(agentId);
}

export function writeToTerminal(agentId: string, text: string): boolean {
  const writer = terminalWriters.get(agentId);
  if (writer) {
    writer(text);
    return true;
  }
  return false;
}

// Focus registry: allows parent components to focus the xterm terminal
const terminalFocusers = new Map<string, () => void>();

export function registerTerminalFocuser(agentId: string, focuser: () => void): void {
  terminalFocusers.set(agentId, focuser);
}

export function unregisterTerminalFocuser(agentId: string): void {
  terminalFocusers.delete(agentId);
}

export function focusTerminal(agentId: string): void {
  terminalFocusers.get(agentId)?.();
}

// Full ANSI color palettes for dark and light themes.
const DARK_THEME: ITheme = {
  background: '#13120a',
  foreground: '#edecec',
  cursor: '#edecec',
  cursorAccent: '#13120a',
  selectionBackground: 'rgba(255,255,255,0.18)',
  selectionForeground: '#ffffff',
  black: '#1d1d1d',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#5a9bf0',
  magenta: '#c084fc',
  cyan: '#17c6b2',
  white: '#e5e5e5',
  brightBlack: '#8a8980',
  brightRed: '#f87171',
  brightGreen: '#86efac',
  brightYellow: '#e6b828',
  brightBlue: '#60a5fa',
  brightMagenta: '#d8b4fe',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

const LIGHT_THEME: ITheme = {
  background: '#f7f7f4',
  foreground: '#26251e',
  cursor: '#26251e',
  cursorAccent: '#f7f7f4',
  selectionBackground: 'rgba(0,0,0,0.15)',
  selectionForeground: '#000000',
  black: '#26251e',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#a16207',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#d4d4d4',
  brightBlack: '#6e6d65',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#ca8a04',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#f5f5f5',
};

/** Read a CSS custom property from :root. */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Detect current app theme from CSS variables and return the matching palette. */
function getTerminalTheme(): ITheme {
  const bg = getCssVar('--bg');
  const isLight = bg.startsWith('#f') || bg.startsWith('#e') || bg.startsWith('#d');
  const palette = isLight ? { ...LIGHT_THEME } : { ...DARK_THEME };
  if (bg) palette.background = bg;
  const fg = getCssVar('--text');
  if (fg) {
    palette.foreground = fg;
    palette.cursor = fg;
  }
  return palette;
}

interface XtermTerminalProps {
  agentId: string;
  messages: AgentMessage[];
  onWrite: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

function extractTextBlockContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function XtermTerminal({ agentId, messages, onWrite, onResize }: XtermTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });

  // Use refs for callbacks so the terminal isn't torn down on every render
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);
  useEffect(() => { onWriteRef.current = onWrite; }, [onWrite]);
  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

  // Mount xterm once and register direct writer
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Clear any leftover DOM from a previous terminal instance.
    // Protects against React StrictMode double-mount or Vite HMR leaving
    // stale xterm textareas/canvases that would duplicate keyboard input.
    host.innerHTML = '';

    // Read the monospace font stack from the CSS variable so the terminal
    // matches code/mono text elsewhere in the app.
    const monoFamily = getCssVar('--mono')
      || 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      disableStdin: false,
      allowTransparency: false,
      scrollback: 5000,
      fontFamily: monoFamily,
      fontSize: 13,
      fontWeight: '400',
      fontWeightBold: '700',
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: 1,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Use canvas renderer instead of DOM renderer — positions text at exact
    // pixel coordinates like native terminals (Ghostty, iTerm2), eliminating
    // the line gap caused by browser DOM text layout.
    const canvasAddon = new CanvasAddon();
    terminal.open(host);
    terminal.loadAddon(canvasAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Sync terminal theme whenever the app's CSS variables change (light/dark toggle).
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = getTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });

    // Register direct writer for zero-latency PTY output
    registerTerminalWriter(agentId, (text: string) => {
      terminal.write(text);
    });

    // Register focuser so parent pane can focus the terminal on click
    registerTerminalFocuser(agentId, () => {
      terminal.focus();
    });

    // Write any existing messages (e.g. after HMR reload)
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue;
      if (typeof msg.content === 'string') {
        terminal.write(msg.content);
      } else if (Array.isArray(msg.content)) {
        terminal.write(extractTextBlockContent(msg.content));
      }
    }

    // Ensure xterm's textarea is interactable (Tauri webview + global user-select:none)
    const textarea = host.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.style.userSelect = 'text';
      textarea.style.webkitUserSelect = 'text';
    }

    const emitResize = () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (cols <= 0 || rows <= 0) return;
      if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return;
      lastSizeRef.current = { cols, rows };
      onResizeRef.current(cols, rows);
    };

    const fitAndResize = () => {
      try {
        fitAddon.fit();
      } catch { /* container may not have dimensions yet */ }
      emitResize();
    };

    // Capture user input and forward to the PTY via WebSocket
    const dataDisposable = terminal.onData((data: string) => {
      onWriteRef.current(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitAndResize);
    });
    resizeObserver.observe(host);

    // Focus on mousedown — fires before click, before browser moves focus.
    const focusTerminal = () => {
      terminal.focus();
    };
    host.addEventListener('mousedown', focusTerminal);

    // Prevent keyboard events from bubbling to parent handlers (dnd-kit, App.tsx shortcuts).
    const stopKeyBubble = (e: KeyboardEvent) => {
      e.stopPropagation();
    };
    host.addEventListener('keydown', stopKeyBubble);

    // Delay initial fit+focus to ensure DOM layout is complete
    const initTimer = setTimeout(() => {
      fitAndResize();
      terminal.focus();
    }, 100);

    return () => {
      clearTimeout(initTimer);
      unregisterTerminalWriter(agentId);
      unregisterTerminalFocuser(agentId);
      themeObserver.disconnect();
      host.removeEventListener('mousedown', focusTerminal);
      host.removeEventListener('keydown', stopKeyBubble);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      canvasAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSizeRef.current = { cols: 0, rows: 0 };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable mount, callbacks via refs
  }, [agentId]);

  return (
    <div
      ref={hostRef}
      className="xterm-host"
      tabIndex={-1}
      style={{ userSelect: 'text' }}
    />
  );
}
