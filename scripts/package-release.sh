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
