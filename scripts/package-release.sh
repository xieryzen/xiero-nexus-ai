#!/usr/bin/env bash
# Package a ready-to-run release bundle from a standalone build.
#
#   npm run build:standalone
#   npm run package
#
# Produces dist/xiero-nexus-ai-<platform>-node<major>.zip. The zip holds one
# folder, xiero-nexus-ai/, that runs with:  node start.js
#
# The folder name carries no version on purpose: unzipping a newer release over
# an existing install upgrades it in place and leaves .env and data/ alone.
#
# The bundle includes a native SQLite binding, so it is specific to the
# platform and Node.js major version it was built with.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .next/standalone/server.js ]; then
  echo "error: no standalone build found. Run: npm run build:standalone" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
PLATFORM="$(node -p "process.platform + '-' + process.arch")"
SHA="${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

NAME="xiero-nexus-ai"
ASSET="xiero-nexus-ai-${PLATFORM}-node${NODE_MAJOR}.zip"
OUT="dist/${NAME}"

rm -rf "${OUT}" "dist/${ASSET}"
mkdir -p "${OUT}"

# Server + traced production dependencies.
cp -R .next/standalone/. "${OUT}/"
# Static assets and runtime files the tracer does not copy.
mkdir -p "${OUT}/.next"
cp -R .next/static "${OUT}/.next/static"
if [ -d public ]; then cp -R public "${OUT}/public"; fi
rm -rf "${OUT}/drizzle" && cp -R drizzle "${OUT}/drizzle"
# The font that subtitles are drawn with, and its licence.
rm -rf "${OUT}/assets" && cp -R assets "${OUT}/assets"
cp scripts/bundle-start.js "${OUT}/start.js"
cp scripts/get-release.mjs "${OUT}/get-release.mjs"
cp .env.example README.md CHANGELOG.md RELEASING.md "${OUT}/"

# Never ship local secrets or state, whatever the build picked up.
find "${OUT}" -maxdepth 1 -name '.env*' ! -name '.env.example' -delete
rm -rf "${OUT}/data"
# No package.json: everything needed is already in node_modules, and hosting
# panels that see a package.json run `npm install` against the bundle.
rm -f "${OUT}/package.json"

# The native SQLite binding must be in the bundle, and must run on common
# servers. A binding compiled on the build machine (when the prebuilt download
# failed) needs that machine's glibc, which is newer than Debian/Ubuntu LTS.
BINDING="${OUT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "${BINDING}" ]; then
  echo "error: the SQLite binding is missing from the standalone build" >&2
  exit 1
fi
# Packages that are loaded while the server runs, not when it is built: the
# build only brings them along because next.config.mjs names them. ssh2 (the
# connections to servers) comes with what it is written with; ws (the
# connection to the browser service) is written with nothing else.
for needed in node_modules/unpdf/package.json assets/fonts/NotoSans-Bold.ttf \
  node_modules/ssh2/package.json node_modules/ssh2/lib/client.js \
  node_modules/asn1/package.json node_modules/bcrypt-pbkdf/package.json \
  node_modules/tweetnacl/package.json node_modules/safer-buffer/package.json \
  node_modules/ws/package.json node_modules/ws/lib/websocket.js; do
  if [ ! -f "${OUT}/${needed}" ]; then
    echo "error: ${needed} is missing from the bundle" >&2
    exit 1
  fi
done
# ssh2 has two optional parts that are compiled on the machine that installs
# it. They are left out: compiled here they need this machine's glibc, and
# without them ssh2 does the same work with Node's own crypto, on every server
# alike.
rm -rf "${OUT}/node_modules/cpu-features" "${OUT}/node_modules/ssh2/lib/protocol/crypto/build" "${OUT}/node_modules/nan"
if find "${OUT}/node_modules/ssh2" "${OUT}/node_modules/asn1" "${OUT}/node_modules/bcrypt-pbkdf" "${OUT}/node_modules/tweetnacl" -name '*.node' | grep -q .; then
  echo "error: a compiled part of ssh2 is in the bundle" >&2
  exit 1
fi
GLIBC=""
if [ "$(uname -s)" = "Linux" ] && command -v objdump >/dev/null 2>&1; then
  GLIBC="$(objdump -T "${BINDING}" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | cut -d_ -f2 | sort -uV | tail -n 1 || true)"
  MAX_GLIBC="${MAX_GLIBC:-2.31}"
  if [ -n "${GLIBC}" ] && [ "$(printf '%s\n%s\n' "${GLIBC}" "${MAX_GLIBC}" | sort -V | tail -n 1)" != "${MAX_GLIBC}" ]; then
    echo "error: the SQLite binding needs glibc ${GLIBC}; release bundles must run on glibc ${MAX_GLIBC}." >&2
    echo "       It was probably compiled locally instead of downloaded prebuilt. Re-run npm ci, or set MAX_GLIBC to override." >&2
    exit 1
  fi
fi

{
  echo "version=${VERSION}"
  echo "commit=${SHA}"
  echo "node=${NODE_MAJOR}"
  echo "platform=${PLATFORM}"
  if [ -n "${GLIBC}" ]; then echo "glibc=${GLIBC}"; fi
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${OUT}/VERSION"

(cd dist && zip -qr "${ASSET}" "${NAME}")
rm -rf "${OUT}"

echo "packaged dist/${ASSET} ($(du -h "dist/${ASSET}" | cut -f1)) — v${VERSION} @ ${SHA}, node ${NODE_MAJOR}, ${PLATFORM}${GLIBC:+, glibc >= ${GLIBC}}"
