"use strict";

/** @typedef {import('../shared/protocol.js').Point} Point */
/** @typedef {import('../shared/protocol.js').StrokeStyle} StrokeStyle */
/** @typedef {import('../shared/protocol.js').StrokeOp} StrokeOp */

/**
 * Per-room drawing state: the authoritative, server-ordered op log plus the
 * global undo/redo stacks. This is the single piece of state that makes
 * "global undo/redo across all users" well-defined: every client renders the
 * exact same opLog in the exact same seq order, and undo/redo only ever flip
 * an `undone` flag in place — they never move an op's position in the array.
 * That in-place toggle is what lets redo restore a stroke to its original
 * layering position instead of re-appending it on top.
 */
class DrawingState {
  constructor() {
    /** @type {StrokeOp[]} */
    this.opLog = [];
    this.seqCounter = 0;
    /** ids of undone ops, most-recently-undone last (a LIFO redo stack)
     *  @type {string[]} */
    this.redoStack = [];
    /** @type {Map<string, StrokeStyle & {id: string, userId: string, points: Point[]}>} */
    this.activeStrokes = new Map();
  }

  /**
   * @param {string} id
   * @param {string} userId
   * @param {StrokeStyle} style
   * @param {Point} point
   */
  startStroke(id, userId, style, point) {
    // Defensive: a stray duplicate stroke:start (e.g. client retry) just
    // resets the buffer for that id rather than creating two trackers.
    this.activeStrokes.set(id, { id, userId, ...style, points: [point] });
  }

  /**
   * @param {string} id
   * @param {Point[]} points
   */
  appendPoints(id, points) {
    const active = this.activeStrokes.get(id);
    if (!active) return; // already committed/aborted, or unknown id — ignore
    active.points.push(...points);
  }

  /**
   * @param {string} id
   * @returns {StrokeOp | null} the finalized op, or null if there was nothing
   *   to commit (unknown/duplicate id, or an empty stroke).
   */
  commitStroke(id) {
    const active = this.activeStrokes.get(id);
    if (!active) return null;
    this.activeStrokes.delete(id);
    if (active.points.length === 0) return null;

    /** @type {StrokeOp} */
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
    // A new committed action invalidates whatever could previously be redone.
    // No await between the check and the clear anywhere in this method, so
    // there's no window where two calls could interleave on this field.
    this.redoStack = [];
    return op;
  }

  /**
   * Auto-commits a partial stroke (used when a client disconnects mid-stroke
   * with enough points to be real work) or discards it.
   * @param {string} id
   * @param {number} [minPoints]
   * @returns {StrokeOp | null}
   */
  finalizeOrDiscard(id, minPoints = 2) {
    const active = this.activeStrokes.get(id);
    if (!active) return null;
    if (active.points.length >= minPoints) return this.commitStroke(id);
    this.activeStrokes.delete(id);
    return null;
  }

  /** @param {string} id @returns {boolean} */
  abortStroke(id) {
    return this.activeStrokes.delete(id);
  }

  /** @returns {string[]} */
  getActiveStrokeIds() {
    return [...this.activeStrokes.keys()];
  }

  /**
   * Global undo: flips the most recent non-undone op, regardless of author.
   * Intent-only by design — callers never pass a target seq, so there is
   * nothing for two racing requests to disagree about; Node's single
   * message-at-a-time processing means the second call simply observes the
   * state left by the first.
   * @returns {StrokeOp | null}
   */
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

  /**
   * Global redo: restores the most recently undone op IN PLACE (same seq,
   * same array position), so it reappears at its original layering order
   * rather than jumping to the top.
   * @returns {StrokeOp | null}
   */
  requestRedo() {
    const id = this.redoStack.pop();
    if (id === undefined) return null;
    const op = this.opLog.find((o) => o.id === id);
    if (!op) return null; // should not happen, but never crash a room over it
    op.undone = false;
    return op;
  }

  /** Ops currently visible on the canvas, in paint order. @returns {StrokeOp[]} */
  getVisibleOps() {
    return this.opLog.filter((op) => !op.undone);
  }

  /** Full log including undone ops — used for persistence so an undo done
   *  before a save isn't permanently lost across a server restart.
   *  @returns {StrokeOp[]} */
  getFullLog() {
    return this.opLog;
  }

  /** @returns {string[]} */
  getRedoStack() {
    return this.redoStack;
  }

  /**
   * @param {StrokeOp[]} opLog
   * @param {string[]} redoStack
   */
  loadSnapshot(opLog, redoStack) {
    this.opLog = opLog;
    this.redoStack = redoStack;
    this.seqCounter = opLog.reduce((max, op) => Math.max(max, op.seq), 0);
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.opLog.length === 0;
  }
}

module.exports = { DrawingState };
