
"""Pyodide 环境下的 requests 兼容层：通过 Android/WebView 原生 HTTP 桥请求网络。"""
from __future__ import annotations

import json
from urllib.parse import urlencode, urlsplit, parse_qsl, urlunsplit

try:
    from js import nativeHttp
except Exception:  # noqa: BLE001
    nativeHttp = None


class HTTPError(RuntimeError):
    pass


class _Headers(dict):
    def __init__(self, data=None):
        super().__init__()
        for k, v in (data or {}).items():
            self[k.lower()] = v

    def get(self, key, default=None):
        return super().get(str(key).lower(), default)


class _Cookies:
    def __init__(self):
        self._data = {}

    def set(self, name, value, domain=None, path=None):
        self._data[name] = value

    def get(self, name, default=None):
        return self._data.get(name, default)

    def items(self):
        return self._data.items()

    def build_header(self):
        return "; ".join("%s=%s" % (k, v) for k, v in self._data.items())


class Response:
    def __init__(self, status_code, body, headers):
        self.status_code = int(status_code)
        self._body = body or ""
        self.headers = _Headers(headers or {})
        self.text = self._body
        self.content = self._body.encode("utf-8", "replace")
        self.encoding = "utf-8"

    def json(self):
        return json.loads(self._body)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPError("HTTP %s" % self.status_code)


class Session:
    def __init__(self):
        self.headers = {}
        self.cookies = _Cookies()

    def _request(self, method, url, headers=None, data=None, params=None, timeout=25, **kwargs):
        if params:
            parts = urlsplit(url)
            query = dict(parse_qsl(parts.query, keep_blank_values=True))
            query.update({str(k): str(v) for k, v in params.items()})
            url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
        if nativeHttp is None:
            raise RuntimeError("nativeHttp bridge unavailable")
        merged = dict(self.headers)
        merged.update(headers or {})
        cookie = self.cookies.build_header()
        if cookie:
            merged["Cookie"] = cookie
        payload = data
        if isinstance(payload, dict):
            payload = json.dumps(payload, ensure_ascii=False)
        body = "" if payload is None else str(payload)
        raw = nativeHttp(method.upper(), url, json.dumps(merged, ensure_ascii=False), body)
        try:
            result = json.loads(str(raw))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("nativeHttp returned invalid JSON: %s" % exc)
        if result.get("error"):
            raise RuntimeError(result["error"])
        response = Response(result.get("status", 0), result.get("body", ""), result.get("headers") or {})
        set_cookie = response.headers.get("set-cookie", "")
        if set_cookie:
            for line in set_cookie.split("\n"):
                part = line.split(";", 1)[0]
                if "=" in part:
                    name, value = part.split("=", 1)
                    self.cookies.set(name.strip(), value.strip())
        return response

    def get(self, url, timeout=25, **kwargs):
        return self._request("GET", url, timeout=timeout, **kwargs)

    def post(self, url, data=None, json=None, timeout=25, **kwargs):
        payload = data
        headers = dict(kwargs.pop("headers", {}) or {})
        if json is not None:
            payload = __import__("json").dumps(json, ensure_ascii=False)
            headers.setdefault("Content-Type", "application/json")
        return self._request("POST", url, headers=headers, data=payload, timeout=timeout, **kwargs)


def get(url, timeout=25, **kwargs):
    return Session().get(url, timeout=timeout, **kwargs)


def post(url, **kwargs):
    return Session().post(url, **kwargs)
