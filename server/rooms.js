"use strict";

const fs = require("fs");
const path = require("path");
const { DrawingState } = require("./drawing-state");

/** @typedef {import('../shared/protocol.js').ServerMessage} ServerMessage */
/** @typedef {import('../shared/protocol.js').UserInfo} UserInfo */

const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
];

const DATA_DIR = path.join(__dirname, "..", "data", "rooms");
const PERSIST_DEBOUNCE_MS = 3000;
const IDLE_EVICTION_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} ClientInfo
 * @property {import('ws').WebSocket} ws
 * @property {string} userId
 * @property {string} color
 * @property {string} name
 * @property {Set<string>} activeStrokeIds
 * @property {number} lastMessageAt
 */

class Room {
  /** @param {string} id */
  constructor(id) {
    this.id = id;
    this.drawingState = new DrawingState();
    /** @type {Map<import('ws').WebSocket, ClientInfo>} */
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
      // No snapshot yet, or it's unreadable/corrupt — start fresh. This is a
      // best-effort convenience cache, not a durable store, so a missing or
      // bad file is never treated as an error.
    }
  }

  /** Debounced so a burst of strokes doesn't hammer disk on every op. */
  schedulePersist() {
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

  /** @returns {string} */
  assignColor() {
    const color = PALETTE[this.nextColorIndex % PALETTE.length];
    this.nextColorIndex++;
    return color;
  }

  /** @param {ClientInfo} client */
  addClient(client) {
    if (this.evictionTimer) {
      clearTimeout(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.clients.set(client.ws, client);
  }

  /** @param {import('ws').WebSocket} ws @returns {ClientInfo | undefined} */
  removeClient(ws) {
    const client = this.clients.get(ws);
    this.clients.delete(ws);
    return client;
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.clients.size === 0;
  }

  /** @param {() => void} onEvict */
  scheduleEvictionCheck(onEvict) {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    this.evictionTimer = setTimeout(() => {
      if (this.isEmpty()) onEvict();
    }, IDLE_EVICTION_MS);
  }

  /** @returns {UserInfo[]} */
  userList() {
    return [...this.clients.values()].map((c) => ({
      userId: c.userId,
      color: c.color,
      name: c.name,
    }));
  }

  /**
   * @param {ServerMessage} message
   * @param {import('ws').WebSocket} [exclude]
   */
  broadcast(message, exclude) {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.ws === exclude) continue;
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {ServerMessage} message
   */
  send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

/**
 * roomId comes straight from a URL query param — never let it reach a
 * filesystem path unsanitized.
 * @param {string | null | undefined} raw
 * @returns {string}
 */
function sanitizeRoomId(raw) {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "main";
}

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /** @param {string} roomId @returns {Room} */
  getOrCreate(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Call after a client leaves; evicts the room from memory (after a final
   *  flush to disk) if it stays empty past the idle grace period.
   *  @param {Room} room */
  onClientLeft(room) {
    if (!room.isEmpty()) return;
    room.persistNow();
    room.scheduleEvictionCheck(() => this.rooms.delete(room.id));
  }
}

module.exports = { Room, RoomManager, sanitizeRoomId };
