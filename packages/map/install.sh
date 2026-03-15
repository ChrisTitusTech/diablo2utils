#!/bin/bash
# install.sh — Full Arch Linux setup for @diablo2/map
# Run this once from the packages/map directory (or anywhere; it locates the repo root).
# After it completes, 'run.sh' can be used without any other setup.
set -e

# ─── Helpers ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[install]${NC} $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}    $*"; }
err()     { echo -e "${RED}[error]${NC}   $*" >&2; }

# ─── Locate repo root and packages/map ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$MAP_DIR/../.." && pwd)"

info "Repository root : $REPO_ROOT"
info "Map package     : $MAP_DIR"

# ─── Arch Linux check ────────────────────────────────────────────────────────
if ! command -v pacman &>/dev/null; then
    err "pacman not found. This script is for Arch Linux only."
    exit 1
fi

# ─── Enable multilib (required for wine 32-bit) ──────────────────────────────
PACMAN_CONF=/etc/pacman.conf
if ! grep -q '^\[multilib\]' "$PACMAN_CONF"; then
    info "Enabling [multilib] repository in $PACMAN_CONF ..."
    sudo sed -i '/^#\[multilib\]/{n;s/^#Include/Include/;s/^#\[multilib\]/\[multilib\]/}' "$PACMAN_CONF"
    sudo pacman -Sy --noconfirm
else
    info "[multilib] already enabled."
fi

# ─── System packages ─────────────────────────────────────────────────────────
PACMAN_PKGS=(
    wine            # Run d2-map.exe locally
    lib32-glibc     # 32-bit runtime (wine dependency)
    mingw-w64-gcc   # Cross-compiler to build d2-map.exe for Windows
    nodejs          # Node.js runtime
    npm             # Package manager (used to install yarn)
    docker          # Map server container
    git             # Version tagging during build
)

info "Installing system packages ..."
MISSING_PKGS=()
for pkg in "${PACMAN_PKGS[@]}"; do
    if ! pacman -Qi "$pkg" &>/dev/null; then
        MISSING_PKGS+=("$pkg")
    fi
done

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    info "Installing: ${MISSING_PKGS[*]}"
    sudo pacman -S --noconfirm --needed "${MISSING_PKGS[@]}"
else
    info "All pacman packages already installed."
fi

# ─── Yarn ────────────────────────────────────────────────────────────────────
if ! command -v yarn &>/dev/null; then
    info "Installing yarn via npm ..."
    sudo npm install -g yarn
else
    info "yarn already installed ($(yarn --version))."
fi

# ─── Docker service ──────────────────────────────────────────────────────────
info "Enabling and starting Docker service ..."
sudo systemctl enable --now docker

if ! groups "$USER" | grep -q '\bdocker\b'; then
    warn "Adding $USER to the 'docker' group."
    warn "You will need to log out and back in (or run 'newgrp docker') before"
    warn "using Docker without sudo. The rest of this script runs Docker via sudo."
    sudo usermod -aG docker "$USER"
    DOCKER_CMD="sudo docker"
else
    DOCKER_CMD="docker"
fi

# ─── D2 path ─────────────────────────────────────────────────────────────────
D2_PATH="${D2_PATH:-$HOME/.steam/steam/steamapps/common/Diablo II Resurrected}"
if [ ! -d "$D2_PATH" ]; then
    warn "Diablo II Resurrected not found at: $D2_PATH"
    warn "Set the D2_PATH environment variable before running run.sh."
    warn "Example: D2_PATH=\"/path/to/Diablo II Resurrected\" ./run.sh"
else
    info "D2 path found: $D2_PATH"
fi

# ─── Node / JS build ─────────────────────────────────────────────────────────
info "Installing Node dependencies ..."
cd "$REPO_ROOT"

# canvas is a native module; pre-built binaries may not exist for the current
# Node ABI. Allow yarn to continue even if canvas fails — the map server runs
# inside Docker so canvas is only needed for the optional image-render endpoint
# when running the server locally outside Docker.
if ! yarn install 2>&1; then
    warn "yarn install reported errors (likely canvas native build)."
    warn "Retrying with --ignore-scripts to skip native builds ..."
    yarn install --ignore-scripts 2>&1 || true
    info "Attempting standalone canvas install with latest node-gyp ..."
    # Ensure a modern node-gyp is available and retry canvas build
    cd "$REPO_ROOT/packages/map"
    npm exec --yes -- node-gyp@latest rebuild --directory node_modules/canvas 2>&1 || \
        warn "canvas native build failed — PNG image endpoint will not work outside Docker."
    cd "$REPO_ROOT"
fi

info "Building TypeScript packages ..."
yarn build 2>&1 || { warn "yarn build reported errors, retrying with tsc directly ..."; npx tsc -b --force 2>&1; }

info "Bundling map server ..."
cd "$MAP_DIR"
yarn bundle-server
yarn bundle-www
mkdir -p dist/www
cp -r static/* dist/www/

# ─── Build d2-map.exe (native cross-compile, no Docker needed for this step) ──
info "Building d2-map.exe with mingw ..."
cd "$MAP_DIR"
bash build.mapgen.sh

# ─── Wine prefix setup ───────────────────────────────────────────────────────
export WINEPREFIX="${WINEPREFIX:-$HOME/.local/share/d2map/.prefix}"
export WINEDLLOVERRIDES="winemenubuilder.exe=d"  # suppress menu popups during init
export WINEDEBUG=-all

info "Initialising Wine prefix at $WINEPREFIX ..."
mkdir -p "$WINEPREFIX"
wineboot --init 2>/dev/null || true

info "Applying Diablo II registry keys ..."
# Copy libwinpthread-1.dll to the Wine prefix so the exe can find it
PTHREAD_DLL=$(find /usr/i686-w64-mingw32 -name 'libwinpthread-1.dll' 2>/dev/null | head -1)
if [ -n "$PTHREAD_DLL" ]; then
    for winedir in "$WINEPREFIX/drive_c/windows/syswow64" "$WINEPREFIX/drive_c/windows/system32"; do
        [ -d "$winedir" ] && cp -v "$PTHREAD_DLL" "$winedir/" && \
            info "Installed libwinpthread-1.dll to $winedir" && break
    done
fi

# Use 'wine reg add' instead of 'wine regedit' to avoid .reg file encoding issues
# (regedit expects UTF-16 LE and treats backslashes as escape sequences)
REG_KEY="HKCU\\SOFTWARE\\Blizzard Entertainment\\Diablo II"
WIN_D2_PATH=$(winepath -w "$D2_PATH" 2>/dev/null || echo "")

wine reg add "$REG_KEY" /f 2>/dev/null || true
if [ -n "$WIN_D2_PATH" ]; then
    wine reg add "$REG_KEY" /v InstallPath /t REG_SZ /d "$WIN_D2_PATH" /f 2>/dev/null && \
        info "Registry InstallPath set to: $WIN_D2_PATH" || \
        warn "Could not write InstallPath; run.sh passes the path as a CLI argument."
else
    warn "winepath could not convert D2 path — InstallPath left empty in registry."
    warn "(This is fine — run.sh passes the path as a CLI argument.)"
fi

# ─── Build Docker image ───────────────────────────────────────────────────────
info "Building Docker image blacha/diablo2 ..."
cd "$MAP_DIR"
if bash build.docker.sh 2>&1; then
    DOCKER_IMAGE_BUILT=true
else
    warn "Docker image build failed. You can still use run.sh to invoke d2-map.exe directly via Wine."
    warn "Fix the Docker issue and re-run: bash build.docker.sh"
    DOCKER_IMAGE_BUILT=false
fi

# ─── Persist D2_PATH for run.sh ──────────────────────────────────────────────
ENV_FILE="$MAP_DIR/.env"
cat > "$ENV_FILE" <<EOF
# Generated by install.sh — sourced automatically by run.sh
export D2_PATH="${D2_PATH}"
export WINEPREFIX="${WINEPREFIX}"
EOF
info "Environment saved to $ENV_FILE"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
info "Installation complete."
echo ""
echo "  To run the map generator directly (Wine, no Docker):"
echo "    cd $MAP_DIR"
echo "    ./run.sh --seed 10 --map 1 --difficulty 0"
echo ""
if [ "$DOCKER_IMAGE_BUILT" = "true" ]; then
    echo "  To start the map server (Docker):"
    echo "    cd $MAP_DIR"
    echo "    $DOCKER_CMD run -v \"\$D2_PATH\":/app/game -p 8899:8899 blacha/diablo2"
    echo ""
else
    warn "Docker image was not built. To retry: bash $MAP_DIR/build.docker.sh"
    echo ""
fi
if ! groups "$USER" | grep -q '\bdocker\b'; then
    warn "Remember to log out and back in (or run 'newgrp docker') to use Docker without sudo."
fi
