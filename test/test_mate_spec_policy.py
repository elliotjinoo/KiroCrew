# SPDX-License-Identifier: Apache-2.0
"""A crewmate's spec policy: its template's hooks, permissions and tool settings.

The crewmate's conductor and worker are one unit (owner decision, ``docs/decisions``):
adding an agent's abilities copies its ``hooks``, ``permissions`` and
``toolsSettings`` into the crewmate's file, exactly or not at all, and both the
worker and the chat run under them on KAS.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from kiro_crew import mate_capabilities, mate_spec_policy, mate_worker, mate_worker_kit
from kiro_crew.acp_backends import ACP_BACKEND_KAS
from kiro_crew.config import paths
from kiro_crew.mate_spec_policy import SpecPolicyUncarried
from kiro_crew.mate_worker_kit import WorkerKitError

HOOK = {"matcher": "execute_bash", "command": "audit-shell.sh"}
BASE_HOOK = {"command": "crew-base.sh"}
DENY = {"capability": "filesystem", "match": ["/etc/**"], "effect": "deny"}
ALLOW = {"capability": "mcp", "match": ["jira/search"], "effect": "allow"}
SETTINGS = {"execute_bash": {"allowedCommands": ["git status"], "deniedCommands": ["rm .*"]}}

WORKER_BASE = {
    "name": "kirocrew-mate-worker",
    "prompt": "base",
    "tools": ["*"],
    "allowedTools": ["fs_read"],
    "mcpServers": {},
    "hooks": {"stop": [BASE_HOOK]},
}
CONDUCTOR_BASE = {
    "name": "kirocrew-mate-conductor",
    "prompt": "conduct",
    "tools": ["fs_read", "@kirocrew-dashboard", "@kirocrew-work", "@kirocrew-core"],
    "allowedTools": ["@kirocrew-dashboard/session_create", "@kirocrew-work/work_brief"],
    "mcpServers": {},
}
TEMPLATE = {
    "name": "release-bot",
    "prompt": "Release SOP.",
    "tools": ["*"],
    "mcpServers": {},
    "hooks": {"preToolUse": [HOOK]},
    "permissions": {"rules": [DENY, ALLOW]},
    "toolsSettings": SETTINGS,
}


@pytest.fixture(autouse=True)
def _no_ceiling(monkeypatch):
    """The governance ceiling is its own module's concern; here it passes grants."""
    from kiro_crew.platform import governance

    monkeypatch.setattr(governance, "sanitize_agent_config_governance", lambda spec, **_k: None)


# --- layering, exact or refused -------------------------------------------------


def test_a_template_hook_is_added_beside_the_bases_own():
    spec = json.loads(json.dumps(WORKER_BASE))
    mate_spec_policy.layer_policy(spec, {"hooks": TEMPLATE["hooks"]})
    assert spec["hooks"] == {"stop": [BASE_HOOK], "preToolUse": [HOOK]}


def test_template_permission_rules_join_the_bases_rules_unchanged():
    spec = {"permissions": {"rules": [{"capability": "builtin", "effect": "ask"}]}}
    mate_spec_policy.layer_policy(spec, {"permissions": TEMPLATE["permissions"]})
    assert spec["permissions"]["rules"] == [
        {"capability": "builtin", "effect": "ask"},
        DENY,
        ALLOW,
    ]


def test_a_tool_setting_is_copied_whole_for_a_tool_the_base_leaves_alone():
    spec = {"toolsSettings": {"fs_write": {"deniedPaths": ["/etc"]}}}
    mate_spec_policy.layer_policy(spec, {"toolsSettings": SETTINGS})
    assert spec["toolsSettings"] == {"fs_write": {"deniedPaths": ["/etc"]}, **SETTINGS}


def test_a_tool_setting_the_base_sets_differently_is_refused_by_name():
    spec = {"toolsSettings": {"execute_bash": {"deniedCommands": ["sudo .*"]}}}
    with pytest.raises(SpecPolicyUncarried) as caught:
        mate_spec_policy.layer_policy(spec, {"toolsSettings": SETTINGS})
    assert caught.value.fields == ["toolsSettings.execute_bash"]
    assert isinstance(caught.value, mate_worker.WorkerKitUnreadable)


def test_a_permissions_block_kas_would_refuse_whole_is_refused_by_name():
    """A block with a key KAS cannot read would travel as no rule at all."""
    bad = {"rules": [{"effect": "deny", "tools": ["@jira/delete_issue"]}]}
    with pytest.raises(SpecPolicyUncarried) as caught:
        mate_spec_policy.layer_policy({}, {"permissions": bad})
    assert caught.value.fields == ["permissions"]


# --- the worker ------------------------------------------------------------------


def test_the_worker_carries_the_files_hooks_permissions_and_tool_settings():
    merged = mate_worker.merge_worker_spec(
        WORKER_BASE, mate_worker.worker_additions(WORKER_BASE, TEMPLATE)
    )
    assert merged["hooks"] == {"stop": [BASE_HOOK], "preToolUse": [HOOK]}
    assert merged["permissions"]["rules"] == [DENY, ALLOW]
    assert merged["toolsSettings"] == SETTINGS


def test_the_worker_gains_no_permission_the_template_does_not_declare():
    merged = mate_worker.merge_worker_spec(
        WORKER_BASE, mate_worker.worker_additions(WORKER_BASE, TEMPLATE)
    )
    allows = [r for r in merged["permissions"]["rules"] if r["effect"] == "allow"]
    assert allows == [ALLOW]
    assert merged["allowedTools"] == WORKER_BASE["allowedTools"]


def test_a_host_that_applies_no_policy_refuses_a_worker_whose_file_sets_one(monkeypatch, tmp_path):
    (tmp_path / "pixel.json").write_text(json.dumps(TEMPLATE), encoding="utf-8")
    monkeypatch.setattr(paths, "mate_agents_dir", lambda: tmp_path)
    monkeypatch.setattr(mate_worker, "mate_file_for_member", lambda member_id: "pixel")
    with pytest.raises(SpecPolicyUncarried) as caught:
        mate_worker.resolve_worker_spec(dict(WORKER_BASE), "m-1", refuse_spec_policy=True)
    assert caught.value.fields == ["hooks", "permissions", "toolsSettings"]


# --- the conductor ---------------------------------------------------------------


def _conductor(file_spec: dict) -> dict:
    overlay = mate_spec_policy.conductor_overlay(file_spec)
    return mate_spec_policy.apply_conductor_overlay(CONDUCTOR_BASE, overlay)


def test_the_conductor_runs_the_files_hooks():
    assert _conductor(TEMPLATE)["hooks"] == {"preToolUse": [HOOK]}


def test_the_conductor_runs_the_files_deny_rules():
    assert DENY in _conductor(TEMPLATE)["permissions"]["rules"]


def test_the_conductor_gets_the_templates_auto_approvals_and_keeps_its_own():
    spec = _conductor(TEMPLATE)
    assert ALLOW in spec["permissions"]["rules"]
    assert spec["toolsSettings"]["execute_bash"]["allowedCommands"] == ["git status"]
    assert spec["allowedTools"] == CONDUCTOR_BASE["allowedTools"]


def test_the_conductor_gets_nothing_the_file_adds_beyond_its_policy():
    """Prompt, servers and approvals are the worker's; the chat takes only limits."""
    file_spec = {
        **TEMPLATE,
        "mcpServers": {"jira": {"command": "jira-mcp"}},
        "allowedTools": ["@jira/search"],
        "excludedTools": ["web_fetch"],
    }
    spec = _conductor(file_spec)
    assert spec["prompt"] == CONDUCTOR_BASE["prompt"]
    assert spec["mcpServers"] == {}
    assert spec["allowedTools"] == CONDUCTOR_BASE["allowedTools"]
    assert spec["excludedTools"] == ["web_fetch"]
    rules = spec["permissions"]["rules"]
    assert [r for r in rules if r["effect"] == "allow"] == [ALLOW]


@pytest.mark.parametrize(
    ("file_spec", "named"),
    [
        (
            {
                "permissions": {
                    "rules": [
                        {"capability": "mcp", "match": ["kirocrew-dashboard/*"], "effect": "deny"}
                    ]
                }
            },
            "permissions rule 0",
        ),
        ({"excludedTools": ["@kirocrew-dashboard"]}, "excludedTools @kirocrew-dashboard"),
        (
            {"excludedTools": ["@kirocrew-work/work_brief"]},
            "excludedTools @kirocrew-work/work_brief",
        ),
    ],
)
def test_a_restriction_that_blocks_a_hand_off_tool_is_refused_naming_the_rule(file_spec, named):
    with pytest.raises(SpecPolicyUncarried) as caught:
        _conductor(file_spec)
    assert any(field.startswith(named) for field in caught.value.fields), caught.value.fields


def test_a_deny_with_the_hand_off_tool_excluded_does_not_block_it():
    rule = {
        "capability": "mcp",
        "match": ["kirocrew-dashboard/*"],
        "exclude": ["kirocrew-dashboard/session_*"],
        "effect": "deny",
    }
    spec = _conductor({"permissions": {"rules": [rule]}})
    assert rule in spec["permissions"]["rules"]


def test_a_crewmates_chat_session_runs_its_files_policy(monkeypatch, tmp_path):
    from kiro_crew import execution_context

    (tmp_path / "pixel.json").write_text(json.dumps(TEMPLATE), encoding="utf-8")
    monkeypatch.setattr(paths, "mate_agents_dir", lambda: tmp_path)
    monkeypatch.setattr(mate_worker, "mate_file_for_member", lambda member_id: "pixel")
    record = SimpleNamespace(selection_kind="member", member_id="m-1")
    monkeypatch.setattr(execution_context, "read_session_execution", lambda key: record)
    spec = mate_spec_policy.conductor_session_spec(dict(CONDUCTOR_BASE), "chat-1")
    assert spec["hooks"] == {"preToolUse": [HOOK]}
    # A session that is no crewmate's chat runs the stock conductor.
    other = SimpleNamespace(selection_kind="template", member_id="m-1")
    monkeypatch.setattr(execution_context, "read_session_execution", lambda key: other)
    assert mate_spec_policy.conductor_session_spec(CONDUCTOR_BASE, "chat-2") is CONDUCTOR_BASE


def test_a_host_that_applies_no_policy_refuses_a_chat_whose_file_sets_one(monkeypatch, tmp_path):
    from kiro_crew import execution_context

    (tmp_path / "pixel.json").write_text(json.dumps(TEMPLATE), encoding="utf-8")
    monkeypatch.setattr(paths, "mate_agents_dir", lambda: tmp_path)
    monkeypatch.setattr(mate_worker, "mate_file_for_member", lambda member_id: "pixel")
    record = SimpleNamespace(selection_kind="member", member_id="m-1")
    monkeypatch.setattr(execution_context, "read_session_execution", lambda key: record)
    with pytest.raises(SpecPolicyUncarried) as caught:
        mate_spec_policy.refuse_conductor_policy("chat-1")
    assert caught.value.fields == ["hooks", "permissions", "toolsSettings"]


def test_crew_fired_hooks_read_the_sessions_merged_spec(monkeypatch):
    from kiro_crew.agent_sdk import spec_hooks

    merged = {**CONDUCTOR_BASE, "hooks": {"preToolUse": [HOOK]}}
    monkeypatch.setattr(
        mate_worker, "mate_service_scope_spec", lambda agent, key: (merged, paths.mate_agents_dir())
    )
    spec, origin = spec_hooks._agent_spec_with_origin("kirocrew-mate-conductor", None, "chat-1")
    assert spec["hooks"] == {"preToolUse": [HOOK]}
    assert origin == "project"


def test_only_kas_applies_a_crewmates_policy():
    policy = {"hooks": {}}
    assert mate_spec_policy.backend_refusal(policy, ACP_BACKEND_KAS) is None
    assert "claude" in (mate_spec_policy.backend_refusal(policy, "claude") or "")
    assert mate_spec_policy.backend_refusal({}, "claude") is None


# --- the kit copy ----------------------------------------------------------------


@pytest.fixture
def home(tmp_path, monkeypatch):
    user, mates = tmp_path / "agents", tmp_path / "mates" / "agents"
    user.mkdir()
    mates.mkdir(parents=True)
    (user / "release-bot.json").write_text(json.dumps(TEMPLATE), encoding="utf-8")
    (mates / "pixel.json").write_text(
        json.dumps({"name": "pixel", "prompt": "", "tools": [], "mcpServers": {}}),
        encoding="utf-8",
    )
    (mates / "kirocrew-mate-worker.json").write_text(json.dumps(WORKER_BASE), encoding="utf-8")
    (mates / "kirocrew-mate-conductor.json").write_text(
        json.dumps(CONDUCTOR_BASE), encoding="utf-8"
    )
    monkeypatch.setattr(paths, "kiro_agents_dir", lambda: user)
    monkeypatch.setattr(paths, "mate_agents_dir", lambda: mates)
    monkeypatch.setattr(mate_capabilities, "binding_is_mate", lambda member: member == "pixel")
    monkeypatch.setattr(mate_worker_kit, "_crewmate_backend", lambda member, held: ACP_BACKEND_KAS)
    return user, mates


def _file(mates) -> dict:
    return json.loads((mates / "pixel.json").read_text(encoding="utf-8"))


def _use(user, template: dict) -> None:
    (user / "release-bot.json").write_text(json.dumps(template), encoding="utf-8")


def test_adding_a_template_copies_its_policy_and_previews_each_item(home):
    _, mates = home
    preview = mate_worker_kit.preview("pixel", {"template": "release-bot"})
    rows = {(r["section"], r["id"]) for r in preview["changes"]}
    assert ("hooks", "preToolUse: execute_bash") in rows
    assert ("permissions", "deny filesystem /etc/**") in rows
    assert ("permissions", "allow mcp jira/search") in rows
    assert ("toolsSettings", "execute_bash") in rows
    mate_worker_kit.apply("pixel", {"template": "release-bot", "revision": preview["revision"]})
    written = _file(mates)
    assert written["hooks"] == TEMPLATE["hooks"]
    assert written["permissions"] == TEMPLATE["permissions"]
    assert written["toolsSettings"] == SETTINGS


def test_a_crewmate_off_kas_is_refused_a_template_with_a_policy(home, monkeypatch):
    _, mates = home
    before = _file(mates)
    monkeypatch.setattr(mate_worker_kit, "_crewmate_backend", lambda member, held: "claude")
    with pytest.raises(WorkerKitError) as caught:
        mate_worker_kit.preview("pixel", {"template": "release-bot"})
    assert caught.value.code == "template_policy_backend_unsupported"
    assert caught.value.detail == "hooks, permissions, toolsSettings"
    assert _file(mates) == before


def test_a_template_that_blocks_a_hand_off_tool_is_refused_naming_the_rule(home):
    user, mates = home
    deny = {"capability": "mcp", "match": ["kirocrew-dashboard/session_send"], "effect": "deny"}
    _use(user, {**TEMPLATE, "permissions": {"rules": [deny]}})
    with pytest.raises(WorkerKitError) as caught:
        mate_worker_kit.preview("pixel", {"template": "release-bot"})
    assert caught.value.code == "template_blocks_conductor_tool"
    assert "permissions rule 0" in caught.value.detail
    assert "session_send" in caught.value.detail


def test_a_template_setting_the_worker_base_sets_differently_is_refused_by_name(home):
    user, mates = home
    base = {**WORKER_BASE, "toolsSettings": {"execute_bash": {"deniedCommands": ["sudo .*"]}}}
    (mates / "kirocrew-mate-worker.json").write_text(json.dumps(base), encoding="utf-8")
    with pytest.raises(WorkerKitError) as caught:
        mate_worker_kit.preview("pixel", {"template": "release-bot"})
    assert caught.value.code == "template_restrictions_uncarried"
    assert caught.value.detail == "toolsSettings.execute_bash"


# --- where Crew fires a crewmate's hooks on KAS ---------------------------------


def _kas_client() -> SimpleNamespace:
    from kiro_crew.agent_sdk.capabilities import capabilities_for

    return SimpleNamespace(capabilities=capabilities_for(ACP_BACKEND_KAS), cwd="")


def test_a_kas_chat_turn_fires_the_hooks_of_the_session_it_holds(monkeypatch):
    import asyncio

    from kiro_crew.agent_sdk import spec_hooks
    from kiro_crew.dashboard import chat_runner

    asked: list[str] = []

    def scoped(agent, key):
        asked.append(key)
        return {**CONDUCTOR_BASE, "hooks": {"preToolUse": [HOOK]}}, paths.mate_agents_dir()

    monkeypatch.setattr(mate_worker, "mate_service_scope_spec", scoped)
    spec_hooks._cache.clear()
    slot = SimpleNamespace(_active_turn_session_key="chat-1")
    hooks, unreadable, _cwd = asyncio.run(
        chat_runner._prepare_spec_hooks(
            SimpleNamespace(), slot, _kas_client(), "kirocrew-mate-conductor", is_new=False
        )
    )
    spec_hooks._cache.clear()
    assert asked == ["chat-1"] and not unreadable
    assert [h.command for h in hooks] == [HOOK["command"]]


def test_a_stale_check_reads_the_providers_own_session(monkeypatch):
    import asyncio

    from kiro_crew.acp import kas_agents
    from kiro_crew.agent_sdk import spec_hooks

    asked: list[str] = []

    def spec(agent_id, project_dir=None, session_key=""):
        asked.append(session_key)
        return {"hooks": {"preToolUse": [HOOK]}}

    monkeypatch.setattr(spec_hooks, "_agent_spec", spec)
    monkeypatch.setattr(kas_agents, "pre_tool_hook_matchers", lambda agent_id, s: ("execute_bash",))
    provider = SimpleNamespace(
        **vars(_kas_client()),
        _session_key="chat-1",
        kas_auto_approved_capabilities=frozenset({"shell"}),
        kas_projected_agent="kirocrew-mate-conductor",
    )
    asyncio.run(spec_hooks.hook_projection_stale(provider, "kirocrew-mate-conductor"))
    assert asked == ["chat-1"]


def test_the_session_mcp_read_refuses_off_kas_and_layers_on_kas(monkeypatch, tmp_path):
    from kiro_crew import execution_context
    from kiro_crew.acp.session_mcp_crewmate import _crewmate_worker_spec

    (tmp_path / "pixel.json").write_text(json.dumps(TEMPLATE), encoding="utf-8")
    monkeypatch.setattr(paths, "mate_agents_dir", lambda: tmp_path)
    monkeypatch.setattr(mate_worker, "mate_file_for_member", lambda member_id: "pixel")
    record = SimpleNamespace(selection_kind="member", member_id="m-1")
    monkeypatch.setattr(execution_context, "read_session_execution", lambda key: record)
    agent = "kirocrew-mate-conductor"
    with pytest.raises(SpecPolicyUncarried):
        _crewmate_worker_spec(agent, dict(CONDUCTOR_BASE), "chat-1")
    spec = _crewmate_worker_spec(agent, dict(CONDUCTOR_BASE), "chat-1", spec_policy_honoured=True)
    assert spec is not None and spec["hooks"] == {"preToolUse": [HOOK]}
