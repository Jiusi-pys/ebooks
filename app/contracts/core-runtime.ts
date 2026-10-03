import { coreBase64 } from "../generated/core-bytes";
import { WasmCore } from "./core-wasm";

let runtime: WasmCore | undefined;
export function sharedCore(): WasmCore {
  return (runtime ??= new WasmCore(
    Uint8Array.from(atob(coreBase64), character => character.charCodeAt(0))
  ));
}
