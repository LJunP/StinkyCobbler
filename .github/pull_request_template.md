## What this changes

Describe the problem, the chosen change, and explicit non-goals.

## Product and security boundary

- [ ] The change remains within Cooperative Mode and does not claim host sandboxing or universal mediation.
- [ ] Engine-enforced behavior is separated from host-procedural or declared-only behavior.
- [ ] Authority, scope, failure, recovery, audit, and user-data effects are documented.
- [ ] Security-sensitive changes fail closed and do not silently broaden permissions.

## Compatibility and migration

- [ ] CLI, schema, config, persisted records, host installation, and downgrade/rollback effects were reviewed.
- [ ] User-edited host files are preserved; managed upgrades/rollbacks have a dry-run and exact-byte checks.
- [ ] Relevant changes are reflected in `CHANGELOG.md`, `docs/支持矩阵.md`, and `docs/兼容与迁移政策.md`.

## Verification

List exact commands and outcomes. Mark real-host checks separately from local tests.

- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Relevant integration/package/host checks
- [ ] `git diff --check`

## Remaining unknowns and rollback

State what was not verified and how the change can be safely reverted or recovered. Merging this PR does not authorize a tag, GitHub Release, npm publish, deployment, or other external action.
