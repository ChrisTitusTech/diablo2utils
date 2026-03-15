#!/bin/bash
set -e

if ! command -v docker &>/dev/null; then
    echo "ERROR: docker not found."
    echo "Install it on Arch Linux with: sudo pacman -S docker"
    echo "Then enable the service: sudo systemctl enable --now docker"
    exit 1
fi

GIT_VERSION=${GIT_VERSION:-$(git describe --abbrev=4 --dirty --always --tags 2>/dev/null || echo "unknown")}
GIT_HASH=${GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "unknown")}

echo "Building Docker image blacha/diablo2 ($GIT_VERSION $GIT_HASH)..."
docker build \
    --build-arg GIT_HASH="$GIT_HASH" \
    --build-arg GIT_VERSION="$GIT_VERSION" \
    -t blacha/diablo2 .
echo "Docker build complete."