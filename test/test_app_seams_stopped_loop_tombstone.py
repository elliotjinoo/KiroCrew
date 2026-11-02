"""The app-keyed ``stopped_loop_tombstone`` seam, and the stop path that asks it.

A stop of a legacy autonudge loop removes the row, except on a slot whose owning app
reads the stopped row back. Core asks the app named by the slot's persisted provenance
through :mod:`kiro_crew.apps.seams`, and Research Lab answers from its own ``seams.py``
with the same verdict its ``session_keys.is_owned_research_slot`` gives.

The registry is process-global, so every test that changes it does so through
``monkeypatch`` on ``seams._app_providers`` and the change is undone afterwards.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from kiro_crew.apps import seams
from kiro_crew.apps.builtins.auto_research.session_keys import (
    AUTO_RESEARCH_APP,
    is_owned_research_slot,
)
from kiro_crew.dashboard import session_directive_apply_monitor as monitor

SEAM = seams.SEAM_STOPPED_LOOP_TOMBSTONE


@pytest.fixture()
def app_registry(monkeypatch):
    """The real app-keyed registry with the shipped providers loaded, restored after."""
    seams.stopped_loop_tombstone(AUTO_RESEARCH_APP)
    monkeypatch.setattr(seams, "_app_providers", dict(seams._app_providers))
    return seams._app_providers


class _Keeps:
    def __init__(self, answer):
        self.answer = answer
        self.asked: list[str] = []

    def keeps_stopped_loop(self, slot_key):
        self.asked.append(slot_key)
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class TestTheAppKeyedRegistry:
    def test_an_app_that_registered_nothing_answers_none(self, app_registry):
        assert seams.stopped_loop_tombstone("no-such-app") is None

    def test_each_app_holds_its_own_provider(self, app_registry):
        a, b = _Keeps(True), _Keeps(False)
        seams.register_for_app(SEAM, "app-a", a)
        seams.register_for_app(SEAM, "app-b", b)
        assert seams.stopped_loop_tombstone("app-a") is a
        assert seams.stopped_loop_tombstone("app-b") is b

    def test_the_same_app_may_replace_its_own_provider(self, app_registry):
        seams.register_for_app(SEAM, "app-a", 1)
        seams.register_for_app(SEAM, "app-a", 2)
        assert seams.app_provider(SEAM, "app-a") == 2

    def test_an_app_keyed_seam_is_not_a_global_one(self, app_registry):
        seams.register_for_app(SEAM, "app-a", 1)
        assert seams.provider(SEAM) is None

    def test_research_lab_provides_its_own_tombstone(self):
        provider = seams.stopped_loop_tombstone(AUTO_RESEARCH_APP)
        assert provider is not None
        assert provider.keeps_stopped_loop("research-a1b2c3d4") is True
        assert provider.keeps_stopped_loop("research-notes") is False


class TestTheStopPathAsksTheSlotsApp:
    @pytest.mark.parametrize(
        "slot_key",
        [
            "research-a1b2c3d4",
            "research-deadbeef",
            "research-notes",
            "research-a1b2c3d4-extra",
            "research-A1B2C3D4",
            "research-",
            "dashboard-1",
            "",
        ],
    )
    @pytest.mark.parametrize("app", [AUTO_RESEARCH_APP, "", "issue-radar", "auto_research"])
    def test_the_verdict_is_the_one_the_core_import_gave(self, slot_key, app):
        """Every slot key and provenance keeps a tombstone exactly when it did before."""
        slot = SimpleNamespace(_app=app)
        assert monitor._keeps_stopped_loop(slot, slot_key) is is_owned_research_slot(slot_key, app)

    def test_a_slot_with_no_provenance_never_asks(self, app_registry):
        spy = _Keeps(True)
        seams.register_for_app(SEAM, "", spy)
        assert monitor._keeps_stopped_loop(SimpleNamespace(), "research-a1b2c3d4") is False
        assert monitor._keeps_stopped_loop(None, "research-a1b2c3d4") is False
        assert spy.asked == []

    def test_the_app_named_by_provenance_is_the_one_asked(self, app_registry):
        spy = _Keeps(True)
        seams.register_for_app(SEAM, "app-a", spy)
        assert monitor._keeps_stopped_loop(SimpleNamespace(_app="app-a"), "w-1") is True
        assert monitor._keeps_stopped_loop(SimpleNamespace(_app="app-b"), "w-1") is False
        assert spy.asked == ["w-1"]

    def test_with_no_provider_research_slots_are_removed(self, app_registry):
        del app_registry[(SEAM, AUTO_RESEARCH_APP)]
        slot = SimpleNamespace(_app=AUTO_RESEARCH_APP)
        assert monitor._keeps_stopped_loop(slot, "research-a1b2c3d4") is False

    def test_a_provider_that_raises_keeps_nothing(self, app_registry, caplog):
        seams.register_for_app(SEAM, "app-a", _Keeps(RuntimeError("boom")))
        assert monitor._keeps_stopped_loop(SimpleNamespace(_app="app-a"), "w-1") is False
        assert "could not say whether it keeps a stopped loop" in caplog.text
