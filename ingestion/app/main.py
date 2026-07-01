# ingestion/app/main.py
from fastapi import FastAPI

app = FastAPI(title="req2ado-ingestion")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
