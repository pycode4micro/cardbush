from __future__ import annotations

from typing import Any

from cardbush_app.desktop.process import ForegroundProcessInfo
from cardbush_app.desktop import control as desktop_control_impl
from cardbush_app.desktop.control import DesktopControlTool


def test_internal_desktop_adapter_cannot_be_registered_as_a_model_tool() -> None:
    assert not hasattr(DesktopControlTool, "name")
    assert not hasattr(DesktopControlTool, "description")
    assert not hasattr(desktop_control_impl, "build_tool")


def test_desktop_control_schema_exposes_mouse_drag() -> None:
    schema = DesktopControlTool.input_schema

    assert "mouse_drag" in schema["properties"]["action"]["enum"]
    assert "sequence" in schema["properties"]["action"]["enum"]
    assert "wait" in schema["properties"]["action"]["enum"]
    assert "actions" in schema["properties"]
    assert schema["properties"]["to_x"]["type"] == "integer"
    assert schema["properties"]["to_y"]["type"] == "integer"


def test_desktop_control_mouse_drag_interpolates_and_releases(
    monkeypatch,
) -> None:
    tool = DesktopControlTool()
    moves: list[tuple[int, int]] = []
    flags: list[int] = []

    monkeypatch.setattr(
        DesktopControlTool,
        "_move_mouse",
        staticmethod(lambda *, x, y: moves.append((int(x), int(y)))),
    )
    monkeypatch.setattr(
        "cardbush_app.desktop.control._send_mouse_flags",
        lambda flag, mouse_data=0: flags.append(int(flag)),
    )
    monkeypatch.setattr(
        "cardbush_app.desktop.control.time.sleep",
        lambda seconds: None,
    )

    tool._drag_mouse(
        x=10,
        y=20,
        to_x=70,
        to_y=80,
        button="left",
        duration_ms=300,
        steps=3,
    )

    assert moves == [(10, 20), (30, 40), (50, 60), (70, 80)]
    assert len(flags) == 2
    assert flags[0] != flags[1]


def test_desktop_control_rejects_mouse_drag_without_destination() -> None:
    tool = DesktopControlTool()
    arguments: dict[str, Any] = {"action": "mouse_drag", "x": 1, "y": 2}

    try:
        tool._validate_arguments("mouse_drag", arguments)
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover - defensive assertion branch
        raise AssertionError("expected ValueError")

    assert "`x`, `y`, `to_x`, and `to_y`" in message


def test_desktop_control_sequence_executes_human_paced_steps(monkeypatch) -> None:
    tool = DesktopControlTool()
    events: list[tuple[Any, ...]] = []
    fake_process = ForegroundProcessInfo(
        hwnd=100,
        pid=200,
        proc_name="notepad.exe",
        exe_path="C:/Windows/notepad.exe",
        window_title="Notes",
        permission_path="process://notepad.exe",
    )

    monkeypatch.setattr(
        DesktopControlTool,
        "_resolve_target_process_info",
        lambda self, action, arguments: (fake_process, 0),
    )
    monkeypatch.setattr(
        DesktopControlTool,
        "_ensure_process_permission",
        lambda self, process_info, *, request_metadata: None,
    )
    monkeypatch.setattr(DesktopControlTool, "_check_failsafe", staticmethod(lambda: None))
    monkeypatch.setattr(
        DesktopControlTool,
        "_send_hotkey",
        lambda self, keys: events.append(("hotkey", tuple(keys))),
    )
    monkeypatch.setattr(
        DesktopControlTool,
        "_send_text",
        lambda self, text, interval: events.append(("typewrite", text, interval)),
    )
    monkeypatch.setattr(
        DesktopControlTool,
        "_move_mouse",
        staticmethod(lambda *, x, y: events.append(("move", x, y))),
    )
    monkeypatch.setattr(
        DesktopControlTool,
        "_click_mouse",
        lambda self, *, button, clicks: events.append(("click", button, clicks)),
    )
    monkeypatch.setattr(
        "cardbush_app.desktop.control.time.sleep",
        lambda seconds: events.append(("sleep", seconds)),
    )

    result = tool._execute(
        "sequence",
        {
            "action": "sequence",
            "actions": [
                {"action": "hotkey", "keys": ["ctrl", "l"], "pause_ms": 10},
                {"action": "typewrite", "text": "hello"},
                {"action": "wait", "pause_ms": 25},
                {"action": "mouse_click", "x": 10, "y": 20},
            ],
        },
        request_metadata={},
    )

    assert result["step_count"] == 4
    assert result["completed_count"] == 4
    assert events == [
        ("hotkey", ("ctrl", "l")),
        ("sleep", 0.01),
        ("typewrite", "hello", 0.0),
        ("sleep", 0.025),
        ("move", 10, 20),
        ("click", "left", 1),
    ]
    assert "Inspect or screenshot" in result["suggested_next_step"]


def test_desktop_control_sequence_rejects_nested_sequence() -> None:
    tool = DesktopControlTool()

    try:
        tool._validate_arguments(
            "sequence",
            {
                "action": "sequence",
                "actions": [{"action": "sequence", "actions": [{"action": "wait"}]}],
            },
        )
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover - defensive assertion branch
        raise AssertionError("expected ValueError")

    assert "nested `sequence` actions are not allowed" in message
