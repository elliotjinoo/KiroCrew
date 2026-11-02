"""A crewmate's spec policy: the ``hooks``, ``permissions`` and ``toolsSettings`` it runs under.

A crewmate's conductor and worker are one unit (owner decision, ``docs/decisions``).
A template copied into the crewmate's file (``mate_worker_kit``) brings these three
fields along, and both halves run under them:

- the worker spec layers them over the worker base (:func:`layer_policy`, called by
  ``mate_worker.merge_worker_spec``);
- the conductor spec layers them, plus the file's tool restrictions, over the
  stock conductor per session (:func:`conductor_session_spec`), so the crewmate's
  ``excludedTools`` narrow its chat too.

Carrying is exact or refused. A hook is added beside the base's, a permission
rule beside the base's rules, and a ``toolsSettings`` entry is copied whole for a
tool the base sets nothing for. A field that cannot land exactly (an entry for a
tool the base already sets differently, a ``permissions`` block KAS would refuse
whole) raises :class:`SpecPolicyUncarried` naming it. The governance ceiling still
applies to the merged spec, so a grant the template declares is never wider than
the ceiling allows; KAS's projection relays a ``deny``/``ask`` rule as written and
an ``allow`` only where the ceiling permits it (``kas_permissions.merge_user_permissions``).

Only KAS applies the three fields on a crewmate's sessions
(:func:`applies_spec_policy`), so a crewmate on any other backend is
refused a template that sets them (:func:`backend_refusal`). Stateless.
"""

from __future__ import annotations

import fnmatch
import json
import logging
from typing import Any

from kiro_crew.mate_worker import WorkerKitUnreadable
from kiro_crew.user_json import copy_json_document

logger = logging.getLogger(__name__)

#: The spec fields a crewmate's file carries for both of its sessions.
POLICY_KEYS = ("hooks", "permissions", "toolsSettings")

#: The tools a crewmate's conductor hands work off and keeps its ledger with.
#: An inherited restriction that would take one away is refused, never applied:
#: a conductor without them cannot reach its worker. Only those the stock
#: conductor mounts count (:func:`required_conductor_tools`).
CONDUCTOR_REQUIRED_TOOLS = (
    "@kirocrew-dashboard/session_create",
    "@kirocrew-dashboard/session_send",
    "@kirocrew-dashboard/session_read_message",
    "@kirocrew-dashboard/session_status",
    "@kirocrew-work/work_ledger_read",
    "@kirocrew-work/work_ledger_record",
    "@kirocrew-work/work_brief",
    "@kirocrew-panel/dashboard_write",
)


def applies_spec_policy(backend: str) -> bool:
    """Whether a crewmate's sessions on *backend* run its ``hooks``, ``permissions``
    and ``toolsSettings``.

    KAS only: it takes the merged spec over the wire, translates ``toolsSettings``
    and merges ``permissions`` (``kas_agents``), and Crew fires the hooks from the
    session's merged spec (``agent_sdk.spec_hooks``). claude runs none of the
    three, and kiro-cli reads its spec by name off disk, so a per-crewmate layer
    never reaches it.
    """
    from kiro_crew.acp_backends import ACP_BACKEND_KAS

    return backend == ACP_BACKEND_KAS


class SpecPolicyUncarried(WorkerKitUnreadable):
    """A crewmate's policy cannot be carried exactly; ``fields`` names what.

    A :class:`~kiro_crew.mate_worker.WorkerKitUnreadable`, so every caller that
    fails a session closed on an unreadable kit refuses this one the same way.
    """

    def __init__(self, fields: list[str], why: str = "") -> None:
        self.fields = list(dict.fromkeys(fields))
        detail = why or "they cannot be applied exactly"
        super().__init__(f"the crewmate's {', '.join(self.fields)} cannot be carried: {detail}")


def uncarried(fields: list[str], why: str = "") -> SpecPolicyUncarried:
    """The refusal for *fields*, which could not be carried exactly."""
    return SpecPolicyUncarried(fields, why)


def _dicts(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _strings(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def policy_of(spec: dict[str, Any]) -> dict[str, Any]:
    """The policy fields *spec* sets, each a copy; a field set to nothing is left out."""
    out: dict[str, Any] = {}
    for key in POLICY_KEYS:
        value = spec.get(key)
        if value is None or value == {} or value == []:
            continue
        out[key] = copy_json_document(value)
    return out


def _probe(raw: Any) -> bool:
    """Whether KAS's projection would read the ``permissions`` block *raw* whole."""
    from kiro_crew.acp import kas_permissions

    return (
        kas_permissions.parse_user_permissions(raw, audit_decision=kas_permissions._asking_only)
        is not None
    )


def _layer_hooks(target: dict[str, Any], hooks: Any, lost: list[str]) -> None:
    if not isinstance(hooks, dict):
        lost.append("hooks")
        return
    have = _dicts(target.get("hooks"))
    merged = {event: list(v) if isinstance(v, list) else [v] for event, v in have.items()}
    for event, entries in hooks.items():
        listed = merged.setdefault(str(event), [])
        seen = {_canon(e) for e in listed}
        for entry in entries if isinstance(entries, list) else [entries]:
            if _canon(entry) not in seen:
                listed.append(copy_json_document(entry))
                seen.add(_canon(entry))
    target["hooks"] = merged


def _layer_permissions(target: dict[str, Any], perms: Any, lost: list[str]) -> None:
    if not (isinstance(perms, dict) and set(perms) <= {"rules"}):
        # A block KAS would refuse whole (a named bundle, an unknown key, a rule
        # it cannot parse) carries none of its denies either.
        lost.append("permissions")
        return
    have = _dicts(target.get("permissions"))
    rules = list(have.get("rules") or []) if isinstance(have.get("rules"), list) else []
    seen = {_canon(r) for r in rules}
    for rule in perms.get("rules") or []:
        if _canon(rule) not in seen:
            rules.append(copy_json_document(rule))
            seen.add(_canon(rule))
    merged = {**copy_json_document(have), "rules": rules}
    if not _probe(merged):
        lost.append("permissions")
        return
    target["permissions"] = merged


def _layer_tools_settings(target: dict[str, Any], settings: Any, lost: list[str]) -> None:
    if not isinstance(settings, dict):
        lost.append("toolsSettings")
        return
    have = copy_json_document(_dicts(target.get("toolsSettings")))
    for tool, entry in settings.items():
        if tool not in have:
            have[tool] = copy_json_document(entry)
        elif _canon(have[tool]) != _canon(entry):
            # Two settings for one tool have no exact union: either one alone
            # would loosen or tighten the other.
            lost.append(f"toolsSettings.{tool}")
    if have:
        target["toolsSettings"] = have


def layer_policy(target: dict[str, Any], policy: dict[str, Any]) -> None:
    """Layer *policy* (:func:`policy_of`) onto *target*, in place, exactly.

    Raises :func:`uncarried` naming every field that could not land as written;
    *target* is then partly layered and must be discarded.
    """
    lost: list[str] = []
    if "hooks" in policy:
        _layer_hooks(target, policy["hooks"], lost)
    if "permissions" in policy:
        _layer_permissions(target, policy["permissions"], lost)
    if "toolsSettings" in policy:
        _layer_tools_settings(target, policy["toolsSettings"], lost)
    if lost:
        raise uncarried(lost)


def required_conductor_tools(base: dict[str, Any]) -> list[str]:
    """The :data:`CONDUCTOR_REQUIRED_TOOLS` the stock conductor *base* mounts."""
    tools = set(_strings(base.get("tools")))
    out = []
    for ref in CONDUCTOR_REQUIRED_TOOLS:
        server = ref[1:].split("/", 1)[0]
        if "*" in tools or ref in tools or f"@{server}" in tools:
            out.append(ref)
    return out


def _rule_text(index: int, rule: dict[str, Any]) -> str:
    match = ", ".join(_strings(rule.get("match"))) or "every tool"
    return f"permissions rule {index} ({rule.get('effect')} {rule.get('capability')} {match})"


def _deny_covers(rule: Any, ref: str) -> bool:
    """Whether the ``permissions`` rule *rule* denies the MCP tool *ref*.

    Read wide: KAS's ``*`` is matched here as one that crosses ``/``, so a rule is
    taken to cover a tool whenever it might, and the template is refused rather
    than a conductor left without a tool.
    """
    if not isinstance(rule, dict) or rule.get("effect") != "deny":
        return False
    if rule.get("capability") not in ("all", "mcp"):
        return False
    resource = ref[1:]
    match = _strings(rule.get("match"))
    if match and not any(fnmatch.fnmatchcase(resource, p) for p in match):
        return False
    return not any(fnmatch.fnmatchcase(resource, p) for p in _strings(rule.get("exclude")))


def conductor_blocks(spec: dict[str, Any], required: list[str]) -> list[str]:
    """Each rule of *spec* that would take a *required* tool from the conductor.

    One phrase per rule, naming it: an ``excludedTools`` entry, or a ``deny``
    ``permissions`` rule by its index.
    """
    from kiro_crew.mate_worker import covered_by

    out: list[str] = []
    excluded = _strings(spec.get("excludedTools"))
    rules = _dicts(spec.get("permissions")).get("rules")
    for ref in required:
        for entry in excluded:
            if entry == ref or covered_by(ref, [entry]):
                out.append(f"excludedTools {entry} (blocks {ref})")
        for index, rule in enumerate(rules if isinstance(rules, list) else []):
            if _deny_covers(rule, ref):
                out.append(f"{_rule_text(index, rule)} (blocks {ref})")
    return list(dict.fromkeys(out))


def conductor_overlay(mate_spec: dict[str, Any]) -> dict[str, Any]:
    """What a crewmate file *mate_spec* lays on its conductor: its policy and tool limits.

    The policy fields, and every tool the file takes out (its ``excludedTools`` and
    its servers' ``disabledTools``) as ``excludedTools``. Nothing the file adds
    (prompt, servers, skills, approvals) reaches the conductor.
    """
    from kiro_crew.mate_worker import disabled_tool_refs

    overlay = policy_of(mate_spec)
    excluded = list(
        dict.fromkeys(
            [
                *_strings(mate_spec.get("excludedTools")),
                *disabled_tool_refs(mate_spec.get("mcpServers")),
            ]
        )
    )
    if excluded:
        overlay["excludedTools"] = excluded
    return overlay


def apply_conductor_overlay(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """The conductor spec: *base* with *overlay* layered on, checked and governed.

    Raises :func:`uncarried` for a policy field that cannot land exactly, and for
    a restriction that would take a required tool (:func:`conductor_blocks`)
    away, naming the rule. *base* is never mutated.
    """
    from kiro_crew.platform.governance import sanitize_agent_config_governance

    spec = copy_json_document(base)
    layer_policy(spec, {k: v for k, v in overlay.items() if k in POLICY_KEYS})
    excluded = _strings(overlay.get("excludedTools"))
    if excluded:
        spec["excludedTools"] = list(
            dict.fromkeys([*_strings(spec.get("excludedTools")), *excluded])
        )
        allowed = _strings(spec.get("allowedTools"))
        spec["allowedTools"] = [ref for ref in allowed if ref not in excluded]
    blocked = conductor_blocks(spec, required_conductor_tools(base))
    if blocked:
        raise uncarried(blocked, "the conductor needs those tools to hand work off")
    sanitize_agent_config_governance(spec)
    return spec


def conductor_session_spec(base: dict[str, Any], session_key: str) -> dict[str, Any]:
    """The conductor spec a crewmate's chat on *session_key* runs: stock plus its file.

    The crewmate comes from the session's own execution record. A session that is
    no crewmate's chat, or a crewmate with no file of its own, runs *base*. A file
    that is claimed but missing or unreadable raises
    ``mate_worker.WorkerKitUnreadable`` (fail closed: it may hold the crewmate's
    limits). Blocking.
    """
    mate_spec = _conductor_file(session_key)
    if mate_spec is None:
        return base
    overlay = conductor_overlay(mate_spec)
    if not overlay:
        return base
    return apply_conductor_overlay(base, overlay)


def refuse_conductor_policy(session_key: str) -> None:
    """Refuse a crewmate chat on a backend that applies no spec policy, when its file sets one.

    For the mirrored hosts (``acp.session_mcp``), which run the stock conductor by
    name: a file whose ``hooks``, ``permissions`` or ``toolsSettings`` would not
    apply there raises :class:`SpecPolicyUncarried` naming them. Blocking.
    """
    mate_spec = _conductor_file(session_key)
    carried = policy_of(mate_spec) if mate_spec is not None else {}
    if carried:
        raise uncarried(
            sorted(carried), "this backend does not apply them; run the crewmate on kas"
        )


def _conductor_file(session_key: str) -> dict[str, Any] | None:
    """The crewmate file whose chat *session_key* is, ``None`` when there is none.

    Raises ``mate_worker.WorkerKitUnreadable`` for an unreadable record or file,
    and for a file the binding claims but that is missing or shadowed.
    """
    from kiro_crew.agent_sdk import agent_specs
    from kiro_crew.config import paths as paths_mod
    from kiro_crew.execution_context import read_session_execution
    from kiro_crew.mate_worker import _claimed_crewmate_file, mate_file_for_member

    if not session_key:
        return None
    try:
        execution = read_session_execution(session_key)
    except Exception as exc:  # noqa: BLE001 - any unreadable record refuses
        raise WorkerKitUnreadable(
            f"conductor session {session_key}: its execution record cannot be read, so "
            f"its crewmate (and that crewmate's limits) is unknown"
        ) from exc
    if execution is None or getattr(execution, "selection_kind", "") != "member":
        return None
    member_id = getattr(execution, "member_id", None)
    if not member_id:
        return None
    name = mate_file_for_member(member_id)
    if not name:
        claimed = _claimed_crewmate_file(member_id)
        if claimed:
            raise WorkerKitUnreadable(
                f"crewmate {member_id!r}: its own file {claimed!r} is missing or shadowed, "
                f"so its chat would run without its limits"
            )
        return None
    try:
        mate_spec = agent_specs.load_agent_spec(paths_mod.mate_agents_dir(), name)
    except agent_specs.AgentSpecUnreadable as exc:
        raise WorkerKitUnreadable(
            f"crewmate {member_id!r}: its file {name!r} cannot be read, so its chat "
            f"would run without its limits; fix or re-save the file"
        ) from exc
    return mate_spec


def backend_refusal(policy: dict[str, Any], backend: str) -> str | None:
    """Why a crewmate on *backend* cannot run a file carrying *policy*, else ``None``."""
    if not policy or applies_spec_policy(backend):
        return None
    from kiro_crew.acp_backends import backend_to_stored

    return (
        f"the crewmate's {', '.join(sorted(policy))} cannot be applied on "
        f"{backend_to_stored(backend)}; run the crewmate on kas"
    )
