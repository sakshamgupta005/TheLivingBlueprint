import type { BenchmarkFixture } from './types.ts';

export const pyBackendFixture: BenchmarkFixture = {
  id: 'fixture-py-backend',
  name: 'Python Backend',
  owner: 'benchmark-org',
  repo: 'fastapi-inventory-api',
  defaultBranch: 'main',
  commitSha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
  checkRuns: [
    {
      id: 9003,
      name: 'pytest',
      status: 'completed',
      conclusion: 'success',
      commitSha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
      completedAt: '2026-10-19T00:00:00Z',
      htmlUrl: 'https://github.com/benchmark-org/fastapi-inventory-api/actions/runs/3/job/9003',
      isRelevantTestCheck: true,
    },
  ],
  files: {
    'pyproject.toml': `[project]
name = "fastapi-inventory-api"
version = "0.1.0"
description = "Inventory management backend in FastAPI"
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn>=0.28.0",
    "pydantic>=2.6.0",
    "sqlalchemy>=2.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "httpx>=0.27.0",
]
`,
    'README.md': `# Inventory API\n\nFastAPI backend service with SQLAlchemy persistence and Pydantic validation schemas.`,
    'app/main.py': `from fastapi import FastAPI
from app.api.endpoints import router as api_router

app = FastAPI(title="Inventory API")
app.include_router(api_router, prefix="/api")

@app.get("/health")
def health_check():
    return {"status": "healthy"}
`,
    'app/api/endpoints.py': `from fastapi import APIRouter, Depends
from app.models.schemas import ItemCreate, ItemResponse
from app.database import get_db

router = APIRouter()

@router.get("/items", response_model=list[ItemResponse])
def list_items(db=Depends(get_db)):
    return []

@router.post("/items", response_model=ItemResponse)
def create_item(payload: ItemCreate, db=Depends(get_db)):
    return {"id": 1, "sku": payload.sku, "quantity": payload.quantity}
`,
    'app/models/schemas.py': `from pydantic import BaseModel, Field

class ItemCreate(BaseModel):
    sku: str = Field(..., min_length=3)
    quantity: int = Field(default=0, ge=0)

class ItemResponse(BaseModel):
    id: int
    sku: str
    quantity: int
`,
    'app/database.py': `from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = "sqlite:///./inventory.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
`,
    'tests/test_api.py': `from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "healthy"}

def test_create_item_validation():
    res = client.post("/api/items", json={"sku": "AB", "quantity": -5})
    assert res.status_code == 422
`,
    '.github/workflows/python.yml': `name: Python Tests
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -e .[dev]
      - run: pytest
`,
  },
  knownFacts: {
    name: 'Python Backend',
    description: 'FastAPI Python backend with Pydantic validation schemas, SQLAlchemy DB, and pytest tests.',
    entryPoints: ['app/main.py'],
    routes: ['GET /health', 'GET /api/items', 'POST /api/items'],
    imports: [
      { from: 'app/main.py', to: 'app/api/endpoints.py' },
      { from: 'app/api/endpoints.py', to: 'app/models/schemas.py' },
      { from: 'app/api/endpoints.py', to: 'app/database.py' },
      { from: 'tests/test_api.py', to: 'app/main.py' },
    ],
    tests: ['tests/test_api.py'],
    workflows: ['.github/workflows/python.yml'],
    expectedRelationships: [
      { source: 'room-server', target: 'room-validation', type: 'calls' },
      { source: 'room-server', target: 'room-database', type: 'calls' },
      { source: 'room-tests', target: 'room-server', type: 'imports' },
    ],
    expectedRooms: ['room-server', 'room-validation', 'room-database', 'room-tests'],
    unsupportedOrUncertainFacts: [
      'PostgreSQL/SQLite connection pooling capacity under concurrent production load',
      'Dynamic Python monkey-patching or untyped runtime attributes',
      'Execution of Alembic migrations cannot be proven statically without running DB',
    ],
  },
};
