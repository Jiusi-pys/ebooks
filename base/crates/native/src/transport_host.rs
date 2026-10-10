use crate::workspace::Workspace;
use std::sync::Arc;

/// Transport context independent of HTTP routing and platform UI.
pub struct SyncHost {
    pub workspace: Arc<Workspace>,
    read_only: bool,
}
impl SyncHost {
    pub fn new(workspace: Arc<Workspace>, read_only: bool) -> Arc<Self> {
        Arc::new(Self {
            workspace,
            read_only,
        })
    }
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }
}
