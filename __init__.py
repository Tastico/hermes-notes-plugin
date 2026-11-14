"""Notes plugin: a dashboard API plus a desktop page, and no agent tools.

The agent half is the backend router in ``dashboard/plugin_api.py``, mounted by
the dashboard at ``/api/plugins/notes/``. ``register`` exists so the plugin
loader's capability probe finds an entry point; it deliberately adds no tools
and no hooks, because the Notes tab reaches the router through the desktop
plugin SDK rather than through the agent.
"""


def register(ctx):  # noqa: ARG001 - the loader passes its context; nothing to register here
    """No agent-side capability to add."""
    return None
