#!/bin/sh
# "gradle" in the runner: Gradle in the version the project was written for.
#
# A project that is built here has no wrapper to start (the files of a
# project are text; the wrapper is a program). What it can have is the file
# that names its version, gradle/wrapper/gradle-wrapper.properties: a version
# 9 or newer there is built with Gradle 9, everything else with Gradle 8,
# which also builds what was written for an older one.
dir="."
previous=""
for argument in "$@"; do
  case "${previous}" in -p | --project-dir) dir="${argument}" ;; esac
  case "${argument}" in --project-dir=*) dir="${argument#--project-dir=}" ;; esac
  previous="${argument}"
done
major="${RUNNER_GRADLE_DEFAULT:-8}"
file="${dir}/gradle/wrapper/gradle-wrapper.properties"
if [ -f "${file}" ]; then
  named="$(sed -n 's/^[[:space:]]*distributionUrl[[:space:]]*[=:].*gradle-\([0-9][0-9]*\)\.[0-9].*/\1/p' "${file}" | head -n 1)"
  case "${named}" in
    "") ;;
    9 | [1-9][0-9]) major=9 ;;
    *) major=8 ;;
  esac
fi
if [ ! -x "/opt/gradle/${major}/bin/gradle" ]; then
  # The one that was asked for is not here: whichever is.
  major=""
  for other in 8 9; do
    if [ -x "/opt/gradle/${other}/bin/gradle" ]; then major="${other}"; fi
  done
fi
[ -n "${major}" ] || {
  echo "gradle: no Gradle is installed under /opt/gradle." >&2
  exit 127
}
exec "/opt/gradle/${major}/bin/gradle" "$@"
