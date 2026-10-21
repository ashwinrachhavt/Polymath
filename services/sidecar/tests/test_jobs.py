from conftest import TEST_WORKSPACE


def job_body(key="key-1", workspace=TEST_WORKSPACE):
    return {
        "workspace_id": workspace,
        "kind": "extraction.docling",
        "payload": {"document_id": "doc-1"},
        "idempotency_key": key,
    }


async def test_create_job_queues_it(client, auth_headers):
    response = await client.post("/v1/jobs", json=job_body(), headers=auth_headers)
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "queued"
    assert body["replayed"] is False
    assert body["workspace_id"] == TEST_WORKSPACE


async def test_replay_returns_original_without_second_row(client, auth_headers):
    first = await client.post("/v1/jobs", json=job_body(), headers=auth_headers)
    second = await client.post("/v1/jobs", json=job_body(), headers=auth_headers)
    assert second.status_code == 201
    assert second.json()["replayed"] is True
    assert second.json()["id"] == first.json()["id"]


async def test_same_key_in_other_workspace_is_independent(client, auth_headers):
    first = await client.post("/v1/jobs", json=job_body(), headers=auth_headers)
    other = await client.post(
        "/v1/jobs", json=job_body(workspace="ws-other"), headers=auth_headers
    )
    assert other.status_code == 201
    assert other.json()["replayed"] is False
    assert other.json()["id"] != first.json()["id"]


async def test_get_job_is_workspace_scoped(client, auth_headers):
    created = (await client.post("/v1/jobs", json=job_body(), headers=auth_headers)).json()
    found = await client.get(
        f"/v1/jobs/{created['id']}",
        params={"workspace_id": TEST_WORKSPACE},
        headers=auth_headers,
    )
    assert found.status_code == 200
    hidden = await client.get(
        f"/v1/jobs/{created['id']}", params={"workspace_id": "ws-other"}, headers=auth_headers
    )
    assert hidden.status_code == 404


async def test_workspace_is_required(client, auth_headers):
    body = job_body()
    del body["workspace_id"]
    response = await client.post("/v1/jobs", json=body, headers=auth_headers)
    assert response.status_code == 422
