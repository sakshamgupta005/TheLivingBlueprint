from fastapi import FastAPI
from app.api.endpoints import router as api_router

app = FastAPI(title="Inventory API")
app.include_router(api_router, prefix="/api")

@app.get("/health")
def health_check():
    return {"status": "healthy"}
