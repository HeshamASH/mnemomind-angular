import os
import logging
import base64
from pathlib import Path
from dotenv import load_dotenv
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk, BulkIndexError
# --- CHANGED: Import the correct class ---
from fastembed import TextEmbedding 
from langchain.text_splitter import RecursiveCharacterTextSplitter
import PyPDF2
import docx
import time
import numpy as np

# --- Configuration ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Constants ---
ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ES_INDEX_NAME = os.getenv("ELASTIC_INDEX", "rag_documents")

# 'BAAI/bge-small-en-v1.5' is the default and is 384 dimensions
EMBEDDING_MODEL_NAME = 'BAAI/bge-small-en-v1.5'
EMBEDDING_DIM = 384  # This is correct for bge-small-en-v1.5
DOCS_FOLDER = "./fixed_documents"
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150

# --- Helper Functions (No Changes) ---

def get_file_content_and_type(file_path: Path) -> tuple[str | bytes | None, str | None]:
    """Reads file content based on extension, returning content and type."""
    suffix = file_path.suffix.lower()
    content = None
    content_type = None

    try:
        if suffix == ".pdf":
            with open(file_path, "rb") as f:
                content = f.read()
            content_type = "pdf_base64"
        elif suffix == ".docx":
            text = ""
            doc = docx.Document(file_path)
            for para in doc.paragraphs:
                text += para.text + "\n"
            content = text
            content_type = "text"
        elif suffix in [".txt", ".md", ".py", ".js", ".ts", ".html", ".css", ".json", ".yaml", ".yml"]:
             with open(file_path, "r", encoding="utf-8", errors='ignore') as f:
                content = f.read()
             content_type = "text"
        else:
            logging.warning(f"Skipping unsupported file type: {file_path.name}")
    except FileNotFoundError:
        logging.error(f"File not found: {file_path}")
    except Exception as e:
        logging.error(f"Error reading {file_path.name}: {e}", exc_info=False)
    return content, content_type


def extract_text_from_pdf(file_bytes: bytes, file_path_str: str) -> str:
    """Extracts text from PDF bytes using PyPDF2."""
    text = ""
    try:
        import io
        pdf_file = io.BytesIO(file_bytes)
        reader = PyPDF2.PdfReader(pdf_file)
        if reader.is_encrypted:
            try:
                reader.decrypt('')
            except Exception as decrypt_error:
                logging.warning(f"Skipping encrypted PDF (password needed): {file_path_str} - {decrypt_error}")
                return ""
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    except Exception as e:
        logging.error(f"Error extracting text from PDF {Path(file_path_str).name}: {e}", exc_info=False)
    return text


# --- Main Execution ---
if __name__ == "__main__":
    logging.info("--- Starting Document Indexing Script (using FastEmbed) ---")

    # 1. Validate Configuration
    if not ELASTIC_CLOUD_ID or not ELASTIC_API_KEY:
        logging.error("Elastic Cloud ID or API Key not found. Check .env or .env.local. Exiting.")
        exit(1)
    docs_path = Path(DOCS_FOLDER)
    if not docs_path.is_dir():
        logging.error(f"Documents folder '{DOCS_FOLDER}' not found. Exiting.")
        exit(1)

    # 2. Connect to Elasticsearch
    logging.info("Connecting to Elasticsearch...")
    try:
        es_client = Elasticsearch(
            cloud_id=ELASTIC_CLOUD_ID,
            api_key=ELASTIC_API_KEY,
            request_timeout=60
        )
        if not es_client.ping():
             raise ConnectionError("Ping failed.")
        logging.info("Connected to Elasticsearch successfully.")
    except Exception as e:
        logging.error(f"Failed to connect to Elasticsearch: {e}", exc_info=True)
        exit(1)

    # 3. Load Embedding Model
    logging.info(f"Loading embedding model: {EMBEDDING_MODEL_NAME} (using FastEmbed)...")
    try:
        # --- CHANGED: Use the correct class name 'TextEmbedding' ---
        embedding_model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
        logging.info("Embedding model loaded.")
    except Exception as e:
        logging.error(f"Failed to load FastEmbed model: {e}", exc_info=True)
        logging.error("Make sure 'fastembed' and its dependencies are installed: pip install fastembed")
        exit(1)

    # 4. Initialize Text Splitter (No Change)
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
        separators=["\n\n", "\n", " ", "", ".", ",", ";", ":", "(", ")", "[", "]", "{", "}"]
    )

    # 5. Prepare Index Mapping (No Change, EMBEDDING_DIM is still 384)
    index_mapping = {
        "properties": {
            "file_name": {"type": "keyword"},
            "path": {"type": "keyword"},
            "content": {"type": "text", "index": False},
            "content_type": {"type": "keyword"},
            "chunk_text": {"type": "text"},
            "chunk_vector": {
                "type": "dense_vector",
                "dims": EMBEDDING_DIM,
                "index": True,
                "similarity": "cosine"
            },
            "timestamp": {"type": "date"}
        }
    }
    try:
        if es_client.indices.exists(index=ES_INDEX_NAME):
            logging.info(f"Deleting existing index '{ES_INDEX_NAME}'...")
            es_client.indices.delete(index=ES_INDEX_NAME)
        if not es_client.indices.exists(index=ES_INDEX_NAME):
            logging.info(f"Creating index '{ES_INDEX_NAME}' with mapping...")
            es_client.indices.create(index=ES_INDEX_NAME, mappings=index_mapping, ignore=400)
        else:
             logging.info(f"Index '{ES_INDEX_NAME}' already exists.")
    except Exception as e:
        logging.error(f"Error creating/checking index '{ES_INDEX_NAME}': {e}", exc_info=True)
        exit(1)

    # 6. Process Documents and Generate Bulk Actions
    all_actions = []
    file_count = 0
    total_chunks_processed = 0
    start_time = time.time()

    logging.info(f"Scanning documents in '{DOCS_FOLDER}' (including subdirectories)...")

    for file_path in docs_path.rglob('*'):
        if file_path.is_file():
            file_name = file_path.name
            try:
                relative_path_obj = file_path.relative_to(docs_path).parent
                relative_path = str(relative_path_obj).replace('\\', '/')
                if relative_path == '.':
                    relative_path = ''
            except ValueError:
                relative_path = ''


            logging.info(f"Processing: {file_path}")
            file_count += 1

            full_content_raw, content_type = get_file_content_and_type(file_path)

            if full_content_raw is None or not content_type:
                logging.warning(f"  Skipping {file_name} due to read error or unsupported type.")
                continue

            # --- Prepare Full Content Field (No Change) ---
            full_content_for_es = None
            text_for_chunking = ""
            if content_type == "pdf_base64":
                full_content_for_es = base64.b64encode(full_content_raw).decode('utf-8')
                text_for_chunking = extract_text_from_pdf(full_content_raw, str(file_path))
            elif content_type == "text":
                full_content_for_es = full_content_raw
                text_for_chunking = full_content_raw
            else:
                 logging.warning(f"  Internal error: Unexpected content_type '{content_type}'. Skipping.")
                 continue

            if not text_for_chunking or text_for_chunking.isspace():
                logging.warning(f"  No text available for chunking in {file_name}. Indexing document metadata only.")
                doc_id = f"file-{os.path.join(relative_path, file_name)}-{file_path.stat().st_mtime}"
                action = {
                    "_index": ES_INDEX_NAME, "_id": doc_id,
                    "_source": {
                        "file_name": file_name, "path": relative_path,
                        "content": full_content_for_es, "content_type": content_type,
                        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                        "chunk_text": None, "chunk_vector": None
                    }
                }
                all_actions.append(action)
                continue

            # --- Chunk the text (No Change) ---
            try:
                chunks = text_splitter.split_text(text_for_chunking)
                if not chunks:
                     logging.warning(f"  Text splitting resulted in zero chunks for {file_name}. Skipping.")
                     continue
                logging.info(f"  Split into {len(chunks)} chunks.")
            except Exception as e_split:
                 logging.error(f"  Error splitting text for {file_name}: {e_split}. Skipping file.")
                 continue

            # --- Embed chunks in a single batch (No Change from previous FastEmbed version) ---
            try:
                valid_chunks = [chunk for chunk in chunks if chunk and not chunk.isspace()]
                if not valid_chunks:
                    logging.warning(f"  No valid (non-empty) chunks found after splitting {file_name}. Skipping.")
                    continue
                
                logging.info(f"  Embedding {len(valid_chunks)} chunks in one batch...")
                vectors = list(embedding_model.embed(valid_chunks))
                logging.info(f"  Embedding complete.")

                if len(vectors) != len(valid_chunks):
                    logging.error(f"  Mismatch in chunk count ({len(valid_chunks)}) and vector count ({len(vectors)}). Skipping file.")
                    continue

                for i, (chunk, vector) in enumerate(zip(valid_chunks, vectors)):
                    chunk_id = f"chunk-{os.path.join(relative_path, file_name)}-{file_path.stat().st_mtime}-{i}"
                    action = {
                        "_index": ES_INDEX_NAME,
                        "_id": chunk_id,
                        "_source": {
                            "file_name": file_name,
                            "path": relative_path,
                            "content": full_content_for_es,
                            "content_type": content_type,
                            "chunk_text": chunk,
                            "chunk_vector": vector.tolist(),
                            "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                        }
                    }
                    all_actions.append(action)
                
                total_chunks_processed += len(valid_chunks)

            except Exception as e_embed:
                logging.error(f"  Error during batch embedding for {file_name}: {e_embed}", exc_info=True)
                continue
            
            # --- Bulk Indexing in Batches (No Change) ---
            if len(all_actions) >= 500:
                logging.info(f"Indexing batch of {len(all_actions)} actions...")
                try:
                    success, failed = bulk(
                        client=es_client.options(request_timeout=120),
                        actions=all_actions,
                        raise_on_error=False,
                        raise_on_exception=False,
                        max_retries=2,
                        initial_backoff=1,
                        max_backoff=5
                    )
                    logging.info(f"  Batch Indexing: {success} succeeded.")
                    if failed:
                        logging.error(f"  Batch Indexing Failed Docs: {len(failed)}")
                    all_actions = []
                except BulkIndexError as e_bulk:
                     logging.error(f"BULK INDEXING ERROR: {len(e_bulk.errors)} docs failed.", exc_info=False)
                     all_actions = []
                except Exception as e_bulk_other:
                    logging.error(f"Unexpected error during bulk indexing: {e_bulk_other}", exc_info=True)
                    all_actions = []

    # 7. Index any remaining actions (No Change)
    if all_actions:
        logging.info(f"Indexing final batch of {len(all_actions)} actions...")
        try:
             success, failed = bulk(
                 client=es_client.options(request_timeout=120),
                 actions=all_actions,
                 raise_on_error=False,
                 raise_on_exception=False,
                 max_retries=2,
                 initial_backoff=1,
                 max_backoff=5
             )
             logging.info(f"  Final Batch Indexing: {success} succeeded.")
             if failed:
                 logging.error(f"  Final Batch Indexing Failed Docs: {len(failed)}")
        except BulkIndexError as e_bulk:
            logging.error(f"FINAL BULK INDEXING ERROR: {len(e_bulk.errors)} docs failed.", exc_info=False)
        except Exception as e_bulk_other:
            logging.error(f"Unexpected error during final bulk indexing: {e_bulk_other}", exc_info=True)

    end_time = time.time()
    logging.info("--- Document Indexing Script Finished ---")
    logging.info(f"Processed {file_count} files found in '{DOCS_FOLDER}'.")
    logging.info(f"Generated and attempted to index {total_chunks_processed} chunks.")
    logging.info(f"Total time: {end_time - start_time:.2f} seconds.")

