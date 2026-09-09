const PING_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 10_000;

// Thin wrapper around the native WebSocket: JSON in/out, reconnect with
// backoff, and a client-initiated ping used for both latency and liveness.
export class SocketClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.reconnectAttempt = 0;
    this.pingTimer = null;
    this.deliberatelyClosed = false;

    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
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

    // 'close' always fires right after 'error', so cleanup lives there.
    ws.addEventListener("error", () => {});
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
