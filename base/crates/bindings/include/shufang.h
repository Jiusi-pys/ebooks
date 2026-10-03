#ifndef SHUFANG_CORE_H
#define SHUFANG_CORE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* ABI 1. Buffers are owned by Rust; caller must core_free each input and result.
 * Write exactly core_buffer_len bytes into allocated input; do not resize it.
 * Never access a buffer concurrently with execute/free, or after free.
 * JSON commands carry version:1. UTF-8, maximum request size 16 MiB.
 * core_execute returns a separately owned JSON {ok,value} or {ok,error:{code}}.
 * Native session commands are absent from WASM; browser storage is an adapter.
 */
uint32_t core_abi_version(void);
uintptr_t core_alloc(size_t length);
size_t core_buffer_len(uintptr_t pointer);
uintptr_t core_execute(uintptr_t input);
void core_free(uintptr_t pointer);
#ifdef __cplusplus
}
#endif
#endif
