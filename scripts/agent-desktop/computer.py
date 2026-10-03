"""X11 implementation for the explicitly enabled, container-owned desktop."""
import base64
import io
import re
import subprocess

import mss
from PIL import Image, ImageChops


class Computer:
    def __init__(self):
        self.screen = mss.mss()
        self.observation = None

    def capture(self):
        shot = self.screen.grab(self.screen.monitors[0])
        if shot.width > 4096 or shot.height > 2160:
            raise ValueError("Desktop exceeds 4096 x 2160; configure a smaller virtual display.")
        return Image.frombytes("RGB", shot.size, shot.rgb)

    @staticmethod
    def encode(image):
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=85)
        return {"width": image.width, "height": image.height, "mimeType": "image/jpeg",
                "data": base64.b64encode(output.getvalue()).decode("ascii")}

    def frame(self):
        return self.encode(self.capture())

    def observe(self):
        image = self.capture()
        self.observation = (image.copy(), self.active_window())
        return {"image": self.encode(image), "coordinateSpace": "desktop_pixels", "displays": 1}

    @staticmethod
    def active_window():
        return subprocess.check_output(["xdotool", "getactivewindow"], timeout=4, stderr=subprocess.DEVNULL).strip()

    @staticmethod
    def run(*args, text=None):
        return subprocess.run(args, input=text, text=True, check=True, timeout=4,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def input(self, event, agent=False):
        image = self.capture()
        if agent:
            observed, self.observation = self.observation, None
            if not observed or observed[0].size != image.size or observed[1] != self.active_window():
                raise ValueError("Desktop changed since observation. Observe again before acting.")
            delta = ImageChops.difference(image, observed[0]).convert("L")
            changed = sum(delta.histogram()[26:])
            # Permit only small caret/clock repaints; reject window/page movement and animation.
            if changed > min(200, image.width * image.height // 5000):
                raise ValueError("Desktop changed since observation. Observe again before acting.")
        elif image.size != (event["width"], event["height"]):
            raise ValueError("Display dimensions changed. Wait for a fresh frame.")
        action = event["action"]
        if action in ("click", "drag", "scroll"):
            x, y = event["x"], event["y"]
            if not (0 <= x < image.width and 0 <= y < image.height):
                raise ValueError("Pointer outside the desktop.")
            self.run("xdotool", "mousemove", "--sync", str(x), str(y))
        if action == "click":
            self.run("xdotool", "click", str({"left": 1, "middle": 2, "right": 3}[event.get("button", "left")]))
        elif action == "drag":
            x, y = event["toX"], event["toY"]
            if not (0 <= x < image.width and 0 <= y < image.height):
                raise ValueError("Drag target outside the desktop.")
            try:
                self.run("xdotool", "mousedown", "1")
                self.run("xdotool", "mousemove", "--sync", str(x), str(y))
            finally:
                self.run("xdotool", "mouseup", "1")
        elif action == "scroll":
            self.run("xdotool", "click", "--repeat", str(event.get("steps", 3)), "--delay", "50",
                     "4" if event["direction"] == "up" else "5")
        elif action == "key":
            key = event["key"]
            if not re.fullmatch(r"[A-Za-z0-9_+]{1,80}", key):
                raise ValueError("Invalid X11 key sequence.")
            self.run("xdotool", "key", "--clearmodifiers", key)
        elif action == "type":
            # X11 keycodes cannot represent arbitrary Unicode. Paste in the isolated desktop.
            self.run("xclip", "-selection", "clipboard", text=event["text"])
            self.run("xdotool", "key", "--clearmodifiers", "ctrl+v")
        else:
            raise ValueError("Unknown input action.")
        return {"status": "dispatched", "observeAgain": True}

    def close(self):
        self.screen.close()
