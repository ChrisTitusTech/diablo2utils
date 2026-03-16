# Copilot Instructions

## Temporary Files

All temporary files must be written to the `tmp/` directory at the repository root (`/home/titus/github/diablo2utils/tmp/`), **not** to `/tmp/`. This keeps build artifacts, test outputs, and debug logs within the workspace for easy inspection and cleanup.

## Environment Setup

- WINE is used to launch Diablo 2 for map extraction
- MAP uses Diablo 1.13c files to read MPQ files. These are located in assets/d2/ directory. This is all done in a WINE bottle.
- MEMORY is the main package that reads Diablo 2's memory and extracts map seeds, difficulty, and act information. It will relay this information to MAP for map rendering and to the CLI for logging and debugging.