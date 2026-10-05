use futures_util::future::BoxFuture;
use shufang_service::codex_auth::{Controller, Process, Runner};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
struct Fake {
    authenticated: Arc<AtomicBool>,
    logins: Arc<AtomicUsize>,
    release: Arc<tokio::sync::Notify>,
}
impl Runner for Fake {
    fn run(&self, args: Vec<String>, _: u64) -> BoxFuture<'static, Result<Process, String>> {
        let authenticated = self.authenticated.clone();
        let logins = self.logins.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if args == ["login", "status"] {
                return Ok(Process {
                    code: if authenticated.load(Ordering::SeqCst) {
                        0
                    } else {
                        1
                    },
                    stdout: "ChatGPT".into(),
                    stderr: String::new(),
                });
            }
            if args == ["login"] {
                logins.fetch_add(1, Ordering::SeqCst);
                release.notified().await;
                authenticated.store(true, Ordering::SeqCst);
            }
            if args == ["logout"] {
                authenticated.store(false, Ordering::SeqCst);
            }
            Ok(Process {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        })
    }
}
#[tokio::test]
async fn concurrent_login_is_singleton_and_logout_never_overlaps_login() {
    let count = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let controller = Controller::with_runner(Arc::new(Fake {
        authenticated: Arc::new(AtomicBool::new(false)),
        logins: count.clone(),
        release: release.clone(),
    }));
    let (first, second) = tokio::join!(controller.login(), controller.login());
    assert_ne!(first.unwrap()["started"], second.unwrap()["started"]);
    tokio::task::yield_now().await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(controller.logout().await.is_err());
    release.notify_one();
    for _ in 0..10 {
        tokio::task::yield_now().await;
        if controller.status().await["loginRunning"] == false {
            break;
        }
    }
    assert_eq!(controller.status().await["authenticated"], true);
    assert_eq!(controller.logout().await.unwrap()["authenticated"], false);
}
