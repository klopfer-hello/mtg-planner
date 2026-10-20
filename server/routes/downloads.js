// Phone app downloads (lib/downloads.js): the .apk files an operator copies
// into DOWNLOAD_DIR; there is no upload route by design.

import { APK_TYPE, defaultDownloadDir, downloadPath, listDownloads } from "../../lib/downloads.js";
import { decodeParam, sendFile } from "../http.js";

export function downloadRoutes(router) {
  const dir = defaultDownloadDir();
  router.get("/api/downloads", async () => ({ downloads: await listDownloads(dir) }));
  router.on(["GET", "HEAD"], "/api/downloads/:name", async ({ req, res, params }) => {
    const name = decodeParam(params.name, "Not a download name");
    const file = await downloadPath(dir, name);
    return sendFile(req, res, file, { "Content-Type": APK_TYPE, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
  });
}
