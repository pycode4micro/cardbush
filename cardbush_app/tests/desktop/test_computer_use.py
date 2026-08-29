from __future__ import annotations

import asyncio
import json

from cardbush_app.desktop.computer_use import ComputerUseTool


class _RecordingControl:
    def __init__(self, output: dict[str, object]) -> None:
        self.arguments: dict[str, object] | None = None
        self._output = output

    async def run(self, arguments: dict[str, object]) -> str:
        self.arguments = dict(arguments)
        return json.dumps(self._output)


def test_computer_use_publishes_only_canonical_actions() -> None:
    action_schema = ComputerUseTool.input_schema["properties"]["action"]

    assert ComputerUseTool.name == "computer_use"
    assert action_schema["enum"] == [
        "observe",
        "screenshot",
        "click",
        "type",
        "key",
        "scroll",
        "drag",
        "window",
        "open_app",
    ]


def test_computer_use_translates_click_and_returns_canonical_result() -> None:
    tool = ComputerUseTool()
    internal = _RecordingControl(
        {"status": "ok", "action": "mouse_click", "result": {"clicked": True}}
    )
    tool._control = internal  # type: ignore[assignment]

    output = asyncio.run(
        tool.run(
            {"action": "click", "x": 25, "y": 40, "button": "left"},
            request_context={"session_id": "session-1"},
        )
    )

    assert internal.arguments == {
        "action": "mouse_click",
        "x": 25,
        "y": 40,
        "button": "left",
        "_bush_context": {"session_id": "session-1"},
    }
    assert output["protocol"] == "cardbush_app.computer_result.v1"
    assert output["outcome"]["semantic_success"] is True


def test_invalid_action_fails_without_dispatch() -> None:
    output = asyncio.run(ComputerUseTool().run({"action": "shell"}))

    assert output["outcome"] == {
        "semantic_success": False,
        "verification_state": "failed",
        "error_code": "invalid_action",
    }
