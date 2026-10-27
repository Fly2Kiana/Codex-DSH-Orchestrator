# Known issues

## Official Desktop qualification

The authenticated Gateway has Windows/macOS discovery and startup-handoff support. Runtime candidate `85fd145` passed 298 local Windows tests, 297 local Mac tests with one Windows-only skip, and all nine CI jobs. Both platforms completed one inherited read-only task and same-root follow-up. See [Validation](docs/validation.md) for the build identities and observed environments. Intel Mac and a real rc.3 product run remain unverified.

Gateway doctor leaves admission `not_probed`. A separately approved `dsh_host_status` can exchange authorization and open an API Peer. After changing the installation, confirm the actual MCP entry and Skill content before a smoke test.

The current rc.3 session catalog omits image modalities. Native vision therefore needs additional capability evidence. Timed questions remain with the Host, subagent-mode discovery is unavailable, and queue refresh relies on explicit observation/preflight. See [Gateway capabilities](docs/official-desktop-gateway.md#models-and-capabilities).

### Startup terminal and application icons

Keep the controlled-start terminal open. A fresh launch from an ordinary pinned shortcut or Dock entry does not receive that pipeline's temporary authorization. Restoring bridge access then requires another approved controlled start.

Direct executable startup produced a separate Windows taskbar group in the tested installation. The existing pinned shortcut was not changed; its grouping has not been corrected or qualified. The tested Mac launch retained one Dock icon. Neither observation guarantees another installation's icon behavior.

### Historical task lock warning

The Windows smoke still reported a lock warning while reconciling an unrelated historical task. The new task, follow-up and claim release completed. Existing locks and mappings were retained; new-session success does not establish recovery of that older task. Use the lock diagnostics below before planning any cleanup.

## Shared-ledger duplicate cursor

Fixed in `0.1.0-alpha.2`.

Multiple processes sharing `DSH_BRIDGE_HOME` could produce a duplicate cursor and `unrecoverable_gap`; the rejected ledger queue could then exit the MCP process. Two check-then-delete races let a stale owner observation remove a replacement lock.

The fix retries owner writes lost with `ENOENT` or `EEXIST` without deleting the current directory. Unexpected owner-write failures preserve the path: ownership cannot be proved after a competitor replaces it. Automatic stale-lock reaping is disabled because portable filesystem APIs cannot atomically compare an old observation with a later destructive rename.

When upgrading a shared home, schedule all participating bridge processes onto the compatible build. A remaining alpha.1 process can still violate the corrected locking rules. Keep incompatible or independently managed groups on separate homes.

### Crash recovery

Locks cover short critical sections on a local filesystem. They have no heartbeat, and PID/mtime observations are unsuitable for NFS. A hard kill during ownership, or an `ENOSPC`/`EIO` owner-write failure, can leave a directory that blocks later operations.

Before manual cleanup, stop every bridge process using that home during an agreed window, preserve a backup and inspect the exact directory and ownership. Avoid deleting a whole bridge home. A fresh home allows new delegations but starts new task mappings, claims and cursors; DSH keeps its conversation history.

### Read-only lock diagnostics

Doctor reports structure at `claims/registry.lock` and `ledgers/<valid task id>/events.lock`: path/owner presence, filesystem types and bounded entry observations. Scans report truncation. It leaves directories intact and does not read `owner.json` content, acquire locks or infer ownership/liveness from a snapshot.

Windows lock acquisition retries transient `EPERM` within a bounded window and retains persistent permission errors. This does not repair ACLs or authorize deleting a lock.

### Existing large ledgers

Ingestion skips new top-level `session/projection` snapshots and high-frequency assistant chunks; `session/jobs` remains durable with coordination-only payloads. Existing ledgers, including those larger than 5 MB, are not compacted. Preserve them for diagnosis or use a separate home for new work. `session.history` remains the conversation source.

## Windows file modes and installer paths

Windows uses ACLs, so Node cannot round-trip Unix `0600`, `0640` or `0700` mode bits. `stat` commonly reports `0666`. Tests check supported Windows representations and exact POSIX modes on Unix; this is not an ACL audit.

The installer rejects symlinked directories and non-regular configuration targets, checks stale snapshots and verifies the installed bytes. macOS temp fixtures canonicalize the system temp root before testing this policy; production symlink rejection is unchanged.

## Dependency snapshot

The SDK/Zod migration updates the reviewed lockfile and passed a zero-advisory npm audit snapshot. Audit data changes over time; review the final release tree and dependency alerts again before publication. No automatic `npm audit fix` or permissions change is part of setup.
