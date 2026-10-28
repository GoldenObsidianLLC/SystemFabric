# Wasm SIMD accelerator

`scan-special.c` is the source for `scan-special.wasm`, compiled with the WebAssembly SIMD128 feature. It scans ASCII bytes for HTML-sensitive characters and returns byte offsets. The JS wrapper deliberately falls back for non-ASCII input because UTF-8 byte offsets are not JavaScript string indices for non-ASCII strings.

Rebuild with a clang installation that includes the wasm32 target:

```sh
clang --target=wasm32 -O3 -msimd128 -nostdlib scan-special.c \
  -Wl,--no-entry -Wl,--export=scan_special -Wl,--export-memory \
  -Wl,--export=__heap_base -Wl,--initial-memory=131072 \
  -Wl,--max-memory=268435456 -Wl,--strip-all -o scan-special.wasm
```

This is an optional acceleration. Use it only after measuring the complete scan-and-escape path at realistic input sizes.
