#!/bin/bash
# Build patched ntgcalls with P2P audio fix
# Usage: ./scripts/build-patched-ntgcalls.sh [python_path] [venv_path]
#
# Applies fix for https://github.com/pytgcalls/ntgcalls/issues/44
# (SignalNetworkState never set to Up → PacedSender paused → silent audio)

set -e

PYTHON=${1:-python3.12}
VENV=${2:-venv}
BUILD_DIR="/tmp/ntgcalls-build-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/ntgcalls-fix-network-state.patch"

echo "=== Building patched ntgcalls ==="
echo "Python: $PYTHON"
echo "Venv: $VENV"
echo "Build dir: $BUILD_DIR"
echo ""

# Clone
echo "[1/5] Cloning ntgcalls..."
git clone --depth 1 https://github.com/pytgcalls/ntgcalls.git "$BUILD_DIR"
cd "$BUILD_DIR"

# Patch setup.py for Debug build: upstream picks the build type in one line,
# `return 'RelWithDebInfo' if sys.platform.startswith('linux') else 'Release'`.
echo "[2/5] Patching for Debug build..."
sed -i.bak "s/^\([[:space:]]*\)return .*else 'Release'\$/\1return 'Debug'/" setup.py
if ! grep -q "^[[:space:]]*return 'Debug'\$" setup.py; then
  echo "ERROR: setup.py build-type line not found — upstream changed; refusing to build Release" >&2
  exit 1
fi

# Patch macOS.cmake to add DEBUG define
if [ "$(uname)" = "Darwin" ]; then
  sed -i.bak 's/NDEBUG$/NDEBUG\n    DEBUG/' cmake/macOS.cmake
fi

# Apply the network state fix
echo "[3/5] Applying P2P audio fix..."
cd wrtc
if ! git apply "$PATCH_FILE"; then
  echo "ERROR: P2P audio fix did not apply — refusing to build unpatched ntgcalls" >&2
  exit 1
fi
cd "$BUILD_DIR"

# Build
echo "[4/5] Building (this takes ~5 minutes)..."
"$VENV/bin/python" setup.py build_ext --inplace

# Install
echo "[5/5] Installing patched binary..."
SO_FILE=$(find . -name "ntgcalls.cpython-*.so" -o -name "ntgcalls.cpython-*.pyd" | head -1)
if [ -z "$SO_FILE" ]; then
  echo "ERROR: Build failed — no .so file found"
  exit 1
fi

SITE_PACKAGES=$("$VENV/bin/python" -c "import site; print(site.getsitepackages()[0])")
cp "$SO_FILE" "$SITE_PACKAGES/"
echo ""
echo "=== SUCCESS ==="
echo "Installed: $SITE_PACKAGES/$(basename $SO_FILE)"
echo "Size: $(ls -lh "$SITE_PACKAGES/$(basename $SO_FILE)" | awk '{print $5}')"
echo ""
echo "You can now test: venv/bin/python scripts/debug-call.py <user_id>"
