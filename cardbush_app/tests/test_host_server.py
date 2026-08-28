from __future__ import annotations

from pathlib import Path

from starlette.testclient import TestClient

from cardbush_app.server import create_app


def test_host_routes_are_authenticated_and_bot_owned(tmp_path: Path) -> None:
    app = create_app(
        data_dir=tmp_path,
        bushserver_host="127.0.0.1",
        bushserver_port=51999,
        bushserver_token="",
        host_token="host-secret",
    )
    with TestClient(app) as client:
        assert client.get("/readyz").status_code == 200
        assert client.get("/host/v1/bots").status_code == 401
        response = client.get(
            "/host/v1/bots",
            headers={"Authorization": "Bearer host-secret"},
        )
        assert response.status_code == 200
        assert response.json()["protocol"] == "cardbush_app.bots.v1"


def test_bot_config_round_trip_stays_in_cardbush_data(tmp_path: Path) -> None:
    app = create_app(
        data_dir=tmp_path,
        bushserver_host="127.0.0.1",
        bushserver_port=51999,
        bushserver_token="",
        host_token="host-secret",
    )
    headers = {"Authorization": "Bearer host-secret"}
    with TestClient(app) as client:
        saved = client.put(
            "/host/v1/bots/weixin/config",
            headers=headers,
            json={"enabled": False, "app_id": "bot"},
        )
        assert saved.status_code == 200
        assert saved.json()["protocol"] == "cardbush_app.bot_config.v1"
    assert (tmp_path / "config" / "bots.json").is_file()
