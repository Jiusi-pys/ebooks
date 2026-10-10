import subprocess,tarfile,io,hashlib,json,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Export the minimal conditional-sync server patch from the production baseline. Build with rust:1.93.1-slim-bookworm, not the rolling slim tag.')
parser.add_argument('--output',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1];dest=Path(args.output).resolve()
if dest.exists():raise SystemExit('Output must be a new directory; preserve prior release artifacts.')
dest.mkdir(parents=True)
base='3cbda7f69e1d02f5d9b5c81e7644712b19054c8f'
archive=subprocess.run(['git','-C',str(root),'archive',base,'base','app/db/migrations'],capture_output=True,check=True).stdout
with tarfile.open(fileobj=io.BytesIO(archive)) as tar: tar.extractall(dest,filter='data')
paths=['base/crates/mysql/src/lib.rs','base/crates/service/src/sync_v2.rs','base/crates/service/src/sync_openapi.rs','base/crates/service/tests/sync_v2.rs']
for path in paths: (dest/path).write_bytes((root/path).read_bytes())
path=dest/'base/crates/application/src/replication.rs'
text=path.read_text();marker='    pub fn replication_operation(&self, id: &str)'
assert marker in text
guard='''    /// Optional v2 conditional writes; duplicates precede stale-state rejection.
    pub fn replication_entity_state(&self, kind: &str, id: &str) -> Result<Option<shufang_domain::sync::EntityState>> {
        if !shufang_domain::sync::ENTITY_KINDS.contains(&kind) || !shufang_domain::sync::valid_identifier(id) { return Err("invalid_entity_query".into()); }
        Ok(self.repository.load(kind, id)?.map(|row| row.state))
    }
    pub fn check_sync_precondition(&self, op: &Operation, expected: Option<&shufang_domain::sync::EntityState>) -> Result<bool> {
        if let Some(prior) = self.replication_operation(&op.operation_id)? {
            if !shufang_domain::sync::equivalent_operation(&prior, op) { return Err("operation_id_reused".into()); }
            return Ok(true);
        }
        if self.replication_entity_state(&op.kind, &op.entity_id)?.as_ref() != expected { return Err("sync_precondition_failed".into()); }
        Ok(false)
    }
'''
text=text.replace(marker,guard+marker);path.write_text(text)
paths.append('base/crates/application/src/replication.rs')
manifest={'baseline':base,'schemaChanged':False,'mysqlWriterRecoveryPreserved':True,'files':{p:hashlib.sha256((dest/p).read_bytes()).hexdigest() for p in paths}}
(dest/'source-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest,indent=2))
