#!/usr/bin/env bash
# Publish GitHub releases for the commit that was just built. CI runs this after
# the bundles in dist/ were built and smoke-tested (.github/workflows/release.yml).
#
#   v<version>   Published once, when that version has no release yet. The
#                version comes from package.json and decides the channel:
#                1.4.0 is stable; 1.4.0-rc.1, -beta.1 and -alpha.1 are pre-releases.
#   dev-build    Replaced on every run; always holds the newest commit.
#
# Needs gh (authenticated through GH_TOKEN), GITHUB_REPOSITORY and GITHUB_SHA.
# DRY_RUN=1 prints the commands that would change something instead of running them.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to owner/name}"
: "${GITHUB_SHA:?set GITHUB_SHA to the full commit hash being released}"
export GH_REPO="${GITHUB_REPOSITORY}"

VERSION="$(node scripts/release-info.mjs --get version)"
TAG="$(node scripts/release-info.mjs --get tag)"
CHANNEL="$(node scripts/release-info.mjs --get channel)"
SHORT="${GITHUB_SHA::7}"
API="repos/${GITHUB_REPOSITORY}"
REPO_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}"
DEV_TAG="dev-build"

shopt -s nullglob
bundles=(dist/*.zip)
if [ "${#bundles[@]}" -eq 0 ]; then
  echo "error: there are no bundles in dist/ to publish" >&2
  exit 1
fi
(cd dist && sha256sum -- *.zip > SHA256SUMS.txt)
assets=("${bundles[@]}" dist/SHA256SUMS.txt)

run() {
  if [ -n "${DRY_RUN:-}" ]; then
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

notes_dir="$(mktemp -d)"
trap 'rm -rf "${notes_dir}"' EXIT

# One read of the release list answers every question below: one line per
# release, "<tag> TAB <id> TAB <draft|prerelease|release>". The token can write,
# so unfinished drafts are listed too.
releases="$(gh api --paginate "${API}/releases?per_page=100" \
  --jq '.[] | [.tag_name, (.id | tostring), (if .draft then "draft" elif .prerelease then "prerelease" else "release" end)] | @tsv')"

rows_for() { awk -F'\t' -v tag="$1" '$1 == tag' <<< "${releases}"; }

delete_releases() { # every listed release with this tag
  local id
  for id in $(rows_for "$1" | cut -f2); do
    run gh api -X DELETE "${API}/releases/${id}"
  done
}

# ── v<version>: publish once ─────────────────────────────────────────────────
published=false

if [ -n "$(rows_for "${TAG}" | awk -F'\t' '$3 != "draft"')" ]; then
  echo "Release ${TAG} already exists; leaving it untouched."
else
  if [ -n "$(rows_for "${TAG}")" ]; then
    echo "Removing an unfinished draft of ${TAG} left behind by an earlier run."
    delete_releases "${TAG}"
  fi

  # A tag without a release was made by hand. Continue only if it marks this
  # very commit; otherwise the bundles would not match the tagged source.
  if tag_sha="$(gh api "${API}/commits/tags/${TAG}" --jq .sha 2> /dev/null)" \
    && [ "${tag_sha}" != "${GITHUB_SHA}" ]; then
    echo "::error::Tag ${TAG} already exists on commit ${tag_sha::7}, but this build is ${SHORT}. Raise the version in package.json (or delete that tag) and push again."
    exit 1
  fi

  notes="${notes_dir}/release.md"
  node scripts/release-info.mjs --notes > "${notes}"
  if ! grep -qF "## [${VERSION}]" CHANGELOG.md 2> /dev/null; then
    echo "::warning::CHANGELOG.md has no section for ${VERSION}; the release notes are only a placeholder."
  fi
  cat >> "${notes}" << EOF

---

**Install:** download the bundle that matches your Node.js version (\`node -v\`), unzip it, copy \`.env.example\` to \`.env\` and set the key, then run \`node start.js\`. Step by step: [RELEASING.md](${REPO_URL}/blob/${TAG}/RELEASING.md#install-a-release).

Channel: **${CHANNEL}** · Commit: [\`${SHORT}\`](${REPO_URL}/commit/${GITHUB_SHA})
EOF

  flags=(--target "${GITHUB_SHA}" --title "Xiero Nexus AI ${TAG}" --notes-file "${notes}")
  if [ "${CHANNEL}" = "stable" ]; then
    # "Latest" must never move backwards, e.g. when 1.2.9 comes out after 1.3.0.
    newest="$({
      awk -F'\t' '$3 == "release" { print $1 }' <<< "${releases}"
      echo "${TAG}"
    } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
    if [ "${newest}" = "${TAG}" ]; then flags+=(--latest); else flags+=(--latest=false); fi
  else
    flags+=(--prerelease --latest=false)
  fi

  run gh release create "${TAG}" "${assets[@]}" "${flags[@]}"
  published=true
  echo "Published ${TAG} (${CHANNEL})."
fi

# ── dev-build: always the newest commit ──────────────────────────────────────
dev_notes="${notes_dir}/dev.md"
cat > "${dev_notes}" << EOF
Automatic build of the newest commit on \`main\`: [\`${SHORT}\`](${REPO_URL}/commit/${GITHUB_SHA}), with version \`${VERSION}\` in package.json.

This entry is replaced on every push. It is not a tested, numbered release. For one of those, take the [latest release](${REPO_URL}/releases/latest) or pick a version from the [release list](${REPO_URL}/releases).
EOF

delete_releases "${DEV_TAG}"
# The tag has to go too, or the new release would stay on the old commit.
if [ -n "${DRY_RUN:-}" ]; then
  run gh api -X DELETE "${API}/git/refs/tags/${DEV_TAG}"
else
  gh api -X DELETE "${API}/git/refs/tags/${DEV_TAG}" > /dev/null 2>&1 || true
fi
run gh release create "${DEV_TAG}" "${assets[@]}" \
  --target "${GITHUB_SHA}" --prerelease --latest=false \
  --title "Development build (${SHORT})" --notes-file "${dev_notes}"
echo "Refreshed ${DEV_TAG} at ${SHORT}."

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Releases for \`${SHORT}\`"
    echo
    if [ "${published}" = true ]; then
      echo "- Published **[${TAG}](${REPO_URL}/releases/tag/${TAG})** on the ${CHANNEL} channel"
    else
      echo "- [${TAG}](${REPO_URL}/releases/tag/${TAG}) already existed and was left untouched"
    fi
    echo "- Refreshed **[${DEV_TAG}](${REPO_URL}/releases/tag/${DEV_TAG})** (newest commit)"
    echo
    echo "| File | SHA-256 |"
    echo "|---|---|"
    while read -r sum file; do
      echo "| \`${file}\` | \`${sum}\` |"
    done < dist/SHA256SUMS.txt
  } >> "${GITHUB_STEP_SUMMARY}"
fi
