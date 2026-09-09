// Shared, documentation-only contract between client and server.
//
// This project is plain JavaScript with no build step, so there's no
// compiler to enforce these shapes — this file exists purely so both sides
// document the *same* WebSocket protocol in one place instead of two, and so
// editors (VS Code's JS language service reads JSDoc @typedef) can offer
// autocomplete on message objects. Nothing here is imported at runtime.

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 * @property {number} t - ms timestamp (client clock), used for smoothing only, never for ordering
 */

/** @typedef {"brush"|"eraser"} ToolName */

/**
 * @typedef {Object} StrokeStyle
 * @property {ToolName} tool
 * @property {string} color
 * @property {number} size
 */

/**
 * A finalized, committed stroke as stored in a room's op log.
 * @typedef {StrokeStyle & {
 *   seq: number,
 *   id: string,
 *   userId: string,
 *   points: Point[],
 *   undone: boolean
 * }} StrokeOp
 */

/**
 * @typedef {Object} UserInfo
 * @property {string} userId
 * @property {string} color
 * @property {string} name
 */

/**
 * WebSocket message protocol (see ARCHITECTURE.md for the full table):
 *
 * Client -> Server:
 *   join            { type, roomId }
 *   stroke:start    { type, strokeId, tool, color, size, point }
 *   stroke:points   { type, strokeId, points }
 *   stroke:end      { type, strokeId }
 *   stroke:cancel   { type, strokeId }               // discard, never committed
 *   cursor:move     { type, x, y }
 *   undo:request    { type }                          // intent only, no target seq
 *   redo:request    { type }
 *   ping            { type, ts }
 *
 * Server -> Client:
 *   state:sync        { type, userId, color, users, opLog }
 *   user:joined       { type, user }
 *   user:left         { type, userId }
 *   stroke:start      { type, strokeId, userId, tool, color, size, point }
 *   stroke:points     { type, strokeId, points }
 *   stroke:committed  { type, op }
 *   stroke:abort      { type, strokeId, reason }
 *   undo:applied      { type, op }                    // full op, not just id/seq
 *   redo:applied      { type, op }
 *   undo:noop         { type }
 *   redo:noop         { type }
 *   cursor:move       { type, userId, x, y }
 *   error             { type, code, message }
 *   pong              { type, ts }
 */

export {};
