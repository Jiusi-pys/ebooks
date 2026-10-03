/** Low-level adapter. Business logic remains in Rust; this owns only buffers. */
export interface CoreExports {
  memory: { buffer: ArrayBuffer };
  core_abi_version(): number;
  core_alloc(length: number): number;
  core_buffer_len(pointer: number): number;
  core_execute(pointer: number): number;
  core_free(pointer: number): void;
}

export class WasmCore {
  private readonly exports: CoreExports;
  constructor(bytes: Uint8Array) {
    const wasm = (
      globalThis as unknown as {
        WebAssembly: {
          Module: new (bytes: Uint8Array) => unknown;
          Instance: new (module: unknown) => { exports: unknown };
        };
      }
    ).WebAssembly;
    this.exports = new wasm.Instance(new wasm.Module(bytes))
      .exports as unknown as CoreExports;
    if (this.exports.core_abi_version() !== 1)
      throw new Error("unsupported_core_abi");
  }

  execute<T>(command: string, parameters: Record<string, unknown>): T {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...parameters, version: 1, command })
    );
    const input = this.exports.core_alloc(bytes.length);
    if (!input) throw new Error("core_allocation_failed");
    let output = 0;
    try {
      new Uint8Array(this.exports.memory.buffer, input, bytes.length).set(
        bytes
      );
      output = this.exports.core_execute(input);
      const length = this.exports.core_buffer_len(output);
      if (!output || !length) throw new Error("core_execution_failed");
      const response = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(this.exports.memory.buffer, output, length)
        )
      ) as { ok: true; value: T } | { ok: false; error: { code: string } };
      if (!response.ok) throw new Error(response.error.code);
      return response.value;
    } finally {
      this.exports.core_free(input);
      if (output) this.exports.core_free(output);
    }
  }
}
