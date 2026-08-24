# Security Policy

## Supported version and evidence status

This document defines the security contract of the current code. It does not by itself prove that those bytes are published or verified in a real host.

- Query the public npm version from the official registry and verify tags, Releases, assets, checksums, and SBOMs on GitHub. Do not infer release status from a manifest, historical note, or expected filename.
- Codex and ZCode installation, restart discovery, MCP consumption, controlled-change E2E, cancellation, and deadline claims remain **UNKNOWN / PENDING** for a candidate until the real-host checklist is executed against the exact same bytes.
- A local test, package smoke, checksum, SBOM, or release-gate result does not establish an npm publish, Git tag, GitHub Release, host isolation, or the absence of all defects.

Older architecture documents are design/history material. The current source, tests, this file, and the README are authoritative for the checked-out implementation.

## Product and threat-model scope

Stinky Cobbler is a **verifiable permission and change gate for local repositories used from Codex or ZCode**. It is a local CLI/MCP control plane; it is not a model, autonomous host, operating-system sandbox, identity provider, trusted clock, or external audit service.

It operates in **Cooperative Mode**. Only operations routed through its CLI/MCP boundary receive the controls described below. Host-native file tools, Shell, Git writes, third-party MCP servers, or direct control-plane edits can bypass it. Strong mediation requires a separately isolated host/worker that exposes only governed tools; this repository neither supplies nor proves that isolation.

“Local” refers to this process and its workspace metadata. It does not prove that Codex, ZCode, the selected model provider, plugins, or alternate host tools are offline or keep all content on the machine.

The public Runtime is limited to the built-in `scripted-readonly` adapter and `repository-read` / `repository-list`. Shell, tests, network, deployment, production access, `host-injected`, and `test-run` are not public Runtime capabilities.

## TaskAuthority and capability delegation

`src/storage/task-authority.ts` is the central persisted authority gate for supported capabilities.

1. It reloads the Task from workspace storage and hashes the authority-bearing fields: state, risk, data classification, scope, writeSet, approval settings/references, constraints, and stop conditions.
2. It checks that the Task state admits the requested capability, rejects L3, and ensures requested read/write scope is inside the persisted Task.
3. It checks adapter capability support where an adapter is involved.
4. Lease issuance checks the canonical role-to-tools registry. Use-time admission maps the concrete operation back to its required role tool and checks it again; an unknown role, absent mapping, disallowed tool, or capability/operation mismatch fails closed.
5. The internal `worker` role is not a general bypass: it is admitted only for an orchestration-derived Lease bound to an exact subtask and retry attempt.
6. A child Lease cannot change its parent capability, expand read/write scope, exceed call/expiry budget, cross Task authority hash, or cross the bound host session.
7. Persisted Leases are re-admitted against the current Task, policy, Approval, parent state, role, and concrete operation at use time. Task drift, Approval revocation/expiry, parent revocation, scope expansion, or role-tool drift fails closed.

For `repository-write` and any L2 Task, a current precise `delegate-capability` Approval is required. A root Approval binds:

- `subjectKind=task-authority`, Task ID, and the exact Task authority hash;
- capability and exact root scope;
- policy version;
- requester, decision actor, expiry, and nonce;
- maximum tool calls and budget expiry.

A Lease derived from an approved grant may narrow these bounds but cannot widen them. Approval records, Leases, and hashes are still local bearer/control-plane data, not cryptographic proof of a real person's identity. An actor able to rewrite the control-plane storage is outside this guarantee.

The host Skills require the user to choose a direct Lease duration, but `issueLease` itself accepts an explicit duration or a configured default. The `issuedBy` label alone is not proof that a human interaction occurred. The enforceable engine boundary is the precise Approval budget/expiry, persisted Lease fields, and re-admission described above.

## Controlled writes and preimage binding

Each WriteIntent admits exactly one target. The current sequence is:

1. Validate the active Task/plan or run/subtask and a precise `repository-write` capability delegation.
2. Resolve the target under current path/sensitive-file policy.
3. Capture the target's current SHA-256 bytes as `expectedPreimageHash`; a create intent records `null`.
4. Hash the immutable WriteIntent subject.
5. For the explicit path, consume a one-shot `write-confirm` Approval bound to the intent ID/version/hash, exact target scope, expected preimage, capability, policy, requester/decision metadata, nonce, and budget. It may also bind the proposed content hash.
6. At apply time, reload the authoritative intent and Lease, re-run TaskAuthority and run/step binding, then re-read the preimage. Drift fails with `WRITE_PREIMAGE_MISMATCH`; a new intent and approval are required.

Low-risk create/modify intents may be created with `autoAllowed=true`. This skips only the one-shot `write-confirm` Approval. It does **not** skip TaskAuthority's precise capability Approval, the persisted Lease, writeSet/path checks, the immutable intent hash, or the preimage check. Delete can never be auto-allowed.

For an existing target, the pre-operation backup is created with no-clobber semantics; an existing backup blocks retry. Before the business-file mutation, the engine persists an `UNCERTAIN` recovery journal. Only after Evidence and ledger persistence succeed may the intent become `APPLIED`. These records are not one database transaction: a crash can leave changed business bytes with `RECOVERY_REQUIRED`, but must not synthesize a successful final state.

Automatic rollback requires a complete single-target `APPLIED` journal and no third-party/policy conflict. A create rollback removes the created file only while its bytes match the recorded post-image; modify/delete restores a private regular backup only while the target state is consistent. There is no multi-target all-or-nothing guarantee and no promise that a pre-`APPLIED` crash can be recovered automatically.

## Runtime cancellation and deadline boundary

Runtime cancellation/deadline is cooperative:

- The in-process `BudgetSupervisor` uses a monotonic clock, a timer, boundary checks, and an `AbortSignal`.
- Each broker call is raced with that signal and checks it before/after the read and Evidence persistence.
- A persisted terminal Run wins finalization races, so an old owner cannot overwrite a cancellation/recovery result.
- `runtime cancel` returns `CANCEL_REQUESTED` when an active same-process supervisor was signalled; callers must inspect the final persisted Run.

This is not a thread/process kill, OS interrupt, or Codex/ZCode Agent cancellation API. A Promise already in flight may continue after the caller stops awaiting it. If cancellation/deadline wins while a tool call is in flight, whether the underlying operation completed is UNKNOWN; the Runtime receipt records that uncertainty. The public broker is read-only, but the mechanism must not be generalized into a hard-stop claim for arbitrary side effects.

The deadline is process-local and applies only while that Runtime execution is alive and yielding to the event loop. It is not trusted time and does not terminate an external host Agent.

After each successful read call, the Runtime checkpoints tool-call references, Evidence references, and budget usage into the authoritative Run under its owner token and fence epoch. This narrows the process-crash loss window but is not an Evidence/Run/Receipt/ledger transaction. Run creation canonically hashes the complete Capsule, executor, and ordered requests; terminal retry, Receipt, and finalization must carry that exact `executionRequestHash`, and Capsule `policyVersion` must equal the authoritative persisted Lease. Legacy records missing the hash remain inspectable but cannot be retried or finalized as a current success. Terminal success or failure additionally requires a durable `PREPARED → COMMITTED` finalization journal that binds the exact terminal Run, one deterministic Receipt, and one exact audit effect. Read-only inspection reports missing, prepared, invalid, or mismatched finalization; `runtime reconcile --repair` replays only a deterministic prepared tail. Missing/invalid/conflicting journals fail closed and cannot be silently synthesized as success. `runtime recover` is only stale-RUNNING owner recovery and is not a finalization repair command.

Orchestration cancellation is a separate durable state fence: it writes a cancellation marker, revokes related active Leases, rejects pending/confirmed WriteIntents, and blocks later governed mutations. It does not undo already-applied files or kill host-created workers.

Manual orchestration escalation uses its own durable transaction journal. An exact retry may finish a published target's audit tail, but after cancellation has durably begun an unpublished `PREPARED` escalation cannot publish its target or escalation audit; cancellation records it as `ABORTED` before completing the Run fence.

## Orchestration, review, context, and memory boundary

The `orchestration` domain persists contracts, runs, subtasks, attempt generations, retry/budget state, file-artifact hashes, engine-created ValidatorReceipts, review records, and cancellation fences. It does not create or supervise real Codex/ZCode workers by itself. Automatic multi-Agent execution, host process/worktree isolation, and actual creation of an independent reviewer are therefore not source-proven product guarantees.

At Contract creation, the workspace Profile is resolved into an immutable `reviewPolicy` snapshot. `individual` becomes `SELF_REVIEW_AUDITED`; same-source review may be recorded only with `SELF_REVIEW_NON_INDEPENDENT` / `sameSourceReview` labeling. `team`, `organization`, and `regulated` become `INDEPENDENT_REQUIRED` and reject a review whose `reviewedBy` equals the dispatched executor. Missing configuration and legacy Contracts without the field also use `INDEPENDENT_REQUIRED` fail-closed. Later Profile changes do not mutate the Contract. These rules do not prove process, filesystem, reviewer identity, or host-session isolation.

Only a workspace file that the engine re-reads and hashes can become a `VERIFIED` orchestration artifact. `summary` and `evidence` artifact kinds are rejected. A hash proves byte identity at the observed path, not authorship, semantic correctness, or safe provenance.

Orchestration mutations carry explicit replay generations. Dispatch requires the caller-observed inactive Subtask `retriesUsed`; begin, artifact report, and review require the exact `activeAttempt` returned by dispatch. Human resume requires the current escalation's next `resumeGeneration`. Old generations fail closed. Repeating an exact create request returns its original Run even after terminal state; an intentional successor must bind a unique terminal predecessor through `supersedesRunRef` / `--supersedes-run`. These record-level fences do not stop an external worker process.

The current implementation does not provide CAS, structured Context/Memory, summary compression, retrieval, conflict resolution, expiry/revocation, or cross-session memory recovery. These capabilities must not be described as present.

## Workspace, path, and audit boundaries

Workspace MCP admission requires a regular, parseable `.stinky-cobbler/workspace.json`, valid cross-referenced configuration, and no unresolved audit outbox state. Repository, docs-index, Git, write, and rollback paths are rechecked against workspace/sensitive-path rules. The Git reader disables inherited redirection/config execution surfaces and rejects external/linked metadata, but portable path checks do not eliminate same-user races, mount tricks, or every Git implementation risk.

Control-plane JSON/JSONL writes use a workspace-wide local lock and durable-write helpers. Existing locks are not automatically reclaimed; stale, ownerless, or malformed locks remain busy until an operator independently proves no live holder and performs explicit diagnosis. This is not a distributed lock.

The SHA-256 ledger can check the self-consistency of the chain it reads. It cannot prove that no one rewrote the complete chain, that an event occurred at a trusted time, that an actor had a real-world identity, or that operations outside the governed path did not happen.

## Host installation and managed upgrade boundary

`entry install-host` has no `postinstall` hook and must be invoked explicitly. Dry-run reports target paths plus before/after version and SHA-256 metadata without printing the full host configuration. Command/Skill files are auto-upgraded only when their current bytes match either the recorded managed-install hash or an exact known prior bundled hash. The current compatibility table recognizes only exact SHA-256 bytes for the supported 2.0.0 ZCode command, ZCode Skill, and Codex Skill templates; version-looking text is never authority. Otherwise the action is `conflict` and user content is preserved.

Managed replacement creates an exclusive byte-for-byte, content-addressed backup named with the prior SHA-256 and a local `<target>.stinky-cobbler-managed.json` sidecar containing version/hash/backup metadata. `--rollback` restores that verified backup only while the current target still matches the installed hash and the backup is a regular non-link file whose bytes match the recorded hash; post-install user edits, missing/drifted targets or backups, links, and concurrent target changes fail closed. MCP config merge preserves unrelated parsed fields, backs up the complete prior config, and recognizes an existing server only when command and args exactly match. This is local file safety, not a guarantee against a same-user attacker or a process that wins the final filesystem race.

Business-file rollback is separately fenced. `write rollback` first persists a `RECOVERY_REQUIRED` rollback journal; after interruption, `write rollback-recover` may idempotently finish only when the target matches the journal's pre-rollback or restored hash and the backup remains valid. Third-party bytes, incomplete journals, policy drift, or backup drift require manual diagnosis and are never overwritten.

## Release gate

The supported runtime is Node.js `>=22.0.0`. Candidate verification must be rerun on the final bytes and includes typecheck/tests, integration/package smoke, version consistency, package/offline-asset verification, SBOM/lockfile reconciliation, checksums, and registry audit. The exact tarball selected for checksum/upload must itself be installed and scanned for required/forbidden paths, sensitive signatures, CLI/MCP behavior, and both host templates; scanning an earlier independently packed tarball is not equivalent. SBOM and checksums are integrity/inventory artifacts, not signatures or vulnerability-free guarantees.

Formal release additionally requires real Codex and ZCode installation/restart/consumer E2E for this exact candidate, final diff review, and separate authorization/evidence for commit, push, tag, GitHub Release/assets, and npm publication. None of those public actions is automatic.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub Security Advisories](https://github.com/LJunP/StinkyCobbler/security/advisories/new), the project's formal private reporting channel. Include the affected version, a minimal reproduction, impact, and sanitized logs. Never include API keys, tokens, private keys, credentials, personal data, or production information.
