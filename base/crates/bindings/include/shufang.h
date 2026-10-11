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
#ifdef __APPLE__
#include <TargetConditionals.h>
#if TARGET_OS_OSX
/* Optional trusted macOS Keychain host. Callbacks remain valid for process life.
 * store: 0 success; nonzero failure. load: byte count, -2 absent, -1 failure.
 * No caller-owned output allocation; write at most capacity bytes.
 * Installation is immutable, null callbacks return 0. ABI 1 is unchanged.
 */
typedef int32_t (*core_mac_store)(const uint8_t *, size_t, const uint8_t *, size_t, const uint8_t *, size_t);
typedef intptr_t (*core_mac_load)(const uint8_t *, size_t, const uint8_t *, size_t, uint8_t *, size_t);
uint32_t core_install_mac_credentials(core_mac_store store, core_mac_load load);
#endif
#endif
#ifdef __cplusplus
}
#endif
#endif
