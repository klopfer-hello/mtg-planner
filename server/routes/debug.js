// Scanner diagnostics, not part of backups: Record session (small frames +
// capture decision records for offline replay, lib/debugsessions.js) and the
// perf beacons sent every ~5 s while the camera runs (lib/debugperf.js).

import { DebugPerf } from "../../lib/debugperf.js";
import { DebugSessions } from "../../lib/debugsessions.js";
import { HttpError, decodeParam, readJson, sendEmpty } from "../http.js";

// Frame upload: ≤ 300 KB JPEG as base64 plus a decision record.
const FRAME_LIMIT = 512 * 1024;
// Perf beacon (lib/debugperf.js caps the stored entry at 4 KB).
const PERF_LIMIT = 16 * 1024;

export function debugRoutes(router) {
  const sessions = new DebugSessions();
  const perf = new DebugPerf();

  router.post("/api/debug/frames", async ({ req, res }) => {
    const body = await readJson(req, FRAME_LIMIT);
    let frame = null;
    if (body.jpeg != null && body.jpeg !== "") {
      if (typeof body.jpeg !== "string") throw new HttpError(400, "jpeg must be a base64 string");
      frame = Buffer.from(body.jpeg.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    }
    await sessions.add({ session: body.session, seq: body.seq, frame, record: body.record ?? undefined });
    sendEmpty(res);
  });
  router.post("/api/debug/perf", async ({ req, res }) => {
    await perf.add(await readJson(req, PERF_LIMIT));
    sendEmpty(res);
  });
  router.get("/api/debug/perf", async ({ query }) => ({ entries: await perf.list({ limit: query.get("limit") ?? 100 }) }));
  router.get("/api/debug/sessions", async () => ({ sessions: await sessions.list() }));
  router.delete("/api/debug/sessions/:id", async ({ res, params }) => {
    const id = decodeParam(params.id, "Invalid session id");
    if (!(await sessions.delete(id))) throw new HttpError(404, "Session not found");
    sendEmpty(res);
  });
}
