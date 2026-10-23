"""The Personal API client: token exchange, caching, renewal, and the typed errors. A fake transport stands in for the network; nothing here contacts Garmin."""
import base64
import json

import pytest

from gsvc.personal import ApiError, PersonalClient, jwt_exp

KEY = "GCDC_test-key-not-real"


def jwt(exp):
    def b(x):
        return base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b"=").decode()

    return f"{b({'alg': 'none'})}.{b({'exp': exp, 'scope': ['PERSONAL_API_WELLNESS_READ']})}.sig"


class Net:
    """Scripted answers: a list of (status, headers, body) per call, or a callable(method, url, headers)."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, method, url, headers, timeout):
        self.calls.append((method, url, dict(headers)))
        a = self.answers(method, url, headers) if callable(self.answers) else self.answers[min(len(self.calls) - 1, len(self.answers) - 1)]
        if isinstance(a, Exception):
            raise a
        return a


def ok(body):
    return 200, {}, json.dumps(body).encode()


def tok(exp):
    return 200, {}, jwt(exp).encode()


def test_exchange_uses_the_key_once_and_data_calls_use_the_bearer_token():
    net = Net([tok(10_000_000), ok({"a": 1}), ok({"b": 2})])
    c = PersonalClient(KEY, transport=net, now=lambda: 1000.0)
    assert c.get("/x?date=2026-10-22") == {"a": 1}
    assert c.get("/y") == {"b": 2}
    posts = [x for x in net.calls if x[0] == "POST"]
    assert len(posts) == 1 and posts[0][2]["Authorization"] == "ApiKey " + KEY
    gets = [x for x in net.calls if x[0] == "GET"]
    assert all(g[2]["Authorization"].startswith("Bearer ") and KEY not in json.dumps(g[2]) for g in gets)   # the key is only ever sent to the token endpoint


def test_token_is_renewed_when_less_than_an_hour_is_left():
    now = [1000.0]
    net = Net([tok(1000 + 7200), ok({}), tok(1000 + 90000), ok({})])
    c = PersonalClient(KEY, transport=net, now=lambda: now[0])
    c.get("/a")
    now[0] += 4000          # 3200 s left (< 1 h)... renew
    c.get("/b")
    assert [x[0] for x in net.calls] == ["POST", "GET", "POST", "GET"]


def test_a_401_renews_the_token_once_and_a_second_401_is_an_auth_error():
    net = Net([tok(10_000_000), (401, {}, b""), tok(10_000_000), ok({"ok": 1})])
    c = PersonalClient(KEY, transport=net, now=lambda: 1000.0)
    assert c.get("/a") == {"ok": 1}
    net2 = Net([tok(10_000_000), (401, {}, b""), tok(10_000_000), (401, {}, b"")])
    with pytest.raises(ApiError) as e:
        PersonalClient(KEY, transport=net2, now=lambda: 1000.0).get("/a")
    assert e.value.kind == "auth"


def test_a_rejected_key_is_an_auth_error_and_is_not_retried():
    net = Net([(401, {}, b"")])
    with pytest.raises(ApiError) as e:
        PersonalClient(KEY, transport=net).get("/a")
    assert e.value.kind == "auth" and len(net.calls) == 1


def test_empty_answers_are_none_not_errors():
    for answer in ((204, {}, b""), (200, {}, b"  ")):
        net = Net([tok(10_000_000), answer])
        assert PersonalClient(KEY, transport=net, now=lambda: 1000.0).get("/hrv/2026-10-23") is None


def test_rate_limit_server_error_network_error_and_other_4xx_are_typed():
    cases = [((429, {"Retry-After": "120"}, b""), "rate_limited"), ((503, {}, b""), "transient"), ((404, {}, b""), "client"), ((200, {}, b"<html>"), "transient")]
    for answer, kind in cases:
        net = Net([tok(10_000_000), answer])
        with pytest.raises(ApiError) as e:
            PersonalClient(KEY, transport=net, now=lambda: 1000.0).get("/a")
        assert e.value.kind == kind
    net = Net([tok(10_000_000), (429, {"Retry-After": "120"}, b"")])
    with pytest.raises(ApiError) as e:
        PersonalClient(KEY, transport=net, now=lambda: 1000.0).get("/a")
    assert e.value.retry_after == 120.0
    boom = Net([ApiError("transient", 0, message="URLError")])
    with pytest.raises(ApiError) as e:
        PersonalClient(KEY, transport=boom).get("/a")
    assert e.value.kind == "transient"


def test_jwt_exp_is_read_without_verification_and_garbage_is_none():
    assert jwt_exp(jwt(1234567890)) == 1234567890.0 and jwt_exp("not-a-token") is None


def test_an_empty_key_is_refused():
    with pytest.raises(ValueError):
        PersonalClient("  ")
