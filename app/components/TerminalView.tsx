import React, { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { AgentMessage, ContentBlock } from '../state/types';
import { registerTerminalWriter, unregisterTerminalWriter } from '../utils/terminalBridge';

export interface TerminalViewHandle {
  write: (text: string) => void;
  blurInput: () => void;
}

interface TerminalViewProps {
  agentId: string;
  messages: AgentMessage[];
  onResize?: (cols: number, rows: number) => void;
  onInput?: (data: string) => void;
}

// Extract raw text from agent messages for terminal history replay
function extractTerminalText(messages: AgentMessage[]): string {
  let text = '';
  for (const msg of messages) {
    if (msg.type === 'user') {
      // User messages are commands — the PTY echoes them already
      // so they appear in assistant/stream content. Skip to avoid duplication.
      continue;
    }
    if (typeof msg.content === 'string') {
      text += msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
    }
  }
  return text;
}

// Escape text for safe injection into a JavaScript string literal.
// Must preserve ANSI escape sequences for xterm.js to interpret.
function escapeForJS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f]/g, (ch) => {
      // Preserve ANSI escape (0x1b) as literal for xterm to parse
      if (ch.charCodeAt(0) === 0x1b) return '\\x1b';
      const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
      return `\\x${hex}`;
    });
}

const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #13120a; }
  #terminal { width: 100%; height: 100%; }
  .xterm { padding: 8px; }
  /* Hide the native iOS blue caret on xterm's hidden input textarea */
  .xterm-helper-textarea {
    opacity: 0 !important;
    caret-color: transparent !important;
    -webkit-user-select: none !important;
  }
  /* iOS-native elastic/bounce scrolling for the terminal viewport */
  .xterm-viewport {
    -webkit-overflow-scrolling: touch !important;
  }
  .xterm-viewport::-webkit-scrollbar { width: 6px; }
  .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
  .xterm-viewport::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
</style>
</head>
<body>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"></script>
<script>
(function() {
  var term = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    disableStdin: false,
    scrollback: 5000,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    lineHeight: 1.15,
    theme: {
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
      brightWhite: '#ffffff'
    }
  });

  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));

  // GPU-accelerated rendering via WebGL (falls back to DOM renderer on failure)
  try {
    var webglAddon = new window.WebglAddon.WebglAddon();
    webglAddon.onContextLoss(function() {
      webglAddon.dispose();
    });
    term.loadAddon(webglAddon);
  } catch(e) {
    // WebGL not available — DOM renderer is fine
  }

  // Track last reported size to avoid spamming duplicate resize messages
  var lastCols = 0, lastRows = 0;

  // Robust fit: use ResizeObserver to detect when the container actually has
  // layout dimensions. The initial fit() often fires before the WebView has
  // real width/height, giving cols=1 and garbled output.
  function doFit() {
    var el = document.getElementById('terminal');
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
      try { fitAddon.fit(); } catch(e) {}
      // Report new dimensions to React Native so the PTY can be resized
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'resize', cols: term.cols, rows: term.rows
        }));
      }
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function(entries) {
      var rect = entries[0] && entries[0].contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        doFit();
      }
    });
    ro.observe(document.getElementById('terminal'));
  }

  // Fallback: staggered fit attempts cover edge cases where
  // ResizeObserver fires before fonts are loaded or layout settles.
  setTimeout(doFit, 50);
  setTimeout(doFit, 200);
  setTimeout(doFit, 600);

  window.addEventListener('resize', doFit);

  // Forward user keystrokes to React Native for PTY delivery
  term.onData(function(data) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'input', data: data
    }));
  });

  // Expose write function for injectJavaScript
  window.termWrite = function(text) {
    term.write(text);
  };

  // Signal ready to React Native
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
})();
</script>
</body>
</html>`;

// Stable source object — MUST live outside the component so the reference
// never changes. A new object on every render causes WebView to reload the
// page, which destroys xterm state, re-fires 'ready', re-replays history,
// and causes the "re-streaming" loop + crashes.
const XTERM_SOURCE = { html: XTERM_HTML };

const WRITE_BATCH_MS = 16; // ~60fps — batch rapid injectJavaScript calls

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ agentId, messages, onResize, onInput }, ref) {
    const webViewRef = useRef<WebView>(null);
    const readyRef = useRef(false);
    const pendingRef = useRef<string[]>([]);
    const onResizeRef = useRef(onResize);
    onResizeRef.current = onResize;
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    // Capture messages at mount for history replay — don't re-replay on updates
    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    // Write batching: accumulate text and flush once per frame to avoid
    // hammering injectJavaScript on every streamChunk (can be 100s/sec).
    const writeBufferRef = useRef('');
    const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushWrites = useCallback(() => {
      writeTimerRef.current = null;
      const buf = writeBufferRef.current;
      writeBufferRef.current = '';
      if (buf && webViewRef.current) {
        const escaped = escapeForJS(buf);
        webViewRef.current.injectJavaScript(`window.termWrite('${escaped}'); true;`);
      }
    }, []);

    const write = useCallback((text: string) => {
      if (!readyRef.current) {
        pendingRef.current.push(text);
        return;
      }
      writeBufferRef.current += text;
      if (!writeTimerRef.current) {
        writeTimerRef.current = setTimeout(flushWrites, WRITE_BATCH_MS);
      }
    }, [flushWrites]);

    const blurInput = useCallback(() => {
      webViewRef.current?.injectJavaScript('document.activeElement.blur(); true;');
    }, []);

    useImperativeHandle(ref, () => ({ write, blurInput }), [write, blurInput]);

    // Register/unregister in the direct-write bridge
    useEffect(() => {
      registerTerminalWriter(agentId, write);
      return () => {
        unregisterTerminalWriter(agentId);
        // Clean up pending timer on unmount
        if (writeTimerRef.current) {
          clearTimeout(writeTimerRef.current);
          writeTimerRef.current = null;
        }
      };
    }, [agentId, write]);

    // Handle messages from the WebView (xterm ready signal + resize reports)
    const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'ready') {
          readyRef.current = true;

          // Replay history from the messages snapshot at mount time
          const historyText = extractTerminalText(messagesRef.current);
          if (historyText) {
            const escaped = escapeForJS(historyText);
            webViewRef.current?.injectJavaScript(`window.termWrite('${escaped}'); true;`);
          }

          // Flush any writes that arrived before xterm was ready
          if (pendingRef.current.length > 0) {
            const combined = pendingRef.current.join('');
            pendingRef.current = [];
            const escaped = escapeForJS(combined);
            webViewRef.current?.injectJavaScript(`window.termWrite('${escaped}'); true;`);
          }
        } else if (data.type === 'input' && data.data) {
          onInputRef.current?.(data.data);
        } else if (data.type === 'resize' && data.cols && data.rows) {
          onResizeRef.current?.(data.cols, data.rows);
        }
      } catch {
        // ignore malformed messages
      }
    }, []); // No deps — uses refs for everything

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={XTERM_SOURCE}
          style={styles.webview}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={true}
          onMessage={handleMessage}
          containerStyle={containerBg}
        />
      </View>
    );
  }
);

// Stable style object for containerStyle to avoid re-renders
const containerBg = { backgroundColor: '#13120a' };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#13120a',
  },
  webview: {
    flex: 1,
    backgroundColor: '#13120a',
  },
});
