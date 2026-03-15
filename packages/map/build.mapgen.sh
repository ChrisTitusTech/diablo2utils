#!/bin/bash
set -e

# On Arch Linux install the cross-compiler with: sudo pacman -S mingw-w64-gcc
COMPILER="i686-w64-mingw32-g++"
if ! command -v "$COMPILER" &>/dev/null; then
    echo "ERROR: $COMPILER not found."
    echo "Install it on Arch Linux with: sudo pacman -S mingw-w64-gcc"
    exit 1
fi

mkdir -p bin

GIT_VERSION=${GIT_VERSION:-$(git describe --abbrev=4 --dirty --always --tags 2>/dev/null || echo "unknown")}
GIT_HASH=${GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "unknown")}

echo "GIT_VERSION: $GIT_VERSION"
echo "GIT_HASH:    $GIT_HASH"

"$COMPILER" -o bin/d2-map.exe \
    -Wno-write-strings \
    -DGIT_VERSION=\"${GIT_VERSION}\" \
    -DGIT_HASH=\"${GIT_HASH}\" \
    map/json.c map/log.c map/map.c map/offset.c map/d2_client.c map/main.c \
    -static-libgcc -static-libstdc++ \
    -Wl,-Bstatic -lpthread -Wl,-Bdynamic

# Bundle the mingw pthread DLL alongside the exe so Wine can find it
PTHREAD_DLL=$("$COMPILER" -print-file-name=libwinpthread-1.dll 2>/dev/null || true)
if [ -f "$PTHREAD_DLL" ]; then
    cp -v "$PTHREAD_DLL" bin/
else
    PTHREAD_DLL=$(find /usr/i686-w64-mingw32 -name 'libwinpthread-1.dll' 2>/dev/null | head -1)
    [ -n "$PTHREAD_DLL" ] && cp -v "$PTHREAD_DLL" bin/ \
        || echo "[warn] libwinpthread-1.dll not found; Wine may fail to launch d2-map.exe"
fi

echo "$(date --iso-8601=seconds) Build done: $GIT_VERSION $GIT_HASH"