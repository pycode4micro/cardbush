"""One headed, persistent browser owned by the Personal Agent, not by a turn."""
import base64
import io
import uuid

from playwright.sync_api import sync_playwright
from PIL import Image

ELEMENT_METADATA = "e => ({tag:e.tagName, role:e.getAttribute('role'), name:(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || '').slice(0,300), type:e.getAttribute('type')})"


class Browser:
    def __init__(self, profile):
        self.playwright = sync_playwright().start()
        self.profile = profile
        try:
            self.context = self.launch()
        except Exception:
            self.playwright.stop()
            raise
        self.pages = {}
        self.elements = []
        self.observed_page = None
        self.observed_url = None
        self.sync_pages()

    def launch(self):
        context = self.playwright.chromium.launch_persistent_context(
            self.profile, headless=False, no_viewport=True, chromium_sandbox=True,
            args=["--no-first-run", "--disable-session-crashed-bubble", "--start-maximized"])
        context.set_default_timeout(7000)
        context.set_default_navigation_timeout(10000)
        return context

    def sync_pages(self):
        self.pages = {key: page for key, page in self.pages.items() if not page.is_closed()}
        for page in self.context.pages:
            if page not in self.pages.values():
                self.pages[str(uuid.uuid4())] = page
        return [{"tabId": key, "url": page.url, "title": page.title()[:300]} for key, page in self.pages.items()]

    def clear_observation(self):
        for element, _ in self.elements:
            try:
                element.dispose()
            except Exception:
                pass
        self.elements = []
        self.observed_page = None

    def execute(self, request):
        action = request["action"]
        if action == "open" and self.context.browser and not self.context.browser.is_connected():
            # Reopen only for an explicit open action, never merely because a preview polls.
            self.clear_observation()
            self.context = self.launch()
            self.pages = {}
        tabs = self.sync_pages()
        if action == "tabs":
            return {"tabs": tabs}
        if action == "open":
            if len(self.pages) >= 64:
                raise ValueError("Browser has 64 tabs. Reuse a tab or ask before closing one.")
            self.clear_observation()
            page = self.context.new_page()
            page.goto(request["url"], wait_until="domcontentloaded")
            page.bring_to_front()
            tabs = self.sync_pages()
            return {"tabs": tabs, "tabId": next(key for key, value in self.pages.items() if value == page)}
        page = self.pages.get(request.get("tabId"))
        if not page:
            raise ValueError("Unknown tabId; list tabs again.")
        if action in ("snapshot", "screenshot"):
            self.clear_observation()
            page.bring_to_front()
            self.observed_page, self.observed_url = page, page.url
            result = {"tabId": request["tabId"], "url": page.url, "title": page.title()[:300]}
            if action == "screenshot":
                image = page.screenshot(type="jpeg", quality=85, timeout=5000)
                # Browser zoom/DPR can make CSS viewport dimensions differ from image pixels.
                with Image.open(io.BytesIO(image)) as captured:
                    size = {"width": captured.width, "height": captured.height}
                return {**result, "image": {**size, "mimeType": "image/jpeg", "data": base64.b64encode(image).decode("ascii")}}
            # Retain actual ElementHandles; never rebind a stale numeric index to new DOM content.
            rows = []
            selected = page.evaluate_handle("""() => Array.from(document.querySelectorAll(
                'a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]'))
                .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').slice(0,200)""")
            try:
                handles = selected.get_properties()
            finally:
                selected.dispose()
            for handle in handles.values():
                element = handle.as_element()
                if not element:
                    handle.dispose()
                    continue
                if not element.is_visible():
                    element.dispose()
                    continue
                metadata = element.evaluate(ELEMENT_METADATA)
                self.elements.append((element, metadata))
                rows.append({"element": len(rows), **metadata})
            return {**result, "text": page.locator("body").inner_text(timeout=5000)[:24000], "elements": rows,
                    "note": "Top document visible controls only; use Computer Use for frames/canvas or other desktop apps."}
        if self.observed_page != page or self.observed_url != page.url:
            raise ValueError("Tab changed; take a fresh snapshot.")
        try:
            page.bring_to_front()
            if action == "navigate":
                page.goto(request["url"], wait_until="domcontentloaded")
            elif action in ("click", "fill"):
                index = request.get("element")
                if not isinstance(index, int) or not 0 <= index < len(self.elements):
                    raise ValueError("Missing snapshot element index.")
                element, metadata = self.elements[index]
                if not element.evaluate("e => e.isConnected") or not element.is_visible():
                    raise ValueError("Element changed; take a fresh snapshot.")
                current = element.evaluate(ELEMENT_METADATA)
                if metadata != current:
                    raise ValueError("Element changed; take a fresh snapshot.")
                if action == "click":
                    element.click()
                else:
                    element.fill(request["text"])
            elif action == "key":
                page.keyboard.press(request["key"])
            elif action == "scroll":
                page.mouse.wheel(0, -600 if request["direction"] == "up" else 600)
            elif action == "close":
                page.close()
            else:
                raise ValueError("Unknown browser action.")
            return {"status": "dispatched", "observeAgain": True}
        finally:
            self.clear_observation()

    def close(self):
        try:
            self.context.close()
        finally:
            self.playwright.stop()
