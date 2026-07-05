#!/usr/bin/env bash
# Build the PUBLIC dossier-viewer bundle for a SEPARATE Cloudflare Pages project served on a public
# subdomain (e.g. share.clarev.ai). It copies ONLY the viewer (d.html) and the static render assets it
# needs from the main navigator/ tree — NO internal pages (no theo.html, no navigators) — so the public
# hostname structurally cannot expose gated content. It rebuilds on every push, so the render assets never
# drift from the gated clarev.ai site.
#
# Cloudflare Pages project settings for this bundle:
#   Build command:      bash share-viewer/build.sh
#   Build output dir:   share-viewer/dist
#   (root directory = repo root)
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

rm -rf share-viewer/dist
mkdir -p share-viewer/dist/primes

cp navigator/d.html share-viewer/dist/d.html
cp navigator/primes/theo-render.js \
   navigator/primes/theo-display.css \
   navigator/primes/theo-config.js \
   navigator/primes/prime-core.v1.css \
   share-viewer/dist/primes/

echo "built share-viewer/dist:"
ls -R share-viewer/dist
