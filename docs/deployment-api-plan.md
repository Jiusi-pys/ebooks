> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# GitHub push deployment plan

## Contract

Pushes to `Jiusi-pys/ebooks` branch `main` run checks and call the HTTPS
`POST /api/deploy` endpoint with `{ "sha": "<40 lowercase hex characters>" }`.
A dedicated bearer secret authenticates this endpoint and `GET /api/deploy`.
The server fixes the repository and branch in its configuration; requests cannot
choose a command, repository, branch, path, or environment file.

The endpoint returns 202 and a job ID. One update runs at a time. Duplicate
requests for the same active/successful SHA reuse that job. Actions polls the
job to completion; a failed deployment fails the workflow.

## Deployment

A separate loopback-only Python service survives application restarts. Nginx
routes only `/api/deploy` to it. It fetches `main`, rejects stale SHAs, checks out
the exact SHA in a fresh temporary directory and builds a tagged Docker image.
The build leaves the running application available. Before switching it runs
database migrations and records the old container. The old container is stopped
and renamed, the new container starts with the existing environment and runtime
volume, and HTTP/database readiness plus Docker state are checked. Failure
removes only the candidate and restores the previous container. Success retains
the previous container for manual recovery.

Database changes are not rolled back. Migrations must remain compatible with
the previous application; destructive migrations require a separate backup and
maintenance procedure. The deployment API never accepts migration commands.

## Review and validation gates

- Authentication before parsing, bounded request body, fixed repository/main,
  exact SHA validation, shell-free argument arrays, one deployment at a time.
- Durable job status; interrupted jobs marked failed after service restart.
- TDD: auth/input/idempotency/concurrency/restart behavior and rollout rollback.
- Run application type checks, lint, tests and build; document existing failures.
- Install service and dedicated GitHub secret; verify HTTPS authentication and
  status without deploying the older GitHub HEAD over local fixes.
- Commit/push must include the preceding reader/digest fixes before the first
  automatic rollout, otherwise GitHub does not contain the currently live fixes.

## Implementation status

Implemented and first deployed in `cc952ae`. The first push workflow succeeded,
and a subsequent manual main workflow verified the update API's same-SHA reuse.
See [deployment acceptance](deployment-acceptance-20260927.md) for dated evidence.
Database migration design now follows the mandatory append-only, archived-history
and multi-version upgrade rules in the root AGENTS.md. No schema migration is
introduced by this documentation/policy update.
