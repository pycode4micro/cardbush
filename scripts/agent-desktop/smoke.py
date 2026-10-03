"""Run only in a disposable Linux desktop container. No model/API credentials needed."""
import http.server
import json
import tempfile
import threading

from browser import Browser
from computer import Computer


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b'<html><body style="margin:100px"><h1>Desktop fixture</h1><input aria-label="Message"><button onclick="document.querySelector(\'h1\').textContent=\'clicked\'">Apply</button></body></html>')

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="cardbush-desktop-smoke-") as profile:
        browser, computer = Browser(profile), Computer()
        try:
            result = browser.execute({"action": "open", "url": f"http://127.0.0.1:{server.server_port}/"})
            tab_id = result["tabId"]
            snapshot = browser.execute({"action": "snapshot", "tabId": tab_id})
            field = next(item["element"] for item in snapshot["elements"] if item["name"] == "Message")
            browser.execute({"action": "fill", "tabId": tab_id, "element": field, "text": "中文 Linux test"})
            page = browser.pages[tab_id]
            assert page.locator("input").input_value() == "中文 Linux test"
            computer.observe()
            computer.input({"action": "key", "key": "ctrl+a"}, agent=True)
            computer.observe()
            computer.input({"action": "type", "text": "跨工具输入"}, agent=True)
            page.wait_for_function("document.querySelector('input').value === '跨工具输入'")
            snapshot = browser.execute({"action": "snapshot", "tabId": tab_id})
            button = next(item["element"] for item in snapshot["elements"] if item["name"] == "Apply")
            browser.execute({"action": "click", "tabId": tab_id, "element": button})
            assert page.locator("h1").inner_text() == "clicked"
            shot = computer.observe()["image"]
            assert shot["width"] >= 800 and shot["height"] >= 600 and len(shot["data"]) > 1000
            try:
                computer.input({"action": "click", "x": shot["width"], "y": 0}, agent=True)
                raise AssertionError("out-of-bounds click accepted")
            except ValueError:
                pass
            page.evaluate("localStorage.setItem('cardbush-smoke', 'persisted')")
            browser.close()
            browser = Browser(profile)
            result = browser.execute({"action": "open", "url": f"http://127.0.0.1:{server.server_port}/"})
            assert browser.pages[result["tabId"]].evaluate("localStorage.getItem('cardbush-smoke')") == "persisted"
            print(json.dumps({"ok": True, "checks": ["headed browser", "DOM", "Unicode", "computer keyboard", "original screenshot", "coordinate bounds", "profile persistence"]}))
        finally:
            browser.close()
            computer.close()
finally:
    server.shutdown()
