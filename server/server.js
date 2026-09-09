"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { RoomManager, sanitizeRoomId, sanitizeName } = require("./rooms");

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.join(__dirname, "..", "client");

const MAX_MESSAGES_PER_SECOND = 200;
const STALE_CONNECTION_MS = 45_000;
const LIVENESS_SWEEP_MS = 15_000;
const MAX_POINTS_PER_MESSAGE = 500;
const MAX_JSON_PARSE_FAILURES = 5;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveStatic(req, res) {
  const urlPath = (req.url ?? "/").split("?")[0];
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(CLIENT_DIR, safeRel);

  if (!filePath.startsWith(CLIENT_DIR)) {
    // resolved outside CLIENT_DIR — someone tried a path traversal
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer });
const roomManager = new RoomManager();
const connections = new Map();

function isValidPoint(p) {
  if (typeof p !== "object" || p === null) return false;
  return typeof p.x === "number" && typeof p.y === "number" && typeof p.t === "number";
}

function isValidStyle(tool, color, size) {
  return (
    (tool === "brush" || tool === "eraser") &&
    typeof color === "string" &&
    color.length <= 32 &&
    typeof size === "number" &&
    size > 0 &&
    size <= 200
  );
}

function sendError(ws, code, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "error", code, message }));
  }
}

function handleMessage(ws, state, msg) {
  const { room, client } = state;
  client.lastMessageAt = Date.now();

  switch (msg.type) {
    case "stroke:start": {
      if (typeof msg.strokeId !== "string" || !isValidPoint(msg.point)) return;
      if (!isValidStyle(msg.tool, msg.color, msg.size)) return;
      room.drawingState.startStroke(
        msg.strokeId,
        client.userId,
        { tool: msg.tool, color: msg.color, size: msg.size },
        msg.point,
      );
      client.activeStrokeIds.add(msg.strokeId);
      room.broadcast(
        {
          type: "stroke:start",
          strokeId: msg.strokeId,
          userId: client.userId,
          tool: msg.tool,
          color: msg.color,
          size: msg.size,
          point: msg.point,
        },
        ws,
      );
      return;
    }

    case "stroke:points": {
      if (typeof msg.strokeId !== "string" || !Array.isArray(msg.points)) return;
      if (!client.activeStrokeIds.has(msg.strokeId)) return;
      const points = msg.points.slice(0, MAX_POINTS_PER_MESSAGE).filter(isValidPoint);
      if (points.length === 0) return;
      room.drawingState.appendPoints(msg.strokeId, points);
      room.broadcast({ type: "stroke:points", strokeId: msg.strokeId, points }, ws);
      return;
    }

    case "stroke:end": {
      if (typeof msg.strokeId !== "string" || !client.activeStrokeIds.has(msg.strokeId)) return;
      client.activeStrokeIds.delete(msg.strokeId);
      const op = room.drawingState.commitStroke(msg.strokeId);
      if (op) {
        room.broadcast({ type: "stroke:committed", op });
        room.schedulePersist();
      } else {
        room.broadcast({ type: "stroke:abort", strokeId: msg.strokeId, reason: "invalid" });
      }
      return;
    }

    case "stroke:cancel": {
      if (typeof msg.strokeId !== "string" || !client.activeStrokeIds.has(msg.strokeId)) return;
      client.activeStrokeIds.delete(msg.strokeId);
      room.drawingState.abortStroke(msg.strokeId);
      room.broadcast({ type: "stroke:abort", strokeId: msg.strokeId, reason: "invalid" });
      return;
    }

    case "cursor:move": {
      if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
      room.broadcast({ type: "cursor:move", userId: client.userId, x: msg.x, y: msg.y }, ws);
      return;
    }

    case "undo:request": {
      const op = room.drawingState.requestUndo();
      if (op) {
        room.broadcast({ type: "undo:applied", op });
        room.schedulePersist();
      } else {
        room.send(ws, { type: "undo:noop" });
      }
      return;
    }

    case "redo:request": {
      const op = room.drawingState.requestRedo();
      if (op) {
        room.broadcast({ type: "redo:applied", op });
        room.schedulePersist();
      } else {
        room.send(ws, { type: "redo:noop" });
      }
      return;
    }

    case "ping": {
      const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
      room.send(ws, { type: "pong", ts });
      return;
    }

    default:
      return;
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const roomId = sanitizeRoomId(url.searchParams.get("room"));
  const room = roomManager.getOrCreate(roomId);

  const userId = crypto.randomUUID();
  const color = room.assignColor();
  const name = sanitizeName(url.searchParams.get("name")) ?? `Guest-${userId.slice(0, 4)}`;
  const client = {
    ws,
    userId,
    color,
    name,
    activeStrokeIds: new Set(),
    lastMessageAt: Date.now(),
  };
  room.addClient(client);

  const state = { room, client, messageCount: 0, windowStart: Date.now(), jsonFailures: 0 };
  connections.set(ws, state);

  room.send(ws, {
    type: "state:sync",
    userId,
    color,
    users: room.userList(),
    opLog: room.drawingState.getVisibleOps(),
  });
  room.broadcast({ type: "user:joined", user: { userId, color, name } }, ws);

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - state.windowStart > 1000) {
      state.windowStart = now;
      state.messageCount = 0;
    }
    state.messageCount++;
    if (state.messageCount > MAX_MESSAGES_PER_SECOND) return; // over the cap — drop, don't disconnect

    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      state.jsonFailures++;
      if (state.jsonFailures > MAX_JSON_PARSE_FAILURES) {
        sendError(ws, "TOO_MANY_MALFORMED", "Too many malformed messages");
        ws.close();
      }
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
      return;
    }
    try {
      handleMessage(ws, state, parsed);
    } catch (err) {
      console.error(`[room ${roomId}] error handling message from ${userId}:`, err);
    }
  });

  ws.on("close", () => {
    connections.delete(ws);
    const info = room.removeClient(ws);
    if (info) {
      // finish or drop whatever this client was mid-stroke on, so other
      // clients don't keep a ghost of an unfinished stroke on their live layer
      for (const strokeId of info.activeStrokeIds) {
        const op = room.drawingState.finalizeOrDiscard(strokeId);
        if (op) {
          room.broadcast({ type: "stroke:committed", op });
        } else {
          room.broadcast({ type: "stroke:abort", strokeId, reason: "disconnect" });
        }
      }
      room.broadcast({ type: "user:left", userId: info.userId });
    }
    roomManager.onClientLeft(room);
  });

  ws.on("error", () => {}); // 'close' fires right after and does the cleanup
});

// A healthy connection pings every ~15s, so anything quieter than this for a
// while is dead and just hasn't told us yet.
setInterval(() => {
  const now = Date.now();
  for (const [ws, state] of connections) {
    if (now - state.client.lastMessageAt > STALE_CONNECTION_MS) {
      ws.terminate();
    }
  }
}, LIVENESS_SWEEP_MS);

httpServer.listen(PORT, () => {
  console.log(`Collaborative canvas server listening on http://localhost:${PORT}`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
