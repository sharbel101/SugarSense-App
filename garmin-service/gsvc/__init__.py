"""SugarSense Garmin metrics service: a rate-limited poller that reads the Garmin MCP gateway and a read-only JSON API over the stored result.

Nothing in this package can sign in to Garmin or to the gateway. Sign-in is the manual, guarded `connector_client.py login` only.
"""
