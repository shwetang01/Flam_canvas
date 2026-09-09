/** @typedef {import('../shared/protocol.js').ClientMessage} ClientMessage */
/** @typedef {import('../shared/protocol.js').ServerMessage} ServerMessage */

const PING_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Thin wrapper around the native browser WebSocket — deliberately not the
 * socket.io client, to keep the client dependency-free in the same spirit as
 * "no drawing libraries," even though the server may use socket.io. Handles
 * JSON encode/decode, reconnect with exponential backoff, and a
 * client-initiated ping that doubles as latency measurement and as proof of
 * liveness for the server's stale-connection sweep.
 */
export class SocketClient {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.reconnectAttempt = 0;
    this.pingTimer = null;
    this.deliberatelyClosed = false;

    /** @type {((msg: ServerMessage) => void) | null} */
    this.onMessage = null;
    /** @type {(() => void) | null} */
    this.onOpen = null;
    /** @type {(() => void) | null} */
    this.onClose = null;
    /** @type {((ms: number) => void) | null} */
    this.onLatency = null;
  }

  connect() {
    this.deliberatelyClosed = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.startPing();
      this.onOpen?.();
    });

    ws.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === "pong") {
        this.onLatency?.(Date.now() - parsed.ts);
        return;
      }
      this.onMessage?.(parsed);
    });

    ws.addEventListener("close", () => {
      this.stopPing();
      this.onClose?.();
      if (!this.deliberatelyClosed) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // 'close' always follows; nothing extra to do here.
    });
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }

  startPing() {
    this.pingTimer = window.setInterval(() => {
      this.send({ type: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** @param {ClientMessage} msg */
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.deliberatelyClosed = true;
    this.ws?.close();
  }
}
