from pydantic import BaseModel, Field

class ItemCreate(BaseModel):
    sku: str = Field(..., min_length=3)
    quantity: int = Field(default=0, ge=0)

class ItemResponse(BaseModel):
    id: int
    sku: str
    quantity: int
