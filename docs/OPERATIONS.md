# Safe operations and removal

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
