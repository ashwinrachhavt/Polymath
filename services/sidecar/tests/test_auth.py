from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app


async def test_missing_token_is_401(client):
    response = await client.post("/v1/jobs", json={
        "workspace_id": "ws", "kind": "k", "idempotency_key": "i",
    })
    assert response.status_code == 401


async def test_wrong_token_is_401(client):
    response = await client.post(
        "/v1/jobs",
        json={"workspace_id": "ws", "kind": "k", "idempotency_key": "i"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert response.status_code == 401


async def test_unconfigured_service_fails_closed(tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{tmp_path}/t.db", sidecar_token=None
    )
    app = create_app(settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/v1/jobs", json={
            "workspace_id": "ws", "kind": "k", "idempotency_key": "i",
        })
    assert response.status_code == 503
