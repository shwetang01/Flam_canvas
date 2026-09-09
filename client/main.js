/** @typedef {import('../shared/protocol.js').Point} Point */
/** @typedef {import('../shared/protocol.js').ServerMessage} ServerMessage */
/** @typedef {import('../shared/protocol.js').StrokeOp} StrokeOp */
/** @typedef {import('../shared/protocol.js').ToolName} ToolName */
/** @typedef {import('../shared/protocol.js').UserInfo} UserInfo */

import { CanvasRenderer } from "./canvas.js";
import { SocketClient } from "./websocket.js";

const CURSOR_THROTTLE_MS = 50;
const OUTGOING_POINT_CAP = 300;

/** @param {string} id @returns {HTMLElement} */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const container = /** @type {HTMLDivElement} */ ($("canvas-container"));
const committedCanvas = /** @type {HTMLCanvasElement} */ ($("committed-canvas"));
const liveCanvas = /** @type {HTMLCanvasElement} */ ($("live-canvas"));
const cursorLayer = /** @type {HTMLDivElement} */ ($("cursor-layer"));
const presenceList = /** @type {HTMLUListElement} */ ($("presence-list"));
const statusEl = /** @type {HTMLSpanElement} */ ($("connection-status"));
const hudEl = /** @type {HTMLDivElement} */ ($("hud"));
const undoBtn = /** @type {HTMLButtonElement} */ ($("undo-btn"));
const redoBtn = /** @type {HTMLButtonElement} */ ($("redo-btn"));
const colorInput = /** @type {HTMLInputElement} */ ($("color-picker"));
const sizeInput = /** @type {HTMLInputElement} */ ($("size-slider"));
const roomInput = /** @type {HTMLInputElement} */ ($("room-input"));
const roomJoinBtn = /** @type {HTMLButtonElement} */ ($("room-join-btn"));
const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));

const renderer = new CanvasRenderer(container, committedCanvas, liveCanvas);
window.addEventListener("resize", () => renderer.resize());

// ---- Room / connection setup ----

/** @param {string} raw @returns {string} */
function sanitizeRoomId(raw) {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "main";
}

const params = new URLSearchParams(location.search);
const roomId = sanitizeRoomId(params.get("room") ?? "main");
roomInput.value = roomId;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new SocketClient(`${wsProtocol}//${location.host}?room=${encodeURIComponent(roomId)}`);

// ---- App state ----

let myUserId = "";
let myColor = "#000000";
/** @type {StrokeOp[]} currently-visible ops only, sorted by seq */
let ops = [];
let redoAvailable = false; // best-effort UI hint only; server is authoritative
/** @type {Map<string, UserInfo>} */
const users = new Map();
/** @type {Map<string, HTMLDivElement>} */
const cursorEls = new Map();

/** @type {ToolName} */
let currentTool = "brush";
let currentColor = colorInput.value;
let currentSize = Number(sizeInput.value);

/** @typedef {{ id: string, pending: Point[] }} OwnStroke */
/** @type {OwnStroke | null} */
let ownStroke = null;
let outgoingRafHandle = null;
let lastCursorSentAt = 0;

/** @param {StrokeOp[]} list @param {StrokeOp} op @returns {StrokeOp[]} */
function insertSorted(list, op) {
  const next = list.filter((o) => o.id !== op.id);
  const idx = next.findIndex((o) => o.seq > op.seq);
  if (idx === -1) next.push(op);
  else next.splice(idx, 0, op);
  return next;
}

/** @param {PointerEvent} e @returns {Point} */
function canvasPoint(e) {
  const rect = liveCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, t: Date.now() };
}

// ---- Toolbar ----

/** @param {ToolName} tool */
function setTool(tool) {
  currentTool = tool;
  for (const btn of toolButtons) {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  }
}
for (const btn of toolButtons) {
  btn.addEventListener("click", () => setTool(/** @type {ToolName} */ (btn.dataset.tool)));
}
setTool(currentTool);

colorInput.addEventListener("input", () => (currentColor = colorInput.value));
sizeInput.addEventListener("input", () => (currentSize = Number(sizeInput.value)));

undoBtn.addEventListener("click", () => socket.send({ type: "undo:request" }));
redoBtn.addEventListener("click", () => socket.send({ type: "redo:request" }));

roomJoinBtn.addEventListener("click", () => {
  const target = sanitizeRoomId(roomInput.value);
  location.search = `?room=${encodeURIComponent(target)}`;
});

let statusFlashTimer = null;
/** @param {string} text */
function flashStatus(text) {
  statusEl.textContent = text;
  if (statusFlashTimer !== null) window.clearTimeout(statusFlashTimer);
  statusFlashTimer = window.setTimeout(() => {
    statusEl.textContent = "Connected";
  }, 1500);
}

// ---- Presence ----

function renderPresence() {
  presenceList.innerHTML = "";
  for (const user of users.values()) {
    const li = document.createElement("li");
    li.className = "presence-chip";
    li.innerHTML = `<span class="dot" style="background:${user.color}"></span>${user.name}${
      user.userId === myUserId ? " (you)" : ""
    }`;
    presenceList.appendChild(li);
  }
}

/** @param {UserInfo} user @returns {HTMLDivElement} */
function getOrCreateCursor(user) {
  let el = cursorEls.get(user.userId);
  if (!el) {
    el = document.createElement("div");
    el.className = "remote-cursor";
    el.innerHTML = `<span class="cursor-dot" style="background:${user.color}"></span><span class="cursor-label">${user.name}</span>`;
    cursorLayer.appendChild(el);
    cursorEls.set(user.userId, el);
  }
  return el;
}

/** @param {string} userId */
function removeCursor(userId) {
  cursorEls.get(userId)?.remove();
  cursorEls.delete(userId);
}

// ---- Outgoing point batching (flush once per animation frame) ----

function ensureOutgoingLoop() {
  if (outgoingRafHandle !== null) return;
  const tick = () => {
    if (ownStroke && ownStroke.pending.length > 0) {
      socket.send({ type: "stroke:points", strokeId: ownStroke.id, points: ownStroke.pending });
      ownStroke.pending = [];
    }
    if (ownStroke) {
      outgoingRafHandle = requestAnimationFrame(tick);
    } else {
      outgoingRafHandle = null;
    }
  };
  outgoingRafHandle = requestAnimationFrame(tick);
}

// ---- Pointer handling ----

liveCanvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  liveCanvas.setPointerCapture(e.pointerId);
  const strokeId = crypto.randomUUID();
  const point = canvasPoint(e);
  const style = { tool: currentTool, color: currentColor, size: currentSize };
  ownStroke = { id: strokeId, pending: [] };
  renderer.beginActiveStroke(strokeId, style, point);
  socket.send({ type: "stroke:start", strokeId, point, ...style });
  ensureOutgoingLoop();
});

liveCanvas.addEventListener("pointermove", (e) => {
  const point = canvasPoint(e);
  if (ownStroke) {
    renderer.appendActiveStrokePoints(ownStroke.id, [point]);
    ownStroke.pending.push(point);
    if (ownStroke.pending.length > OUTGOING_POINT_CAP) {
      socket.send({ type: "stroke:points", strokeId: ownStroke.id, points: ownStroke.pending });
      ownStroke.pending = [];
    }
  }
  const now = performance.now();
  if (now - lastCursorSentAt > CURSOR_THROTTLE_MS) {
    lastCursorSentAt = now;
    socket.send({ type: "cursor:move", x: point.x, y: point.y });
  }
});

/** @param {PointerEvent} e */
function endOwnStroke(e) {
  if (!ownStroke) return;
  liveCanvas.releasePointerCapture(e.pointerId);
  if (ownStroke.pending.length > 0) {
    socket.send({ type: "stroke:points", strokeId: ownStroke.id, points: ownStroke.pending });
    ownStroke.pending = [];
  }
  socket.send({ type: "stroke:end", strokeId: ownStroke.id });
  // Deliberately NOT removed from the renderer here — the server echoes
  // stroke:committed (or stroke:abort) back to the sender too, and that's
  // the single point where the live layer hands off to the committed layer.
  // Removing it eagerly here would risk a one-frame flicker if the ack is
  // still in flight.
  ownStroke = null;
}
liveCanvas.addEventListener("pointerup", endOwnStroke);
liveCanvas.addEventListener("pointercancel", endOwnStroke);

// ---- Incoming messages ----

function updateUndoRedoButtons() {
  redoBtn.disabled = !redoAvailable;
}

socket.onMessage = (msg) => {
  switch (msg.type) {
    case "state:sync": {
      myUserId = msg.userId;
      myColor = msg.color;
      users.clear();
      for (const u of msg.users) users.set(u.userId, u);
      ops = [...msg.opLog].sort((a, b) => a.seq - b.seq);
      redoAvailable = false;
      renderer.repaintCommitted(ops);
      renderPresence();
      updateUndoRedoButtons();
      colorInput.value = myColor;
      currentColor = myColor;
      break;
    }
    case "user:joined": {
      users.set(msg.user.userId, msg.user);
      renderPresence();
      break;
    }
    case "user:left": {
      users.delete(msg.userId);
      removeCursor(msg.userId);
      renderPresence();
      break;
    }
    case "stroke:start": {
      renderer.beginActiveStroke(msg.strokeId, { tool: msg.tool, color: msg.color, size: msg.size }, msg.point);
      break;
    }
    case "stroke:points": {
      renderer.appendActiveStrokePoints(msg.strokeId, msg.points);
      break;
    }
    case "stroke:committed": {
      ops = insertSorted(ops, msg.op);
      renderer.removeActiveStroke(msg.op.id);
      renderer.repaintCommitted(ops);
      redoAvailable = false;
      updateUndoRedoButtons();
      break;
    }
    case "stroke:abort": {
      renderer.removeActiveStroke(msg.strokeId);
      break;
    }
    case "undo:applied": {
      ops = ops.filter((o) => o.id !== msg.op.id);
      renderer.repaintCommitted(ops);
      redoAvailable = true;
      updateUndoRedoButtons();
      break;
    }
    case "redo:applied": {
      ops = insertSorted(ops, msg.op);
      renderer.repaintCommitted(ops);
      break;
    }
    case "undo:noop": {
      flashStatus("Nothing to undo");
      break;
    }
    case "redo:noop": {
      flashStatus("Nothing to redo");
      redoAvailable = false;
      updateUndoRedoButtons();
      break;
    }
    case "cursor:move": {
      const user = users.get(msg.userId);
      if (!user) break;
      const el = getOrCreateCursor(user);
      el.style.transform = `translate(${msg.x}px, ${msg.y}px)`;
      break;
    }
    case "error": {
      flashStatus(msg.message);
      break;
    }
  }
};

socket.onOpen = () => {
  statusEl.textContent = "Connected";
};
socket.onClose = () => {
  statusEl.textContent = "Reconnecting…";
};
socket.onLatency = (ms) => {
  hudEl.dataset.latency = String(Math.round(ms));
  refreshHud();
};

let lastFps = 0;
renderer.onFrame = (fps) => {
  lastFps = fps;
  refreshHud();
};
function refreshHud() {
  const latency = hudEl.dataset.latency ?? "–";
  hudEl.textContent = `FPS: ${Math.round(lastFps)}  ·  Latency: ${latency}ms`;
}
refreshHud();

// ---- Keyboard shortcuts ----

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && e.shiftKey) {
    e.preventDefault();
    socket.send({ type: "redo:request" });
  } else if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    socket.send({ type: "undo:request" });
  } else if (e.key === "Escape" && ownStroke) {
    // Cancels a still-in-progress stroke entirely (never committed, so it
    // can't interact with the undo/redo stack). Still has to reach the
    // server: stroke:start/points for it were already broadcast to other
    // clients, so they need the matching stroke:abort to clear their copy.
    socket.send({ type: "stroke:cancel", strokeId: ownStroke.id });
    renderer.removeActiveStroke(ownStroke.id);
    ownStroke = null;
  }
});

socket.connect();
