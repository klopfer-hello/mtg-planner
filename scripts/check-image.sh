#!/bin/sh
# Image gates shared by CI and the release workflow (run on the built image,
# before anything is published):
# 1. The persistent OCR helper is in the image and starts (else lib/ocr.js
#    silently falls back to spawning tesseract and the equivalence tests skip).
# 2. The Claude Code CLI is proprietary: it is installed at runtime into the
#    /claude volume and must never end up in the image.
# Usage: scripts/check-image.sh <image>
set -eu
IMAGE="${1:?usage: scripts/check-image.sh <image>}"

echo "== working OCR helper"
docker run --rm --entrypoint sh "$IMAGE" -c 'test -x /usr/local/bin/mtg-ocr && /usr/local/bin/mtg-ocr </dev/null'
docker run --rm --entrypoint node "$IMAGE" --input-type=module -e '
  const o = await import("/app/lib/ocr.js");
  const img = o.encodePgm({ width: 40, height: 20, data: new Uint8Array(800).fill(255) });
  await o.ocrImage(img, { lang: "eng", psm: 7 });
  const st = o.ocrHelperStatus();
  console.log(JSON.stringify(st));
  if (!st.active || st.spawned !== 1 || st.fallbacks || st.crashes) process.exit(1);'

echo "== no Claude Code CLI"
found=$(docker run --rm --user root --entrypoint sh "$IMAGE" -c 'find / \( -path /proc -o -path /sys \) -prune -o -iname "*claude-code*" -print')
if [ -n "$found" ]; then echo "$found"; exit 1; fi
echo "image checks passed"
