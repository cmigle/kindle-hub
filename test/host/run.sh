#!/usr/bin/env bash
# Compiles esp32_home_hub/page.h for the host and runs its tests.
#   test/host/run.sh                     run the checks
#   test/host/run.sh --preview <dir>     also write the three views as HTML
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
deps="$here/.deps"
build="$here/build"
arduinojson=7.2.1

mkdir -p "$deps" "$build"
if [ ! -f "$deps/ArduinoJson.h" ]; then
  curl -fsSL -o "$deps/ArduinoJson.h" \
    "https://github.com/bblanchon/ArduinoJson/releases/download/v$arduinojson/ArduinoJson-v$arduinojson.h"
fi

"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror \
  -I "$here/shims" -I "$here" -I "$deps" -I "$root/esp32_home_hub" \
  "$here/page_test.cpp" -o "$build/page_test"

"$build/page_test" "$here/fixtures/payload.json" "$@"
