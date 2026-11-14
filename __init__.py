"""Notes plugin: desktop page and dashboard API only.

No agent tools or hooks: the tab talks to ``dashboard/plugin_api.py`` (mounted at
``/api/plugins/notes``) through the desktop plugin SDK. This file exists so the
plugin directory is a regular Python package the plugin registry can list.
"""
