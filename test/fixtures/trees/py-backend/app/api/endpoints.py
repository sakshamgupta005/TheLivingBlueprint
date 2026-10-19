from fastapi import APIRouter, Depends
from app.models.schemas import ItemCreate, ItemResponse
from app.database import get_db

router = APIRouter()

@router.get("/items", response_model=list[ItemResponse])
def list_items(db=Depends(get_db)):
    return []

@router.post("/items", response_model=ItemResponse)
def create_item(payload: ItemCreate, db=Depends(get_db)):
    return {"id": 1, "sku": payload.sku, "quantity": payload.quantity}
