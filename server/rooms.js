"use strict";

const fs = require("fs");
const path = require("path");
const { DrawingState } = require("./drawing-state");

const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
];

const DATA_DIR = path.join(__dirname, "..", "data", "rooms");
const PERSIST_DEBOUNCE_MS = 3000;
const IDLE_EVICTION_MS = 5 * 60 * 1000;

class Room {
  constructor(id) {
    this.id = id;
    this.drawingState = new DrawingState();
    this.clients = new Map();
    this.persistTimer = null;
    this.evictionTimer = null;
    this.nextColorIndex = 0;
    this.loadFromDisk();
  }

  snapshotPath() {
    return path.join(DATA_DIR, `${this.id}.json`);
  }

  loadFromDisk() {
    try {
      const raw = fs.readFileSync(this.snapshotPath(), "utf-8");
      const parsed = JSON.parse(raw);
      this.drawingState.loadSnapshot(parsed.opLog ?? [], parsed.redoStack ?? []);
    } catch {
      // no snapshot yet, or it's corrupt — just start fresh
    }
  }

  schedulePersist() {
    // debounced so a burst of strokes doesn't hammer disk on every op
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS);
  }

  persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const payload = JSON.stringify({
        opLog: this.drawingState.getFullLog(),
        redoStack: this.drawingState.getRedoStack(),
      });
      fs.writeFileSync(this.snapshotPath(), payload, "utf-8");
    } catch (err) {
      console.error(`[room ${this.id}] failed to persist snapshot:`, err);
    }
  }

  assignColor() {
    const color = PALETTE[this.nextColorIndex % PALETTE.length];
    this.nextColorIndex++;
    return color;
  }

  addClient(client) {
    if (this.evictionTimer) {
      clearTimeout(this.evictionTimer); // someone rejoined before the grace period ended
      this.evictionTimer = null;
    }
    this.clients.set(client.ws, client);
  }

  removeClient(ws) {
    const client = this.clients.get(ws);
    this.clients.delete(ws);
    return client;
  }

  isEmpty() {
    return this.clients.size === 0;
  }

  scheduleEvictionCheck(onEvict) {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    this.evictionTimer = setTimeout(() => {
      if (this.isEmpty()) onEvict();
    }, IDLE_EVICTION_MS);
  }

  userList() {
    return [...this.clients.values()].map((c) => ({
      userId: c.userId,
      color: c.color,
      name: c.name,
    }));
  }

  broadcast(message, exclude) {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.ws === exclude) continue;
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

// roomId comes straight from a URL query param, and ends up in a filename
// (snapshotPath) — strip anything that isn't safe for that.
function sanitizeRoomId(raw) {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "main";
}

// Display name is user-chosen free text -- trim it, cap the length, and
// drop control characters. The client renders it via textContent (never
// innerHTML), so this is hygiene, not the XSS defense; null means "no
// name given, caller should fall back."
function sanitizeName(raw) {
  const input = raw == null ? "" : String(raw);
  let cleaned = "";
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) cleaned += ch;
  }
  cleaned = cleaned.trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : null;
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  onClientLeft(room) {
    if (!room.isEmpty()) return;
    room.persistNow(); // flush to disk, then free the room if it stays empty
    room.scheduleEvictionCheck(() => this.rooms.delete(room.id));
  }
}

module.exports = { Room, RoomManager, sanitizeRoomId, sanitizeName };
