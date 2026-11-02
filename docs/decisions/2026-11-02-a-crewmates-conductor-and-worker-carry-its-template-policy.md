# A crewmate's conductor and worker are one unit that carries its template's hooks, permissions and tool settings, grants included

Decided by: Ray (project owner, @buluoray)
Date: 2026-11-02

## Decision

Adding an agent's abilities to a crewmate copies that agent's `hooks`, `permissions` rules (deny, ask and allow) and `toolsSettings` (limits and grants such as `allowedCommands` and `allowedPaths`) into the crewmate's file exactly as the agent declares them, and both the crewmate's worker and its chat (the conductor) run under them on KAS; the conductor also takes the file's `excludedTools` and per-server `disabledTools`; the conductor keeps its own built-in grants and the template's grants are added to them, so a template's auto-approvals now apply to the conductor too and the user is not asked again for those tools there; the governance ceiling still applies to both merged specs; a field that cannot be carried exactly, a restriction that would take a tool the conductor needs to hand off work (`session_create`, `session_send`, `session_read_message`, `session_status`, the work ledger, `dashboard_write`), and a crewmate on a backend that applies none of these fields (any backend but KAS) are refused with an error naming the field or rule.

## Why

- Since the conductor and worker split, a template that set permission rules, tool settings or hooks was refused for a crewmate, and crewmates the upgrade moved off such a template could not get its tools back.
- The conductor reads the crewmate's untrusted input first, so a restriction that narrows only the worker does not hold where it matters; the conductor and worker are treated as one unit.
- Granting the conductor the template's auto-approvals is a deliberate widening the owner accepted: the user already approved those tools when they wrote the template.
- This entry does not change the upgrade migration recorded in `2026-10-27-every-used-crewmate-moves-to-the-conductor.md` and `2026-10-28-every-crewmate-on-a-user-level-agent-moves-to-the-conductor.md`: the file the migration writes still carries no hooks, permissions or tool settings, and its notice still names them; adding the template's abilities again now carries them.

## Evidence

- https://github.com/kirodotdev/KiroCrew/issues/26881 -- crewmate tool restrictions should also narrow the conductor.
- https://github.com/kirodotdev/KiroCrew/pull/23010 -- the conductor and worker split this follows.
