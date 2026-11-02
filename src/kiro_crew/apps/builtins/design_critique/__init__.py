"""Design Critique — builtin app package marker.

The startup route loop in ``dashboard/routes/system.py`` imports this package and
checks ``hasattr(module, "register_routes")`` on the package object, so the
handler must be defined here.

The core's ``apps.seams`` imports this package to reach ``seams.py`` while
``dashboard.chat_handlers`` is itself being imported, so the route module (which
imports the dashboard) loads inside ``register_routes`` only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aiohttp import web


def register_routes(app: web.Application) -> None:
    """Install the app's in-gateway routes (``_mod.register_routes(app)`` contract)."""
    from .backend import routes

    routes.register_routes(app)
