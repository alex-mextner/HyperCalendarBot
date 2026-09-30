#!/bin/bash
# Downloads ntgcalls prebuilt shared library for current platform

set -e

VERSION="v2.1.0"
OUTDIR="lib"
mkdir -p "$OUTDIR"

OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.macos-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.dylib"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-x86_64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "aarch64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
else
  echo "Unsupported platform: $OS/$ARCH"
  exit 1
fi

echo "Downloading ntgcalls $VERSION for $OS/$ARCH..."
curl -L -o /tmp/ntgcalls.zip "$URL"
unzip -o /tmp/ntgcalls.zip -d "$OUTDIR"
rm /tmp/ntgcalls.zip

echo "ntgcalls library ready at $OUTDIR/"
ls -la "$OUTDIR/"
