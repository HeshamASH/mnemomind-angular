import os
import json
from fastapi import FastAPI, HTTPException, Body, Request, Cookie
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from elasticsearch import Elasticsearch
from dotenv import load_dotenv
from pathlib import Path
from itsdangerous import URLSafeSerializer
from urllib.parse import unquote
# from google.oauth2.credentials import Credentials
# from api.google_drive import get_google_flow, get_drive_service, get_sheets_service
from fastembed import TextEmbedding

# Construct the path to the .env.local file
dotenv_path = Path(__file__).resolve().parent.parent / '.env.local'
load_dotenv(dotenv_path=dotenv_path)

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

# Secret key for signing session data
# In a production application, this should be a long, random string stored securely
SECRET_KEY = "your-secret-key"
serializer = URLSafeSerializer(SECRET_KEY)

class SearchQuery(BaseModel):
    query: str

class Source(BaseModel):
    id: str
    file_name: str
    path: str

# @app.get("/api/auth/google")
# async def auth_google():
#     flow = get_google_flow()
#     authorization_url, state = flow.authorization_url(
#         access_type='offline',
#         include_granted_scopes='true'
#     )
#     response = RedirectResponse(url=authorization_url)
#     response.set_cookie(key="state", value=serializer.dumps(state))
#     return response

# @app.get("/api/auth/google/callback")
# async def auth_google_callback(request: Request, state: str = Cookie(None)):
#     if not state or serializer.loads(state) != request.query_params.get('state'):
#         raise HTTPException(status_code=400, detail="State mismatch")

#     flow = get_google_flow()
#     flow.fetch_token(authorization_response=str(request.url))
    
#     credentials = flow.credentials
    
#     # Store credentials in a secure, http-only cookie
#     response = RedirectResponse(url="/?source=google-drive") # Redirect to the frontend app
#     response.set_cookie(
#         key="credentials", 
#         value=serializer.dumps(credentials_to_dict(credentials)),
#         httponly=True,
#         samesite='lax'
#     )
#     return response

# def credentials_to_dict(credentials):
#     return {'token': credentials.token,
#             'refresh_token': credentials.refresh_token,
#             'token_uri': credentials.token_uri,
#             'client_id': credentials.client_id,
#             'client_secret': credentials.client_secret,
#             'scopes': credentials.scopes}

# @app.get("/api/drive/files")
# async def list_drive_files(credentials: str = Cookie(None)):
#     if not credentials:
#         raise HTTPException(status_code=401, detail="Not authenticated")

#     try:
#         creds_dict = serializer.loads(credentials)
#         creds = Credentials(**creds_dict)
#     except Exception:
#         raise HTTPException(status_code=401, detail="Invalid credentials")

#     drive_service = get_drive_service(creds)

#     try:
#         results = drive_service.files().list(
#             q="mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet'",
#             pageSize=100, 
#             fields="nextPageToken, files(id, name, mimeType, modifiedTime)").execute()
#         items = results.get('files', [])
#         return items
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=str(e))

# @app.get("/api/drive/files/{file_id}")
# async def get_drive_file(file_id: str, credentials: str = Cookie(None)):
#     if not credentials:
#         raise HTTPException(status_code=401, detail="Not authenticated")

#     try:
#         creds_dict = serializer.loads(credentials)
#         creds = Credentials(**creds_dict)
#     except Exception:
#         raise HTTPException(status_code=401, detail="Invalid credentials")

#     drive_service = get_drive_service(creds)

#     try:
#         file_metadata = drive_service.files().get(fileId=file_id).execute()
#         mime_type = file_metadata.get('mimeType')

#         if mime_type == 'application/vnd.google-apps.document':
#             request = drive_service.files().export_media(fileId=file_id, mimeType='text/plain')
#         elif mime_type == 'application/vnd.google-apps.spreadsheet':
#             request = drive_service.files().export_media(fileId=file_id, mimeType='text/csv')
#         else:
#             request = drive_service.files().get_media(fileId=file_id)
        
#         file_content = request.execute()
#         return {"content": file_content.decode('utf-8')}
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=str(e))

# @app.post("/api/sheets/export")
# async def export_to_sheets(request: Request, credentials: str = Cookie(None)):
#     if not credentials:
#         raise HTTPException(status_code=401, detail="Not authenticated")

#     try:
#         creds_dict = serializer.loads(credentials)
#         creds = Credentials(**creds_dict)
#     except Exception:
#         raise HTTPException(status_code=401, detail="Invalid credentials")

#     sheets_service = get_sheets_service(creds)
#     data = await request.json()
#     table_data = data.get('tableData')

#     try:
#         spreadsheet = {
#             'properties': {
#                 'title': 'Exported Table Data'
#             }
#         }
#         spreadsheet = sheets_service.spreadsheets().create(body=spreadsheet,
#                                                     fields='spreadsheetId,spreadsheetUrl').execute()
        
#         body = {
#             'values': table_data
#         }
#         result = sheets_service.spreadsheets().values().update(
#             spreadsheetId=spreadsheet.get('spreadsheetId'),
#             range='A1',
#             valueInputOption='RAW',
#             body=body).execute()

#         return {"sheetUrl": spreadsheet.get('spreadsheetId')}
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=str(e))



# ... (existing code) ...

embedding_model = TextEmbedding(model_name='BAAI/bge-small-en-v1.5', cache_dir='/tmp/fastembed_cache')

# ... (existing code) ...

import logging

# ... (existing code) ...

@app.post("/api/search")
async def search_documents(query: SearchQuery):
    try:
        query_vector = list(embedding_model.embed([query.query]))[0].tolist()

        search_body = {
            "knn": {
                "field": "chunk_vector",
                "query_vector": query_vector,
                "k": 10,
                "num_candidates": 20
            },
            "query": {
                "match": {
                    "chunk_text": {
                        "query": query.query,
                        "boost": 0.1
                    }
                }
            },
            "size": 10,
            "_source": ["file_name", "path", "chunk_text"]
        }

        response = es.search(
            index=ELASTIC_INDEX,
            body=search_body,
            rank={"rrf": {}}
        )

        results = []
        for hit in response["hits"]["hits"]:
            chunk_text = hit["_source"].get("chunk_text", "")
            if chunk_text:
                results.append({
                    "source": {
                        "id": hit["_id"],
                        "file_name": hit["_source"].get("file_name", ""),
                        "path": hit["_source"].get("path", "")
                    },
                    "contentSnippet": chunk_text,
                    "score": hit["_score"]
                })
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
