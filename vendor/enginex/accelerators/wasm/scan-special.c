#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

// Input and output use offsets in linear memory. `out` is a uint32_t array
// of byte offsets. Returns number of indices written (bounded by capacity).
__attribute__((export_name("scan_special")))
uint32_t scan_special(uint32_t input_offset, uint32_t length,
                      uint32_t output_offset, uint32_t capacity) {
  const uint8_t *input = (const uint8_t *)(uintptr_t)input_offset;
  uint32_t *output = (uint32_t *)(uintptr_t)output_offset;
  uint32_t count = 0;
  uint32_t i = 0;
  const v128_t amp = wasm_i8x16_splat('&');
  const v128_t lt = wasm_i8x16_splat('<');
  const v128_t gt = wasm_i8x16_splat('>');
  const v128_t dq = wasm_i8x16_splat('"');
  const v128_t sq = wasm_i8x16_splat('\'');
  for (; i + 16 <= length; i += 16) {
    v128_t bytes = wasm_v128_load(input + i);
    v128_t mask = wasm_v128_or(
      wasm_v128_or(wasm_i8x16_eq(bytes, amp), wasm_i8x16_eq(bytes, lt)),
      wasm_v128_or(wasm_v128_or(wasm_i8x16_eq(bytes, gt), wasm_i8x16_eq(bytes, dq)), wasm_i8x16_eq(bytes, sq))
    );
    uint32_t bits = (uint32_t)wasm_i8x16_bitmask(mask);
    while (bits != 0) {
      uint32_t bit = (uint32_t)__builtin_ctz(bits);
      if (count < capacity) output[count] = i + bit;
      count++;
      bits &= bits - 1;
    }
  }
  for (; i < length; i++) {
    uint8_t c = input[i];
    if (c == '&' || c == '<' || c == '>' || c == '"' || c == '\'') {
      if (count < capacity) output[count] = i;
      count++;
    }
  }
  return count;
}
