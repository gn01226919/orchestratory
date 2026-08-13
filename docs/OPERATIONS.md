# Safe operations and removal

> Current commands below describe the legacy runtime. Under ADR-028, candidate retention, completion preview,
> main-merge approval, promotion recovery, and cleanup are separate operations. Rejecting a merge never authorizes
> candidate cleanup, and main-merge approval never authorizes push, publish, deployment, or data purge.

## Inventory before mutation

Run these read-only commands first:

```text
orchestrator config show
orchestrator workspaces list
orchestrator worktrees list
orchestrator data inventory
orchestrator data integrity
orchestrator data purge
```

Inventory and integrity include the workflow store, Room Ledger, external-terminal presence and exact inbox,
managed Room Agents, Writer Leases, Writer delegations, the HMAC collaboration audit chain and the persistent
provider-call governor.
The GUI emergency stop increments a shared kill epoch: in-flight calls in every process are aborted, and
already-running workflows cannot continue into their next provider or tester boundary.

## Hourly read-only supervisor

`ops/com.orchestratory.supervisor.example.plist` is intentionally non-runnable source: materialize its placeholders
into a separate owner-local LaunchAgent using the absolute Node executable, committed supervisor script, canonical
workspace, expected branch, Room, data directory and Obsidian handoff paths. Never commit the materialized plist.
Validate it with `plutil`, then bootstrap `com.orchestratory.supervisor`; `StartInterval=3600` and `RunAtLoad` provide
the hourly cadence and initial audit.

The supervisor uses `git --no-optional-locks` and SQLite `readOnly + query_only`; it does not start normal runtime
migration/recovery and does not read the HMAC audit key. It atomically writes only the workspace-external bounded
`last-report.json` (0700 directory, 0600 file) plus a one-line `/tmp` launchd log. A hot WAL that cannot be read
without recovery fails loud as an alert. SQLite quick/foreign-key checks and the Room SHA-256 chain do not replace
the release gate's full semantic and HMAC integrity checks.

These read-only diagnostics may run while the GUI daemon is active. Every SQLite store, including the main
run store, waits up to three seconds for a short concurrent writer before failing closed. A lock that outlives
that bound is not bypassed: let the active workflow or maintenance command finish, then retry sequentially.

## Daemon release and schema cutover

Never install the login daemon from a source checkout or `npm link`. A supported cutover uses a clean committed
HEAD, `npm run build:package`, the verified `.tgz.sha256`, and an offline install into an owner-only directory whose
name includes that digest. Resolve the installed `src/main.js` and every parent with `lstat`/`realpath`; the runtime,
package root and LaunchAgent target must not be symlinks or paths inside the repository.

Before opening a newer schema, create SQLite online backups for every database so committed WAL pages are included.
Also retain the previous LaunchAgent plist and compatible runtime source/artifact. Verify every backup with
`PRAGMA quick_check`, expected schema/version and critical row counts. Test migration against a separate copied data
directory and loopback RC port first. Production cutover then follows this order:

1. stop workflows and all processes that can write Orchestratory stores;
2. take and verify a final WAL-safe backup;
3. install/verify the immutable release and update the LaunchAgent to its physical `src/main.js`;
4. start once, verify database integrity, Room UI protocol, room/message counts and delivery/receipt references;
5. keep the read-only rescue viewer and previous binary+DB recovery set until owner acceptance.

A failed migration must leave its original `user_version`, rows and auxiliary tables intact. Do not delete a
delivery, reset a database or copy only the main `.sqlite` file to make the GUI start.

`data purge` without `--execute` is preview-only. It excludes active runs and any run with a retained
worktree. No scheduled or automatic purge exists. In v1, the purge applies only to terminal workflow runs;
Room/presence/inbox/Writer/audit stores remain persistent for traceability and are listed by inventory rather
than silently deleted.

## Scoped data purge

After reviewing the exact preview, an owner may run `orchestrator data purge --execute`. The CLI requires
a TTY, an exact count-bound phrase, a short-lived single-use approval, and a second database snapshot
check. Only terminal run rows and their foreign-key cascades are removed. Settings, credentials,
workspaces, source files, branches and retained worktrees are not touched.

## Scoped worktree removal

`orchestrator worktrees cleanup <run-id>` is preview-only. Adding `--execute` requires an exact TTY
confirmation and removes only the matching clean retained worktree. It rejects active, dirty, branch-
mismatched or snapshot-changed worktrees. It never uses force and deliberately retains the Git branch.
Branch review/deletion remains a separate manual owner decision.

## Unlinking the command

If installed with a user-owned npm prefix, unlink with the same prefix and without sudo:

```text
npm_config_prefix="$HOME/.local" npm unlink --global orchestratory
```

Unlinking does not delete configuration, SQLite data, worktrees, branches, provider sessions or API
credentials. Full application-data removal is intentionally not automated in v1 because it could orphan
Git worktree metadata; review and clean every retained worktree first.

## Credential revocation

- Subscription credentials belong to each provider CLI. Sign out/revoke through that provider's official
  CLI/account controls; Orchestratory neither reads nor deletes those stores.
- Remove API environment variables from the launching shell/service and rotate the key at the provider.
- On macOS, remove only the three `orchestratory.*-api-key` Keychain entries through Keychain Access after
  verifying their fixed service/account labels. Do not delete unrelated Keychain items.
- Credential revocation is external state and must be performed/confirmed by the owner; no automatic
  revocation command is provided.
