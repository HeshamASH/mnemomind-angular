import os
import json
from fastapi import FastAPI, HTTPException, Body, Request, Cookie
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from elasticsearch import Elasticsearch
from pathlib import Path
from itsdangerous import URLSafeSerializer
from urllib.parse import unquote
# from fastembed import TextEmbedding

ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ELASTIC_INDEX = os.getenv("ELASTIC_INDEX")

if not all([ELASTIC_CLOUD_ID, ELASTIC_API_KEY, ELASTIC_INDEX]):
    raise RuntimeError("Missing required environment variables for Elasticsearch")

es = Elasticsearch(
    cloud_id=ELASTIC_CLOUD_ID,
    api_key=ELASTIC_API_KEY
)

app = FastAPI()

app.mount("/static", StaticFiles(directory="../static"), name="static")

# ... (routes) ...

# embedding_model = TextEmbedding(model_name='BAAI/bge-small-en-v1.5', cache_dir='/tmp/fastembed_cache')

# ... (existing code) ...

import logging

# ... (existing code) ...

# @app.post("/api/search")
# async def search_documents(query: SearchQuery):
#     try:
#         query_vector = list(embedding_model.embed([query.query]))[0].tolist()
# 
#         search_body = {
#             "knn": {
#                 "field": "chunk_vector",
#                 "query_vector": query_vector,
#                 "k": 10,
#                 "num_candidates": 20
#             },
#             "query": {
#                 "match": {
#                     "chunk_text": {
#                         "query": query.query,
#                         "boost": 0.1
#                     }
#                 }
#             },
#             "size": 10,
#             "_source": ["file_name", "path", "chunk_text"]
#         }
# 
#         response = es.search(
#             index=ELASTIC_INDEX,
#             body=search_body,
#             rank={"rrf": {}}
#         )
# 
#         results = []
#         for hit in response["hits"]["hits"]:
#             chunk_text = hit["_source"].get("chunk_text", "")
#             if chunk_text:
#                 results.append({
#                     "source": {
#                         "id": hit["_id"],
#                         "file_name": hit["_source"].get("file_name", ""),
#                         "path": hit["_source"].get("path", "")
#                     },
#                     "contentSnippet": chunk_text,
#                     "score": hit["_score"]
#                 })
#         return results
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/{file_id}")
async def get_file_content(file_id: str):
    try:
        decoded_file_id = unquote(file_id)
        response = es.get(index=ELASTIC_INDEX, id=decoded_file_id)
        return {"content": response["_source"].get("content", "Content not found")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files")
async def get_all_files():
    try:
        response = es.search(
            index=ELASTIC_INDEX,
            body={
                "size": 1000,
                "query": { "match_all": {} },
                "_source": ["file_name", "path"]
            }
        )
        results = [
            {
                "id": hit["_id"],
                "file_name": hit["_source"].get("file_name", ""),
                "path": hit["_source"].get("path", "")
            }
            for hit in response["hits"]["hits"]
        ]
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    return FileResponse("../static/index.html")
