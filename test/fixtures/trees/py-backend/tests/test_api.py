from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "healthy"}

def test_create_item_validation():
    res = client.post("/api/items", json={"sku": "AB", "quantity": -5})
    assert res.status_code == 422
