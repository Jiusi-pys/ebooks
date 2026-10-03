import { sharedCore } from "./core-runtime";
import type { EntityState, Operation } from "./sync";

/**
 * Field-version merging never inspects payload contents. Keep opaque payloads
 * in host-owned slots during the synchronous call instead of copying book text
 * through UTF-8 JSON/WASM. This preserves legacy UTF-16 and large field values;
 * Rust still makes every version, unset, progress and tombstone decision.
 */
function fieldCodec() {
  const values: unknown[] = [];
  const keys = new Map<string, string>();
  const decodedKeys = new Map<string, string>();
  let keyPrefix = "@core-key:";
  const loneSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  function reserveKeys(names: string[]) {
    while (names.some(name => name.startsWith(keyPrefix)))
      keyPrefix = `@${keyPrefix}`;
    for (const name of names) {
      if (!loneSurrogate.test(name) || keys.has(name)) continue;
      const encoded = `${keyPrefix}${keys.size}`;
      keys.set(name, encoded);
      decodedKeys.set(encoded, name);
    }
  }
  const key = (name: string) => keys.get(name) ?? name;
  function encode(value: unknown): unknown {
    // Preserve JavaScript truthiness for the progress rule; all other values
    // are opaque to this operation and represented by unforgeable call-local IDs.
    if (value === null || value === false || value === 0 || value === "")
      return value;
    const slot = values.push(value) - 1;
    return { slot };
  }
  function decode(value: unknown): unknown {
    if (value === null || value === false || value === 0 || value === "")
      return value;
    const slot = (value as { slot?: unknown })?.slot;
    if (
      !Number.isInteger(slot) ||
      typeof slot !== "number" ||
      slot < 0 ||
      slot >= values.length
    )
      throw new Error("invalid_core_value_reference");
    return structuredClone(values[slot]);
  }
  function encodeState(state: EntityState | undefined): EntityState | null {
    if (!state) return null;
    return {
      ...state,
      fields: Object.fromEntries(
        Object.entries(state.fields).map(([name, field]) => [
          key(name),
          {
            ...field,
            ...(Object.hasOwn(field, "value")
              ? { value: encode(field.value) }
              : {}),
          },
        ])
      ),
    };
  }
  function decodeState(state: EntityState): EntityState {
    return {
      ...state,
      fields: Object.fromEntries(
        Object.entries(state.fields).map(([name, field]) => [
          decodedKeys.get(name) ?? name,
          {
            ...field,
            ...(Object.hasOwn(field, "value")
              ? { value: decode(field.value) }
              : {}),
          },
        ])
      ),
    };
  }
  return { reserveKeys, key, encode, encodeState, decodeState };
}

export function applyCoreOperation(
  prior: EntityState | undefined,
  operation: Operation
): EntityState {
  const codec = fieldCodec();
  const names = [
    ...Object.keys(prior?.fields ?? {}),
    ...Object.keys(operation.patch),
    ...operation.unset,
  ];
  // Encoding a legacy field name must not bypass the wire-format size limit.
  if (
    [...Object.keys(operation.patch), ...operation.unset].some(
      name => name.length < 1 || name.length > 256
    )
  )
    throw new Error("reserved_or_invalid_field");
  codec.reserveKeys(names);
  const encodedOperation = {
    ...operation,
    patch: Object.fromEntries(
      Object.entries(operation.patch).map(([name, value]) => [
        codec.key(name),
        codec.encode(value),
      ])
    ),
    unset: operation.unset.map(codec.key),
  };
  return codec.decodeState(
    sharedCore().execute<EntityState>("applyOperation", {
      prior: codec.encodeState(prior),
      operation: encodedOperation,
    })
  );
}

export function mergeCoreStates(
  prior: EntityState | undefined,
  incoming: EntityState
): EntityState {
  const codec = fieldCodec();
  codec.reserveKeys([
    ...Object.keys(prior?.fields ?? {}),
    ...Object.keys(incoming.fields),
  ]);
  return codec.decodeState(
    sharedCore().execute<EntityState>("mergeStates", {
      prior: codec.encodeState(prior),
      incoming: codec.encodeState(incoming),
    })
  );
}
