> 当前状态（2026-10-03）：见[工程状态与验收门槛](../../docs/current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Additional native binding examples

These are integration seams, not full Android, iOS or Linux applications.
All use ABI 1 from `base/crates/bindings/include/shufang.h`. Run blocking calls
off the UI thread and parse the returned `{ok,value}` / `{ok,error}` envelope.

- Linux: build `shufang-bindings`, then
  `c++ -std=c++17 platforms/examples/linux/main.cpp -Lbase/target/debug -lshufang_bindings -Wl,-rpath,$PWD/base/target/debug -o /tmp/shufang-core-example`.
  Run `/tmp/shufang-core-example`; it checks an exact clock beyond JS safe integers.
- Android: build Rust for the selected NDK target with its matching C toolchain;
  package `libshufang_bindings.so` and a `shufang_jni` library compiled from
  `android/bridge.cpp` and linked against the Rust library. JNI uses byte arrays
  to avoid Java modified-UTF-8 corrupting non-BMP text. Add NativeCore.kt to the
  app's `shufang.core` package. No Android build/runtime validation has run yet.
- iOS: build the Rust `staticlib` on macOS for `aarch64-apple-ios` or the exact
  simulator target, import the C header with a bridging header and link its
  static archive plus system libraries required by the target. Call from Swift
  through `ios/NativeCore.swift`. No iOS build/runtime validation has run yet.

Keep database paths, credentials, lifecycle and rendering in platform adapters;
do not copy domain algorithms into these bindings. Existing JSON/UTF-16 and
large-payload parity gates apply before importing user libraries on any target.
