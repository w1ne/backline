/** Diagnostics that only arm when the page is loaded with `?debug=1`.
 *  On a normal load nothing here runs and nothing is attached to `window`. */

export const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

export interface WsFrame {
  t: number;
  /** 'string' | 'Blob' | 'ArrayBuffer' | … — how the browser handed us the frame */
  kind: string;
  bytes: number;
  /** top-level keys of the parsed payload, i.e. the message shape */
  keys?: string[];
  head?: string;
  parseError?: string;
}

export interface ToggleEvent {
  t: number;
  inst: string;
  to: boolean;
  enabled: Record<string, boolean>;
}

export interface Rejection {
  t: number;
  reason: string;
  stack?: string;
}

const wsFrames: WsFrame[] = [];
const toggles: ToggleEvent[] = [];
const rejections: Rejection[] = [];

/** Records one `actions.toggle()` invocation, so a single click that fires the
 *  handler more than once is visible as more than one entry. */
export function recordToggle(inst: string, to: boolean, enabled: Record<string, boolean>): void {
  if (!DEBUG) return;
  toggles.push({ t: Date.now(), inst, to, enabled: { ...enabled } });
}

export function installDebug(api: Record<string, unknown>): void {
  if (!DEBUG) return;

  Object.defineProperties(api, {
    wsFrames: { value: wsFrames, enumerable: true },
    toggles: { value: toggles, enumerable: true },
    rejections: { value: rejections, enumerable: true },
  });
  (window as unknown as Record<string, unknown>).__backline = api;

  window.addEventListener('unhandledrejection', ev => {
    const reason = ev.reason as { stack?: string } | undefined;
    const entry: Rejection = { t: Date.now(), reason: String(reason), stack: reason?.stack };
    rejections.push(entry);
    console.error('UR', entry.reason, entry.stack);
  });

  patchWebSocket();
}

/** Wraps window.WebSocket so every inbound frame is logged before the
 *  @google/genai SDK's own listener sees it (ours is attached first). */
function patchWebSocket(): void {
  const Native = window.WebSocket;
  class LoggingWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (ev: MessageEvent) => record(ev.data));
    }
  }
  window.WebSocket = LoggingWebSocket as unknown as typeof WebSocket;
}

function record(data: unknown): void {
  const frame: WsFrame = { t: Date.now(), kind: kindOf(data), bytes: sizeOf(data) };
  wsFrames.push(frame);
  if (data instanceof Blob) {
    void data.text().then(
      text => annotate(frame, text),
      err => {
        frame.parseError = `blob.text(): ${String(err)}`;
      },
    );
  } else if (typeof data === 'string') {
    annotate(frame, data);
  }
}

function annotate(frame: WsFrame, text: string): void {
  frame.head = text.slice(0, 300);
  try {
    frame.keys = Object.keys(JSON.parse(text) as object);
  } catch (err) {
    frame.parseError = String(err);
  }
}

function kindOf(d: unknown): string {
  if (d instanceof Blob) return 'Blob';
  if (d instanceof ArrayBuffer) return 'ArrayBuffer';
  return typeof d;
}

function sizeOf(d: unknown): number {
  if (d instanceof Blob) return d.size;
  if (d instanceof ArrayBuffer) return d.byteLength;
  return typeof d === 'string' ? d.length : 0;
}
