async def test_healthz_reports_ok(client):
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_healthz_needs_no_token(client):
    response = await client.get("/healthz")
    assert response.status_code != 401
