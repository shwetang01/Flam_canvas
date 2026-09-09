function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: b.t };
}

// Smooths a raw point list by drawing quadratic curves through the
// midpoints of consecutive points, using each point as the control point.
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

// Tool registry: adding a new tool (e.g. rectangle) is one more entry here.
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
      ctx.fillStyle = "#000000"; // only alpha matters for destination-out
    },
    draw: strokePath,
  },
};

const BAKE_THRESHOLD = 200;

// Owns two canvas layers: `committed` (all finalized strokes, repainted only
// when the op log changes) and `live` (strokes still being drawn, redrawn
// every frame but only while something is actually in progress).
export class CanvasRenderer {
  constructor(container, committed, live) {
    this.container = container;
    this.committed = committed;
    this.committedCtx = this.getCtx(committed);
    this.live = live;
    this.liveCtx = this.getCtx(live);
    this.dpr = window.devicePixelRatio || 1;
    this.widthCss = 0;
    this.heightCss = 0;

    this.liveStrokes = new Map();
    this.rafHandle = null;
    this.lastOps = [];

    this.onFrame = null;
    this.lastFrameTime = 0;

    this.resize();
  }

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
    this.committedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.liveCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.repaintCommitted(this.lastOps); // resize clears the canvas bitmap
  }

  get size() {
    return { width: this.widthCss, height: this.heightCss };
  }

  // Same ops, same seq order, on every client — this is the whole conflict
  // resolution strategy: overlapping strokes composite identically everywhere.
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

  beginActiveStroke(id, style, point) {
    this.liveStrokes.set(id, { ...style, points: [point], bakedUpTo: 0, bakeCanvas: null, bakeCtx: null });
    this.ensureLoopRunning();
  }

  appendActiveStrokePoints(id, points) {
    const stroke = this.liveStrokes.get(id);
    if (!stroke) return;
    stroke.points.push(...points);
    if (stroke.points.length - stroke.bakedUpTo > BAKE_THRESHOLD) {
      this.bakeStroke(stroke);
    }
  }

  // Bakes everything but the last point into an offscreen bitmap so a long
  // stroke doesn't get redrawn point-by-point every single frame.
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

  // called both when a stroke commits (now lives on the committed canvas
  // instead) and when it's aborted (disconnect, or a discarded empty click)
  removeActiveStroke(id) {
    this.liveStrokes.delete(id);
  }

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
