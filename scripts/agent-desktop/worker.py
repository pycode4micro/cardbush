"""Bounded JSON-lines protocol over inherited private stdio. No listening ports."""
import json
import sys

from browser import Browser
from computer import Computer


def main():
    computer = None
    browser = None
    try:
        while True:
            line = sys.stdin.readline(128 * 1024)
            if not line:
                break
            if not line.endswith("\n"):
                raise ValueError("Desktop request too large.")
            request = json.loads(line)
            try:
                operation, data = request["operation"], request["input"]
                if operation == "initialize":
                    computer = Computer()
                    computer.frame()
                    browser = Browser(sys.argv[1])
                    value = {"ready": True}
                elif computer is None or browser is None:
                    raise ValueError("Desktop not initialized.")
                elif operation == "frame":
                    value = computer.frame()
                elif operation == "input":
                    browser.clear_observation()
                    value = computer.input(data)
                elif operation == "computer":
                    browser.clear_observation()
                    value = computer.observe() if data["action"] == "observe" else computer.input(data, agent=True)
                elif operation == "browser":
                    computer.observation = None
                    value = browser.execute(data)
                else:
                    raise ValueError("Unknown desktop operation.")
                result = {"id": request["id"], "value": value}
            except Exception as error:
                # Playwright errors can contain page text/selectors/URLs; send only bounded diagnostics.
                lines = str(error).splitlines()
                # Chromium's launch arguments can consume the entire budget before the cause.
                # Preserve stderr diagnostics instead of the long command and duplicated call log.
                stderr = list(dict.fromkeys(line for line in lines if "[err]" in line and not line.lstrip().startswith("- ")))
                message = "\n".join([lines[0], *stderr]) if stderr else str(error)
                result = {"id": request["id"], "error": message[:1200]}
            print(json.dumps(result, ensure_ascii=True), flush=True)
    finally:
        if browser:
            browser.close()
        if computer:
            computer.close()


if __name__ == "__main__":
    main()
