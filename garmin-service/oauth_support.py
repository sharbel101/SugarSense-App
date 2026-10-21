"""OAuth 2.1 sign-in support for the hosted Garmin MCP gateway (https://missingmcp.com/garmin/mcp), used outside Claude.

How the gateway works (from its own page): you open its sign-in page ONCE, type your Garmin email/password (and an MFA code if asked); it keeps
only encrypted Garmin session tokens, and hands THIS client an OAuth access token + refresh token. From then on this client refreshes its own
token automatically and never sees your Garmin password.

Golden rule here, same as ~/garmin-api: nothing that runs unattended may start a sign-in.
  * `tools` and `poll` use NON-interactive handlers: if the tokens are missing or cannot be refreshed they raise NeedsLogin, write the
    NEEDS_LOGIN flag file, and stop. They never open a sign-in and never ask for a password.
  * Only `connector_client.py login`, run by hand in a terminal and guarded by login_guard.py, starts a sign-in.
The sign-in is done in YOUR browser (laptop or phone): the program prints a link, you sign in, the browser then fails to open
http://127.0.0.1:8976/callback?code=... (that is expected) and you paste that full address back into the terminal.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
OAUTH_DIR = HERE / "oauth"
NEEDS_LOGIN_FLAG = HERE / "NEEDS_LOGIN"
REDIRECT_URI = "http://127.0.0.1:8976/callback"
CLIENT_NAME = "SugarSense VM client (read-only)"


class NeedsLogin(Exception):
    """No valid OAuth tokens. The only fix is a manual `python connector_client.py login`."""


def mark_needs_login(reason: str, flag: Path | None = None) -> None:
    try:
        (flag or NEEDS_LOGIN_FLAG).write_text(json.dumps({"reason": reason[:200], "action": "run connector_client.py login manually"}) + "\n", encoding="utf-8")
        os.chmod(flag or NEEDS_LOGIN_FLAG, 0o600)
    except OSError:
        pass


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


class FileStorage:
    """OAuth token + registered-client storage on disk (folder 700, files 600). Implements mcp's TokenStorage protocol."""

    def __init__(self, directory: Path | None = None):
        self.dir = Path(directory) if directory is not None else OAUTH_DIR

    @property
    def tokens_path(self) -> Path:
        return self.dir / "tokens.json"

    @property
    def client_path(self) -> Path:
        return self.dir / "client.json"

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken

        if not self.tokens_path.exists():
            return None
        return OAuthToken.model_validate_json(self.tokens_path.read_text(encoding="utf-8"))

    async def set_tokens(self, tokens) -> None:
        _write_private(self.tokens_path, tokens.model_dump_json())

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull

        if not self.client_path.exists():
            return None
        return OAuthClientInformationFull.model_validate_json(self.client_path.read_text(encoding="utf-8"))

    async def set_client_info(self, client_info) -> None:
        _write_private(self.client_path, client_info.model_dump_json())

    def has_tokens(self) -> bool:
        return self.tokens_path.exists()


def parse_redirect(pasted: str):
    """Turn the address the browser ended on (http://127.0.0.1:8976/callback?code=...&state=...) into an AuthorizationCodeResult."""
    from mcp.shared.auth import AuthorizationCodeResult

    q = parse_qs(urlsplit(pasted.strip()).query)
    if "error" in q:
        raise NeedsLogin("the sign-in was refused: " + q["error"][0][:100])
    code = (q.get("code") or [None])[0]
    state = (q.get("state") or [None])[0]
    if not code or not state:
        raise NeedsLogin("that address does not contain code= and state=; paste the full address from the browser's address bar")
    return AuthorizationCodeResult(code=code, state=state, iss=(q.get("iss") or [None])[0])


def make_provider(server_url: str, interactive: bool, storage: FileStorage | None = None, input_fn=input, print_fn=print, flag: Path | None = None):
    """OAuthClientProvider with dynamic client registration. Non-interactive handlers REFUSE to start a sign-in."""
    from mcp.client.auth.oauth2 import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    storage = storage or FileStorage()
    meta = OAuthClientMetadata(
        client_name=CLIENT_NAME,
        redirect_uris=[REDIRECT_URI],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",
    )

    if interactive:

        async def redirect_handler(url: str) -> None:
            print_fn("\nOpen this link in your browser and sign in (Garmin email, password, then the MFA code if asked):\n\n" + url + "\n")

        async def callback_handler():
            print_fn("After you finish, the browser will say the page cannot be reached (that is expected: it tried to open 127.0.0.1).")
            return parse_redirect(input_fn("Paste the FULL address from the browser's address bar here: "))

    else:

        async def redirect_handler(url: str) -> None:
            mark_needs_login("tokens missing or not refreshable", flag)
            raise NeedsLogin("Run `python connector_client.py login` manually (saved OAuth tokens are missing or were rejected)")

        async def callback_handler():  # pragma: no cover - never reached, the redirect handler raises first
            raise NeedsLogin("Run `python connector_client.py login` manually")

    return OAuthClientProvider(server_url=server_url, client_metadata=meta, storage=storage, redirect_handler=redirect_handler, callback_handler=callback_handler)
