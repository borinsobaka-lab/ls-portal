"""Проверки помощника без браузера: python -m unittest test_fitbase_session.py"""
import base64
import io
import json
import unittest
from urllib.error import HTTPError

import fitbase_session as h

ORIGIN = "https://ladyjump.fitbase.io"


def code(**data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")


class Helper(unittest.TestCase):
    def test_code(self):
        token = "A" * 43
        self.assertEqual(h.decode_code(" " + code(u="https://portal.example.ru", t=token, o=ORIGIN) + "\n"),
                         ("https://portal.example.ru", token, ORIGIN))
        self.assertEqual(h.decode_code(code(u="http://127.0.0.1:8090", t=token, o=ORIGIN))[0], "http://127.0.0.1:8090")
        for bad in (code(u="http://portal.example.ru", t=token, o=ORIGIN),
                    code(u="https://portal.example.ru", t=token, o="https://evil.example"),
                    code(u="https://portal.example.ru", t="x", o=ORIGIN),
                    code(u="https://portal.example.ru", t=token, o=ORIGIN, x=1),
                    "не код"):
            with self.assertRaises(h.Stop):
                h.decode_code(bad)

    def test_logged_in(self):
        self.assertTrue(h.logged_in(ORIGIN + "/site/dashboard-new", ORIGIN, False, False))
        self.assertTrue(h.logged_in(ORIGIN + "/client-schedule/index/", ORIGIN, False, False))
        self.assertTrue(h.logged_in(ORIGIN + "/clients/view?id=1", ORIGIN, False, True))
        self.assertFalse(h.logged_in(ORIGIN + "/clients/view?id=1", ORIGIN, False, False))
        self.assertFalse(h.logged_in(ORIGIN + "/site/login", ORIGIN, False, True))
        self.assertFalse(h.logged_in(ORIGIN + "/site/dashboard", ORIGIN, True, True))
        self.assertFalse(h.logged_in("https://other.fitbase.io/site/dashboard", ORIGIN, False, True))

    def test_payload_keeps_only_fitbase_cookies(self):
        cookies = [
            {"name": "_identity", "value": "v1", "domain": "ladyjump.fitbase.io", "path": "/",
             "expires": 1900000000.5, "httpOnly": True, "secure": True, "sameSite": "Lax"},
            {"name": "s", "value": "v2", "domain": ".fitbase.io", "path": "/", "expires": -1,
             "httpOnly": False, "secure": True, "sameSite": "Lax"},
            {"name": "ya", "value": "x", "domain": ".yandex.ru", "path": "/", "expires": -1},
        ]
        p = h.session_payload(ORIGIN, cookies)
        self.assertEqual(set(p), {"origin", "cookies"})
        self.assertEqual([c["name"] for c in p["cookies"]], ["_identity", "s"])
        self.assertNotIn("sameSite", p["cookies"][0])
        with self.assertRaises(h.Stop):
            h.session_payload(ORIGIN, cookies[2:])

    def test_send(self):
        seen = {}

        class Res(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def ok(req, timeout):
            seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
            seen["body"] = json.loads(req.data)
            return Res(b'{"ok": true, "studios": 3}')

        self.assertEqual(h.send("https://portal.example.ru", "T" * 43, {"origin": ORIGIN, "cookies": []}, ok), 3)
        self.assertEqual(seen["url"], "https://portal.example.ru/api/analytics/fitbase/session")
        self.assertEqual(seen["auth"], "Bearer " + "T" * 43)

        def refused(req, timeout):
            raise HTTPError(req.full_url, 400, "Bad", {}, io.BytesIO('{"error": "Код устарел"}'.encode()))

        with self.assertRaisesRegex(h.Stop, "Код устарел"):
            h.send("https://portal.example.ru", "T" * 43, {}, refused)


if __name__ == "__main__":
    unittest.main()
