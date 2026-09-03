# Security Policy

## Supported versions

This project has not published a signed release, so no version is designated as supported for
security updates. Treat the current branch as a security preview: verify against a test repository,
and do not expose the GUI beyond loopback.

## Reporting a vulnerability

Use **Security → Report a vulnerability** in this GitHub repository. That routes through GitHub's
Private Vulnerability Reporting, so the report and any proof of concept stay private until there is
something to disclose. **Do not open a public issue for an unpatched vulnerability.**

If that option is not visible, Private Vulnerability Reporting has not been enabled yet — it is a
public-repository feature and cannot be switched on in advance. In that case contact the owner
through the GitHub profile in [`NOTICE`](NOTICE) rather than opening an issue.

Please include:

- the affected version or commit
- operating system and Node.js version
- reproduction steps
- the security impact — what an attacker gains, not only that something misbehaves
- whether credentials or private source code may have been exposed

**Do not include real credentials or other people's personal data**, in the report or in an
attachment. A redacted reproduction is more useful than a real one, because a real one turns the
report itself into a second exposure.

Maintainers aim to acknowledge a private report within 5 business days. Remediation and disclosure
timing depend on severity, and on whether users need time to rotate credentials or update safely.

## What this project does and does not defend against

Reading this first will tell you whether something is a vulnerability or a documented boundary.

**In scope** — the approval path is where the security of this product lives:

- Anything that lets an agent, a model output, or a web page cause a write to a canonical project
  without the owner typing the confirmation phrase into the local GUI or a physical TTY.
- Anything that lets a merge approval be reused, survive a change to the snapshot it was bound to,
  or be obtained by a party other than the owner.
- Anything that lets a tool call forge an actor identity, join a room it was not approved for, or
  reach a workspace outside the allowlist.
- Escaping the workspace allowlist by path traversal, symlink, or hardlink.
- Getting anything off the machine that the owner did not ask to be sent, including through the
  telemetry boundary or a provider API call.
- Tampering with the append-only ledger or the audit hash chain without detection.
- Reaching the loopback GUI from another origin, or from another host.

**Out of scope** — these are documented properties, not defects:

- **The candidate workspace is not an OS sandbox.** A full-trust agent running under the same
  operating-system account can bypass an application-level boundary. The product provides a record
  and a recovery point, not enforced isolation. Use a container or a separate account if you need
  the stronger property.
- **Joining a room does not change an agent's permissions.** Its sandbox, tools, shell and network
  access are governed by its own host (Codex or Claude Code). Orchestratory neither grants nor
  removes capability, so "the agent could run a shell command" is a property of that host.
- **A Git worktree isolates a working directory, not a repository.** Worktrees share the source
  repository's object database and refs.
- **A merge driver you configured is your program.** Computing a real merge preview runs it, before
  you approve anything. Most projects configure none. See F23 in
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
- Attacks that assume the attacker already has your operating-system account.

[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) carries the full analysis, including the residual
risks that are accepted rather than closed.
