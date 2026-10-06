#!/usr/bin/env bash
# Browser test for the composer media uploader (all Supabase traffic mocked).
# Needs: node, ffmpeg, Chrome, and `npm i playwright-core` somewhere on NODE_PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../.."
export FIXTURES="${FIXTURES:-/tmp/bp-ui-fixtures}"; mkdir -p "$FIXTURES"
td="$root/supabase/functions/_shared/testdata"
ffmpeg -v error -y -f lavfi -i "nullsrc=s=1600x1200,geq=random(1)*255:random(1)*255:128" -frames:v 1 "$FIXTURES/noisy.png"
ffmpeg -v error -y -f lavfi -i "testsrc=size=1080x1350" -frames:v 1 -q:v 3 "$FIXTURES/photo.jpg"
ffmpeg -v error -y -f lavfi -i "testsrc=size=1080x1920" -frames:v 1 -q:v 3 "$FIXTURES/story.jpg"
printf 'GIF89a\x01\x00\x01\x00\x00\x00\x00;' > "$FIXTURES/anim.gif"
cp "$td/clip-2s-faststart.mp4" "$FIXTURES/clip.mp4"; cp "$td/clip-95s.mp4" "$FIXTURES/long.mp4"
port="${PORT:-8765}"; export BASE_URL="http://localhost:$port"
( cd "$root" && exec python3 -m http.server "$port" >/dev/null 2>&1 ) & srv=$!
trap 'kill $srv 2>/dev/null' EXIT; sleep 1
node "$here/composer-media.test.js"
