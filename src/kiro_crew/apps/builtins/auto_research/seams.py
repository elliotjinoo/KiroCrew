"""Research Lab's providers for core's registration seams.

Core asks for these through :mod:`kiro_crew.apps.seams` and never imports this app.
That module imports this file the first time any seam is looked up.

A provider answers whether or not the app is enabled: a campaign worker's stopped
loop keeps its tombstone with the app switched off too, so a re-enabled app still
reads how its campaigns ended.
"""

from __future__ import annotations

from kiro_crew.apps import seams
from kiro_crew.apps.builtins.auto_research.session_keys import (
    AUTO_RESEARCH_APP,
    is_research_slot_key,
)


class _StoppedLoopTombstone:
    """:class:`kiro_crew.apps.seams.StoppedLoopTombstone`, from ``session_keys.py``.

    The watchdog reads the tombstone a stopped campaign worker leaves to tell a
    deliberate finish from an unreachable session. Only a canonical worker-slot key
    keeps one; core has already checked that the slot's provenance is this app.
    """

    def keeps_stopped_loop(self, slot_key: str) -> bool:
        return is_research_slot_key(slot_key)


seams.register_for_app(
    seams.SEAM_STOPPED_LOOP_TOMBSTONE, AUTO_RESEARCH_APP, _StoppedLoopTombstone()
)
