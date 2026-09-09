"use strict";

// Per-room drawing state: op log + global undo/redo. Undo/redo just flip an
// `undone` flag in place instead of moving the op, so redo restores a stroke
// to its original layering position instead of putting it back on top.
class DrawingState {
  constructor() {
    this.opLog = [];
    this.seqCounter = 0;
    this.redoStack = []; // undone op ids, most-recent last
    this.activeStrokes = new Map();
  }

  startStroke(id, userId, style, point) {
    // a duplicate stroke:start for the same id just resets the buffer
    this.activeStrokes.set(id, { id, userId, ...style, points: [point] });
  }

  appendPoints(id, points) {
    const active = this.activeStrokes.get(id);
    if (!active) return; // unknown or already-finished stroke — ignore
    active.points.push(...points);
  }

  commitStroke(id) {
    const active = this.activeStrokes.get(id);
    if (!active) return null;
    this.activeStrokes.delete(id);
    if (active.points.length === 0) return null;

    const op = {
      seq: ++this.seqCounter,
      id: active.id,
      userId: active.userId,
      tool: active.tool,
      color: active.color,
      size: active.size,
      points: active.points,
      undone: false,
    };
    this.opLog.push(op);
    this.redoStack = []; // a new action clears whatever could be redone
    return op;
  }

  // Used on disconnect: keep the partial stroke if it's real work, otherwise drop it.
  finalizeOrDiscard(id, minPoints = 2) {
    const active = this.activeStrokes.get(id);
    if (!active) return null;
    if (active.points.length >= minPoints) return this.commitStroke(id);
    this.activeStrokes.delete(id);
    return null;
  }

  abortStroke(id) {
    return this.activeStrokes.delete(id);
  }

  getActiveStrokeIds() {
    return [...this.activeStrokes.keys()];
  }

  // Undo/redo requests carry no target seq — the server resolves "top of
  // stack" itself, so two requests arriving close together can't race.
  requestUndo() {
    for (let i = this.opLog.length - 1; i >= 0; i--) {
      const op = this.opLog[i];
      if (!op.undone) {
        op.undone = true;
        this.redoStack.push(op.id);
        return op;
      }
    }
    return null;
  }

  requestRedo() {
    const id = this.redoStack.pop();
    if (id === undefined) return null;
    const op = this.opLog.find((o) => o.id === id);
    if (!op) return null; // id was in the redo stack but missing from the log — shouldn't happen
    op.undone = false;
    return op;
  }

  getVisibleOps() {
    return this.opLog.filter((op) => !op.undone);
  }

  getFullLog() {
    return this.opLog; // includes undone ops, so persistence keeps undo history across a restart
  }

  getRedoStack() {
    return this.redoStack;
  }

  loadSnapshot(opLog, redoStack) {
    this.opLog = opLog;
    this.redoStack = redoStack;
    this.seqCounter = opLog.reduce((max, op) => Math.max(max, op.seq), 0);
  }

  isEmpty() {
    return this.opLog.length === 0;
  }
}

module.exports = { DrawingState };
