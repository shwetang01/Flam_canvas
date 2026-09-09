/** @typedef {import('../shared/protocol.js').Point} Point */
/** @typedef {import('../shared/protocol.js').StrokeStyle} StrokeStyle */
/** @typedef {import('../shared/protocol.js').StrokeOp} StrokeOp */
/** @typedef {import('../shared/protocol.js').ToolName} ToolName */

/**
 * One entry per drawable tool. Adding a new tool (e.g. "rectangle") is just
 * registering a new entry here — nothing else in the renderer changes.
 * @typedef {Object} Tool
 * @property {(ctx: CanvasRenderingContext2D, style: StrokeStyle) => void} applyStyle
 * @property {(ctx: CanvasRenderingContext2D, points: Point[]) => void} draw - points already in canvas coordinates
 */

/** @param {Point} a @param {Point} b @returns {Point} */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: b.t };
}

/**
 * Hand-rolled smoothing: draws a quadratic curve through the midpoints of
 * consecutive sampled points, using each real point as the curve's control
 * point. This is what keeps freehand strokes smooth despite sparse,
 * network-relayed input rather than every raw mouse sample.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Point[]} points
 */
function strokePath(ctx, points) {
  if (points.length === 0) return;
  if (points.length === 1) {
    const p = points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const mid = midpoint(points[i], points[i + 1]);
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** @type {Record<ToolName, Tool>} */
const TOOLS = {
  brush: {
    applyStyle(ctx, style) {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = style.color;
      ctx.fillStyle = style.color;
      ctx.lineWidth = style.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    },
    draw: strokePath,
  },
  eraser: {
    applyStyle(ctx, style) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = style.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // Only alpha matters for destination-out, but set explicitly so a
      // single-point "dot erase" (drawn via fillStyle) never relies on
      // whatever color happened to be set previously.
      ctx.fillStyle = "#000000";
    },
    draw: strokePath,
  },
};

const BAKE_THRESHOLD = 200;

/**
 * @typedef {StrokeStyle & {
 *   points: Point[],
 *   bakedUpTo: number,
 *   bakeCanvas: HTMLCanvasElement | null,
 *   bakeCtx: CanvasRenderingContext2D | null
 * }} LiveStroke
 */

/**
 * Owns both canvas layers:
 *  - `committed`: the full history of non-undone strokes, painter's-algorithm
 *    order by server seq. Only fully repainted when the op log itself
 *    changes (join/undo/redo/resize) — never on a per-frame basis.
 *  - `live`: in-progress strokes only (own + everyone else's), redrawn on a
 *    requestAnimationFrame loop that runs only while at least one stroke is
 *    active, so idle CPU usage is zero.
 */
export class CanvasRenderer {
  /**
   * @param {HTMLElement} container
   * @param {HTMLCanvasElement} committed
   * @param {HTMLCanvasElement} live
   */
  constructor(container, committed, live) {
    this.container = container;
    this.committed = committed;
    this.committedCtx = this.getCtx(committed);
    this.live = live;
    this.liveCtx = this.getCtx(live);
    this.dpr = window.devicePixelRatio || 1;
    this.widthCss = 0;
    this.heightCss = 0;

    /** @type {Map<string, LiveStroke>} */
    this.liveStrokes = new Map();
    this.rafHandle = null;
    /** @type {StrokeOp[]} */
    this.lastOps = [];

    /** @type {((fps: number) => void) | null} */
    this.onFrame = null;
    this.lastFrameTime = 0;

    this.resize();
  }

  /** @param {HTMLCanvasElement} canvas @returns {CanvasRenderingContext2D} */
  getCtx(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    return ctx;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.widthCss = rect.width;
    this.heightCss = rect.height;
    for (const canvas of [this.committed, this.live]) {
      canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    // setTransform (not scale) so repeated resizes never compound.
    this.committedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.liveCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // A resized canvas loses its bitmap, so the committed layer must be
    // rebuilt from the authoritative op log.
    this.repaintCommitted(this.lastOps);
  }

  get size() {
    return { width: this.widthCss, height: this.heightCss };
  }

  /**
   * Full repaint of the committed layer from the authoritative, seq-ordered
   * op log — this IS the conflict-resolution mechanism: every client runs
   * this same deterministic painter's-algorithm pass over the same ops, so
   * overlapping strokes always composite identically everywhere.
   * @param {StrokeOp[]} ops
   */
  repaintCommitted(ops) {
    this.lastOps = ops;
    this.committedCtx.clearRect(0, 0, this.widthCss, this.heightCss);
    for (const op of ops) {
      const tool = TOOLS[op.tool];
      tool.applyStyle(this.committedCtx, op);
      tool.draw(this.committedCtx, op.points);
    }
  }

  // ---- Live (in-progress) strokes ----

  /**
   * @param {string} id
   * @param {StrokeStyle} style
   * @param {Point} point
   */
  beginActiveStroke(id, style, point) {
    this.liveStrokes.set(id, { ...style, points: [point], bakedUpTo: 0, bakeCanvas: null, bakeCtx: null });
    this.ensureLoopRunning();
  }

  /** @param {string} id @param {Point[]} points */
  appendActiveStrokePoints(id, points) {
    const stroke = this.liveStrokes.get(id);
    if (!stroke) return;
    stroke.points.push(...points);
    if (stroke.points.length - stroke.bakedUpTo > BAKE_THRESHOLD) {
      this.bakeStroke(stroke);
    }
  }

  /** @param {LiveStroke} stroke */
  bakeStroke(stroke) {
    if (!stroke.bakeCanvas) {
      stroke.bakeCanvas = document.createElement("canvas");
      stroke.bakeCanvas.width = this.live.width;
      stroke.bakeCanvas.height = this.live.height;
      stroke.bakeCtx = this.getCtx(stroke.bakeCanvas);
      stroke.bakeCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    const ctx = stroke.bakeCtx;
    const tail = stroke.points.slice(Math.max(0, stroke.bakedUpTo - 1));
    const tool = TOOLS[stroke.tool];
    tool.applyStyle(ctx, stroke);
    tool.draw(ctx, tail);
    stroke.bakedUpTo = stroke.points.length;
  }

  /**
   * Removes a stroke from the live layer — used both when it commits (baked
   * into the committed canvas via repaintCommitted instead) and when it's
   * aborted (disconnect, or a discarded empty click).
   * @param {string} id
   */
  removeActiveStroke(id) {
    this.liveStrokes.delete(id);
  }

  /** @returns {number} */
  activeStrokeCount() {
    return this.liveStrokes.size;
  }

  ensureLoopRunning() {
    if (this.rafHandle !== null) return;
    const tick = (time) => {
      this.renderLiveFrame();
      if (this.lastFrameTime > 0 && this.onFrame) {
        const fps = 1000 / (time - this.lastFrameTime);
        this.onFrame(fps);
      }
      this.lastFrameTime = time;
      if (this.liveStrokes.size > 0) {
        this.rafHandle = requestAnimationFrame(tick);
      } else {
        this.rafHandle = null;
        this.lastFrameTime = 0;
      }
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  renderLiveFrame() {
    this.liveCtx.clearRect(0, 0, this.widthCss, this.heightCss);
    for (const stroke of this.liveStrokes.values()) {
      const tool = TOOLS[stroke.tool];
      if (stroke.bakeCanvas) {
        this.liveCtx.drawImage(stroke.bakeCanvas, 0, 0, this.widthCss, this.heightCss);
      }
      const tail = stroke.points.slice(Math.max(0, stroke.bakedUpTo - 1));
      tool.applyStyle(this.liveCtx, stroke);
      tool.draw(this.liveCtx, tail);
    }
  }
}
