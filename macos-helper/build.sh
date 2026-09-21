#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/Flame Connect Token Helper.app"

rm -rf "$BUILD_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
CLANG_MODULE_CACHE_PATH="$BUILD_DIR/module-cache" \
clang \
  -fobjc-arc \
  -O2 \
  -framework AppKit \
  -framework CoreServices \
  -framework Security \
  "$SCRIPT_DIR/FlameConnectTokenHelper.m" \
  -o "$APP_DIR/Contents/MacOS/FlameConnectTokenHelper"
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
ditto -c -k --keepParent "$APP_DIR" "$BUILD_DIR/Flame-Connect-Token-Helper-macOS.zip"
shasum -a 256 "$BUILD_DIR/Flame-Connect-Token-Helper-macOS.zip"
