import { fieldObject } from "../../contracts/core-field-objects";
import {
  flattenFields,
  makeOperation,
  type Operation,
} from "../../contracts/sync";
import { BlobStore, chunkSize } from "./blobs";
import { digest, SyncError } from "./store";

/** Local command adapter. Publisher-supplied sync operations never enter here. */
export async function localOperation(
  workspace: string,
  replica: string,
  kind: Operation["kind"],
  id: string,
  input: Record<string, unknown>,
  blobs: BlobStore | undefined,
  now = Date.now()
): Promise<Operation> {
  const fields = flattenFields(kind, JSON.parse(JSON.stringify(input)));
  for (const [key, value] of Object.entries(fields)) {
    const object = fieldObject(value);
    if (!object) continue;
    if (!blobs) throw new SyncError("field_storage_required");
    const manifest = object.reference.$blob;
    const upload = await blobs.create(manifest);
    if (!upload.present)
      for (let index = 0; index < upload.chunks; index++) {
        const part = Buffer.from(
          object.bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
        );
        await blobs.put(upload.id, index, part, digest(part));
      }
    const committed = await blobs.commit(upload.id);
    if (
      committed.sha256 !== manifest.sha256 ||
      committed.size !== manifest.size
    )
      throw new SyncError("field_manifest_mismatch");
    fields[key] = object.reference;
  }
  return makeOperation(workspace, replica, kind, id, fields, now);
}
