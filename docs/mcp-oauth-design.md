> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# MCP OAuth delivery plan (2026-09-30)

Source: https://developers.openai.com/plugins/build/auth

## Contract and design review

The existing six tools read only synchronized server data. ChatGPT uses OAuth;
stdio and the existing independent MCP key remain compatible. The deployment is
one Node process per independent node and one library owner, matching existing
application authentication. This is not a multi-tenant authorization model.

Expose RFC 9728 protected-resource metadata and RFC 8414 authorization metadata.
Use authorization code with mandatory PKCE S256, exact resource and redirect
binding, issuer identification on success/error redirects, and only
`library:read`. DCR registers public clients (`none`); initially allow only the
documented ChatGPT HTTPS callback paths. Additional callback URIs require explicit
operator configuration as exact URLs. No arbitrary metadata fetching (CIMD is
not advertised). Existing Codex/Claude key clients continue unchanged.

OpenAI recommends an established identity provider. This installation has an
existing local single-owner identity and no external IdP tenant. A deliberately
limited embedded authorization server reuses that login/password/session
validation, with no new password database. Do not extend this to a public
multi-tenant identity service without replacing it with an established IdP.

Authorization requires a fresh browser consent submission, same-origin checking,
a transaction-bound CSRF cookie and server-side validation of the current owner.
The authorization page uses existing `/api/auth/login` and session endpoints.
Cookies, password throttling and credential-version revocation remain owned by
the existing authentication module. No password/token is put into a URL or log.

Access tokens expire in 15 minutes; refresh grants expire absolutely in 30 days.
Opaque random tokens are stored only as SHA-256 hashes. Refresh rotates tokens;
reuse revokes the entire grant. Codes expire in five minutes and are single-use.
Each access checks resource, scope, expiry, grant revocation and current account
credential version. RFC 7009 revocation invalidates the grant. Bounded storage
and request sizes limit unauthenticated registration/authorization pressure.

## State upgrade, backup and rollback

MySQL and IndexedDB schemas and migration histories are unchanged. New optional
OAuth state uses `.runtime/mcp-oauth-v1.json`, version 1, mode 0600, atomic
same-directory replacement, and synchronous serialized transactions within the
single Node process. Unknown versions/corruption fail closed; never reset them
silently. Multiple processes must not share this file.

Upgrade starts from existing key-only deployments (including 8ba7ee0): back up
the runtime directory and environment outside the checkout, deploy the code,
set `MCP_OAUTH_ENABLED=true` and an exact HTTPS `PUBLIC_ORIGIN`, then restart.
First OAuth write creates v1; subsequent restarts preserve clients and grants.
Do not synchronize OAuth state across independent nodes. Existing SQL migration
chain still runs unchanged. File write failure must not return newly issued
credentials. A crash before atomic rename preserves old state; a leftover temp
file is ignored. Backups contain token hashes and owner identifiers: protect them.

Rolling back application code disables OAuth while preserving key access and the
new state file. To revoke all OAuth access, stop the app and move the state file
to a protected archive, then restart; clients must register/link again. Never
restore an older token-state snapshot during normal operation (that could revive
revoked grants); after disaster recovery discard OAuth grants and relink. This
does not roll back the database or alter reading records.

## TDD and release gates

Exercise discovery/challenges; safe DCR and callback rejection; login/consent
CSRF; authorization code success, PKCE failure, resource/client/redirect binding,
expiry/replay; token refresh/reuse/revocation; account invalidation; persistent
restart, storage corruption/write failure; actual MCP list/call with an OAuth
token and continued key compatibility. Run repository type/lint/test/build and
deployment supervisor checks. Deploy exact commit and validate public discovery,
401 challenge, DCR and a complete isolated OAuth flow. Final ChatGPT plugin
creation and owner consent are performed by the user.
