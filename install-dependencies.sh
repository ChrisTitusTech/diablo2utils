#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required before installing project dependencies." >&2
  exit 1
fi

if command -v yarn >/dev/null 2>&1; then
  YARN_CMD=(yarn)
elif command -v corepack >/dev/null 2>&1; then
  YARN_CMD=(corepack yarn)
elif [[ "$DRY_RUN" == true ]]; then
  YARN_CMD=(yarn)
else
  echo "Yarn is required for this workspace. Install Yarn or enable Corepack first." >&2
  exit 1
fi

WORKSPACES=()
if [[ -d "$ROOT_DIR/packages" ]]; then
  while IFS= read -r workspace_dir; do
    WORKSPACES+=("${workspace_dir#"$ROOT_DIR/"}")
  done < <(find "$ROOT_DIR/packages" -mindepth 1 -maxdepth 1 -type d | sort)
fi

echo "Installing dependencies for the diablo2 workspace"
echo "Root: ."
for workspace in "${WORKSPACES[@]}"; do
  echo "Workspace: $workspace"
done

INSTALL_CMD=("${YARN_CMD[@]}" install --non-interactive "$@")

if [[ "$DRY_RUN" == true ]]; then
  printf 'Dry run:'
  printf ' %q' "${INSTALL_CMD[@]}"
  printf '\n'
  exit 0
fi

"${INSTALL_CMD[@]}"
