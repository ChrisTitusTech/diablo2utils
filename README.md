# @diablo2

[![Build Status](https://github.com/blacha/diablo2/workflows/Build/badge.svg)](https://github.com/blacha/diablo2/actions)

Tools to work with diablo2 

- [bintools](./packages/bintools) - Diablo2 (Classic) Binary parsers to read the `.bin` files  
- [huffman](./packages/huffman) - Diablo2 (Classic) Decompressor for network data
- [packets](./packages/packets) - Diablo2 (Classic) network protocol
- [mpq](./packages/mpq) - MPQ reader / extractor
- [map](./packages/map) - Diablo2 (Classic & Resurrected)  map generation api (Docker based) 
- [memory](./packages/memory) - Diablo2 (Resurrected) Memory reader

## Diablo2 Resurrected 

![D2 Resurrected MapHack](./assets/2021-09-30-d2r-maphack.jpeg)

## Building

Install workspace dependencies from the repository root:

```bash
./install-dependencies.sh
```

Or, if Yarn is already available:

```bash
yarn install:deps
```

Build the TypeScript workspace packages from the repository root:

```bash
yarn build
```

This root build covers the TypeScript project references under `packages/*`.

The overlay package is not part of the root TypeScript solution build. Build it separately from [packages/overlay/README.md](./packages/overlay/README.md):

```bash
cd packages/overlay
./build.sh
```

If you already have Yarn installed and just want the combined root flow:

```bash
yarn
yarn build
```