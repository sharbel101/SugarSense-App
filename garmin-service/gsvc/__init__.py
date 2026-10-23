"""SugarSense Garmin metrics service: a small poller that reads Garmin's official Personal API and a read-only JSON API over the stored result.

The poller only issues GET requests with a bearer token obtained from a Personal API key; nothing here signs in with a password.
"""
