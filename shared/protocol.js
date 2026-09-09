// WS message shapes, documented here so client and server agree on one
// contract. Not imported at runtime anywhere.

/** @typedef {{x: number, y: number, t: number}} Point */
/** @typedef {"brush"|"eraser"} ToolName */
/** @typedef {{tool: ToolName, color: string, size: number}} StrokeStyle */
/** @typedef {StrokeStyle & {seq: number, id: string, userId: string, points: Point[], undone: boolean}} StrokeOp */
/** @typedef {{userId: string, color: string, name: string}} UserInfo */

/**
 * Client -> Server:
 *   stroke:start   { strokeId, tool, color, size, point }
 *   stroke:points  { strokeId, points }
 *   stroke:end     { strokeId }
 *   stroke:cancel  { strokeId }        - discard, never committed
 *   cursor:move    { x, y }
 *   undo:request   {}                  - intent only, no target seq
 *   redo:request   {}
 *   ping           { ts }
 *
 * Server -> Client:
 *   state:sync        { userId, color, users, opLog }
 *   user:joined       { user }
 *   user:left         { userId }
 *   stroke:start      { strokeId, userId, tool, color, size, point }
 *   stroke:points     { strokeId, points }
 *   stroke:committed  { op }
 *   stroke:abort      { strokeId, reason }
 *   undo:applied      { op }           - full op, not just id/seq
 *   redo:applied      { op }
 *   undo:noop / redo:noop  {}
 *   cursor:move       { userId, x, y }
 *   error             { code, message }
 *   pong              { ts }
 */

export {};
