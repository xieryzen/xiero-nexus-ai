#!/usr/bin/env bash
# Keep what a node said private on its way through a place others can read,
# such as the log of a workflow in a public repository. There it is sealed
# with a public key; only the holder of the private key can open it.
#
#   bash scripts/host/sealed-output.sh keygen <folder>
#       Makes <folder>/key.pem and prints the public key as one line: the
#       "output_key" of the Deploy workflow. Keep key.pem where only you can
#       read it, outside the repository.
#   bash scripts/host/sealed-output.sh seal <public key line> < output > sealed.txt
#   bash scripts/host/sealed-output.sh open <folder>/key.pem < sealed.txt
#   bash scripts/host/sealed-output.sh read <folder>/key.pem <run id>
#       Fetches what that run of the Deploy workflow sealed, and opens it.
#       Needs gh, signed in; the repository is GITHUB_REPOSITORY or the one of
#       the current folder.
#
# Sealed text is three lines: the name of the format, the key of that one
# time (256 random bits, encrypted for the public key with RSA-OAEP), and the
# output (compressed, encrypted with AES-256 under that key). Needs openssl
# and gzip.
set -euo pipefail
umask 077

FORMAT="xiero-sealed-1"
OAEP=(-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256)
CIPHER=(-aes-256-cbc -pbkdf2 -iter 10000 -md sha256)

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
for tool in openssl gzip; do
  command -v "${tool}" > /dev/null 2>&1 || die "this needs \"${tool}\", which is not installed here."
done

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

seal() { # PUBLIC-KEY-LINE; reads the output, writes the sealed text
  local line="${1:-}" bits
  [ -n "${line}" ] || die "seal needs the public key: the line that keygen printed."
  printf '%s' "${line}" | tr -d ' \r\n' | openssl base64 -d -A > "${TMP}/public.pem" 2> /dev/null || true
  openssl pkey -pubin -in "${TMP}/public.pem" -noout -text > "${TMP}/public.txt" 2> /dev/null || true
  bits="$(sed -n 's/.*Public-Key: (\([0-9]*\) bit.*/\1/p' "${TMP}/public.txt" | head -n 1)"
  [ -n "${bits}" ] || die "that is not a public key. It is the one line that \"sealed-output.sh keygen\" prints."
  grep -qi 'modulus' "${TMP}/public.txt" || die "the public key must be an RSA key, as keygen makes them."
  [ "${bits}" -ge 2048 ] || die "the public key is too short (${bits} bits)."
  SEAL_PASS="$(openssl rand -hex 32)"
  export SEAL_PASS
  printf '%s\n' "${FORMAT}"
  printf '%s' "${SEAL_PASS}" | openssl pkeyutl -encrypt -pubin -inkey "${TMP}/public.pem" "${OAEP[@]}" | openssl base64 -A
  printf '\n'
  gzip -9c | openssl enc "${CIPHER[@]}" -salt -pass env:SEAL_PASS | openssl base64 -A
  printf '\n'
}

open() { # KEY-FILE; reads the sealed text, writes the output
  local key="${1:-}"
  [ -f "${key}" ] || die "open needs the private key file (key.pem)."
  cat > "${TMP}/sealed.txt"
  [ "$(sed -n 1p "${TMP}/sealed.txt" | tr -d '\r')" = "${FORMAT}" ] || die "that is not sealed output (it does not start with ${FORMAT})."
  SEAL_PASS="$(sed -n 2p "${TMP}/sealed.txt" | tr -d '\r\n' | openssl base64 -d -A | openssl pkeyutl -decrypt -inkey "${key}" "${OAEP[@]}" 2> /dev/null)" \
    || die "this key does not open it: it was sealed for another one."
  export SEAL_PASS
  sed -n 3p "${TMP}/sealed.txt" | tr -d '\r\n' | openssl base64 -d -A | openssl enc -d "${CIPHER[@]}" -pass env:SEAL_PASS 2> /dev/null | gzip -dc 2> /dev/null \
    || die "the sealed output is damaged."
}

case "${1:-}" in
  keygen)
    folder="${2:-}"
    [ -n "${folder}" ] || die "keygen needs a folder for the key, outside the repository."
    mkdir -p "${folder}"
    chmod 700 "${folder}"
    if [ ! -f "${folder}/key.pem" ]; then
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${folder}/key.pem" 2> /dev/null
      chmod 600 "${folder}/key.pem"
    fi
    openssl pkey -in "${folder}/key.pem" -pubout 2> /dev/null | openssl base64 -A
    printf '\n'
    ;;
  seal) seal "${2:-}" ;;
  open) open "${2:-}" ;;
  read)
    key="${2:-}"
    run="${3:-}"
    [ -f "${key}" ] || die "read needs the private key file (key.pem) and the number of the run."
    [[ "${run}" =~ ^[0-9]+$ ]] || die "read needs the number of the run, as in the address of its page."
    command -v gh > /dev/null 2>&1 || die "read needs gh, the GitHub command line."
    repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
    blob=""
    for job in $(gh api "repos/${repo}/actions/runs/${run}/jobs" --jq '.jobs[].id'); do
      blob="$(gh api "repos/${repo}/check-runs/${job}/annotations" --jq '.[] | select(.title == "Sealed output") | .message' | head -n 1 | tr -d '.')"
      [ -z "${blob}" ] || break
    done
    [[ "${blob}" =~ ^[0-9a-f]{40,64}$ ]] || die "run ${run} sealed no output. It does so when it is started with an output_key."
    gh api "repos/${repo}/git/blobs/${blob}" --jq '.content | gsub("\n"; "") | @base64d' | open "${key}"
    ;;
  "" | -h | --help | help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "\"$1\" is not something this does. There are: keygen, seal, open, read." ;;
esac
