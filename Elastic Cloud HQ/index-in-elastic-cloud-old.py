import os
import logging
import base64 # Import base64 encoding
from pathlib import Path
from dotenv import load_dotenv
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk, BulkIndexError
from sentence_transformers import SentenceTransformer
from langchain.text_splitter import RecursiveCharacterTextSplitter
import PyPDF2
import docx
import time

# --- Configuration ---
load_dotenv() # Load environment variables from .env file (or .env.local if preferred)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Constants ---
ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ES_INDEX_NAME = os.getenv("ELASTIC_INDEX", "rag_documents") # Get index name from env or default
EMBEDDING_MODEL_NAME = 'sentence-transformers/all-MiniLM-L6-v2'
# Embedding dimension depends on the model, all-MiniLM-L6-v2 is 384
EMBEDDING_DIM = 384 # Confirm this matches your model and index mapping
DOCS_FOLDER = "./fixed_documents" # --- IMPORTANT: Update this path if your documents are elsewhere ---
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
# Optional: Set a user ID for these preloaded docs if needed for filtering later
# TARGET_USER_ID = os.getenv("PRELOAD_USER_ID", "preloaded_general_docs")

# --- Helper Functions ---

def get_file_content_and_type(file_path: Path) -> tuple[str | bytes | None, str | None]:
    """Reads file content based on extension, returning content and type."""
    suffix = file_path.suffix.lower()
    content = None
    content_type = None

    try:
        if suffix == ".pdf":
            # Read PDF as binary for base64 encoding
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
        elif suffix in [".txt", ".md", ".py", ".js", ".ts", ".html", ".css", ".json", ".yaml", ".yml"]: # Add other text types
            # Read text files with UTF-8 encoding
             with open(file_path, "r", encoding="utf-8", errors='ignore') as f: # Ignore errors for robustness
                content = f.read()
             content_type = "text"
        else:
            logging.warning(f"Skipping unsupported file type: {file_path.name}")

    except FileNotFoundError:
        logging.error(f"File not found: {file_path}")
    except Exception as e:
        logging.error(f"Error reading {file_path.name}: {e}", exc_info=False) # Keep log concise

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
                reader.decrypt('') # Try empty password
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
    logging.info("--- Starting Document Indexing Script ---")

    # 1. Validate Configuration
    if not ELASTIC_CLOUD_ID or not ELASTIC_API_KEY:
        logging.error("Elastic Cloud ID or API Key not found. Check .env or environment variables. Exiting.")
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
            request_timeout=60 # Default timeout
        )
        if not es_client.ping():
             raise ConnectionError("Ping failed.")
        logging.info("Connected to Elasticsearch successfully.")
    except Exception as e:
        logging.error(f"Failed to connect to Elasticsearch: {e}", exc_info=True)
        exit(1)

    # 3. Load Embedding Model
    logging.info(f"Loading embedding model: {EMBEDDING_MODEL_NAME}...")
    try:
        # Specify cache folder to potentially avoid re-downloads
        # cache_dir = Path("./embedding_model_cache")
        # cache_dir.mkdir(exist_ok=True)
        embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME) #, cache_folder=str(cache_dir))
        logging.info("Embedding model loaded.")
    except Exception as e:
        logging.error(f"Failed to load embedding model: {e}", exc_info=True)
        # Check network connection, model name, and dependencies (PyTorch, transformers)
        exit(1)

    # 4. Initialize Text Splitter
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
        # Common separators, add language-specific ones if needed
        separators=["\n\n", "\n", " ", "", ".", ",", ";", ":", "(", ")", "[", "]", "{", "}"]
    )

    # 5. Prepare Index Mapping (Optional but Recommended)
    # Define the mapping for your index to ensure correct field types, especially for vectors
    index_mapping = {
        "properties": {
            "file_name": {"type": "keyword"}, # Use keyword for exact matching/filtering
            "path": {"type": "keyword"},
            "content": {"type": "text", "index": False}, # Store full content, don't index it for search directly
            "content_type": {"type": "keyword"}, # 'text' or 'pdf_base64'
            "chunk_text": {"type": "text"}, # Text chunk for searching
            "chunk_vector": {
                "type": "dense_vector",
                "dims": EMBEDDING_DIM, # Ensure this matches your model dimension
                "index": True, # Required for KNN search
                "similarity": "cosine" # Or "dot_product" / "l2_norm" based on model recommendation
            },
            # Optional: Add user ID if needed
            # "user_id": {"type": "keyword"},
            # Optional: Add timestamp
            "timestamp": {"type": "date"}
        }
    }

    # Create index if it doesn't exist (handle potential race conditions in production)
    try:
        if not es_client.indices.exists(index=ES_INDEX_NAME):
            logging.info(f"Creating index '{ES_INDEX_NAME}' with mapping...")
            es_client.indices.create(index=ES_INDEX_NAME, mappings=index_mapping, ignore=400) # ignore 400 if index already exists
        else:
             logging.info(f"Index '{ES_INDEX_NAME}' already exists.")
             # Optionally update mapping here if needed, but be careful with existing data
             # es_client.indices.put_mapping(index=ES_INDEX_NAME, properties=index_mapping["properties"])
    except Exception as e:
        logging.error(f"Error creating/checking index '{ES_INDEX_NAME}': {e}", exc_info=True)
        exit(1)


    # 6. Process Documents and Generate Bulk Actions
    all_actions = []
    file_count = 0
    total_chunks_processed = 0
    start_time = time.time()

    logging.info(f"Scanning documents in '{DOCS_FOLDER}' (including subdirectories)...")

    for file_path in docs_path.rglob('*'): # Use rglob for recursive search
        if file_path.is_file():
            file_name = file_path.name
            relative_path = file_path.relative_to(docs_path).parent # Get path relative to DOCS_FOLDER

            logging.info(f"Processing: {relative_path / file_name}")
            file_count += 1

            full_content_raw, content_type = get_file_content_and_type(file_path)

            if not full_content_raw or not content_type:
                logging.warning(f"  Skipping {file_name} due to read error or unsupported type.")
                continue

            # --- Prepare Full Content Field ---
            full_content_for_es = None
            text_for_chunking = ""

            if content_type == "pdf_base64":
                # Encode binary PDF content to base64 string
                full_content_for_es = base64.b64encode(full_content_raw).decode('utf-8')
                # Extract text from the binary content for chunking
                text_for_chunking = extract_text_from_pdf(full_content_raw, str(file_path))
            elif content_type == "text":
                # Use the extracted text directly
                full_content_for_es = full_content_raw
                text_for_chunking = full_content_raw
            else:
                 # Should not happen based on get_file_content_and_type logic, but handle defensively
                 logging.warning(f"  Internal error: Unexpected content_type '{content_type}' for {file_name}. Skipping.")
                 continue

            if not text_for_chunking or text_for_chunking.isspace():
                logging.warning(f"  No text available for chunking in {file_name}. Indexing document without chunks.")
                # Option: Index the document metadata only, or skip entirely?
                # For now, let's index metadata + full content but no chunks/vectors
                doc_id = f"file-{relative_path / file_name}-{file_path.stat().st_mtime}" # Unique ID based on path and mod time
                action = {
                    "_index": ES_INDEX_NAME,
                    "_id": doc_id,
                    "_source": {
                        "file_name": file_name,
                        "path": str(relative_path),
                        "content": full_content_for_es, # Store the full content
                        "content_type": content_type,
                        # "user_id": TARGET_USER_ID, # Optional
                        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                        "chunk_text": None, # Indicate no chunks
                        "chunk_vector": None
                    }
                }
                all_actions.append(action)
                continue # Move to next file


            # --- Chunk the text ---
            try:
                chunks = text_splitter.split_text(text_for_chunking)
                if not chunks:
                     logging.warning(f"  Text splitting resulted in zero chunks for {file_name}. Skipping chunk generation.")
                     # Consider indexing metadata only like above if desired
                     continue
                logging.info(f"  Split into {len(chunks)} chunks.")

            except Exception as e_split:
                 logging.error(f"  Error splitting text for {file_name}: {e_split}. Skipping file.")
                 continue


            # --- Embed chunks and create bulk actions ---
            chunks_embedded_count = 0
            for i, chunk in enumerate(chunks):
                 if not chunk or chunk.isspace():
                      logging.warning(f"  Skipping empty chunk {i+1} for {file_name}.")
                      continue
                 try:
                      # Generate embedding for the chunk
                      vector = embedding_model.encode(chunk).tolist()

                      # Create a unique ID for each chunk (e.g., file ID + chunk index)
                      chunk_id = f"chunk-{relative_path / file_name}-{file_path.stat().st_mtime}-{i}"

                      action = {
                          "_index": ES_INDEX_NAME,
                          "_id": chunk_id, # Use chunk-specific ID
                          "_source": {
                              "file_name": file_name,
                              "path": str(relative_path),
                              "content": full_content_for_es, # Include full original content in each chunk doc
                              "content_type": content_type,
                              "chunk_text": chunk, # The specific chunk text
                              "chunk_vector": vector, # The vector for this chunk
                              # "user_id": TARGET_USER_ID, # Optional
                              "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                          }
                      }
                      all_actions.append(action)
                      chunks_embedded_count += 1

                 except Exception as e_embed:
                      logging.error(f"  Error embedding chunk {i+1} of {file_name}: {e_embed}. Skipping chunk.")
                      # Decide if you want to skip the whole file on embedding error

            total_chunks_processed += chunks_embedded_count

            # --- Bulk Indexing in Batches ---
            if len(all_actions) >= 500: # Adjust batch size as needed (e.g., 100-1000)
                logging.info(f"Indexing batch of {len(all_actions)} actions...")
                try:
                    success, failed = bulk(
                        client=es_client.options(request_timeout=120), # Increase timeout for bulk
                        actions=all_actions,
                        raise_on_error=False,      # Don't raise error on individual doc failures
                        raise_on_exception=False,  # Don't raise Python exceptions during request
                        max_retries=2,             # Retry a couple of times on transient errors
                        initial_backoff=1,         # Start backoff at 1 second
                        max_backoff=5              # Max backoff 5 seconds
                    )
                    logging.info(f"  Batch Indexing: {success} succeeded.")
                    if failed:
                        logging.error(f"  Batch Indexing Failed Docs: {len(failed)}")
                        # Optionally log details of failed docs (up to a limit)
                        # for i, item in enumerate(failed):
                        #     if i < 5: logging.error(f"    Failed item {i+1}: {item}")
                        #     else: break
                    all_actions = [] # Clear batch
                except BulkIndexError as e_bulk:
                     logging.error(f"BULK INDEXING ERROR (stopping batch): Processed: {len(e_bulk.errors)} docs, Failed: {len(e_bulk.errors)}. First error: {e_bulk.errors[0] if e_bulk.errors else 'N/A'}")
                     # Decide: break, continue, maybe retry logic? For simplicity, we continue with next batch
                     all_actions = [] # Clear the failed batch
                except Exception as e_bulk_other:
                    logging.error(f"Unexpected error during bulk indexing batch: {e_bulk_other}", exc_info=True)
                    # Decide policy on unexpected errors
                    all_actions = [] # Clear batch


    # 7. Index any remaining actions
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
                 # Optionally log details
        except BulkIndexError as e_bulk:
            logging.error(f"FINAL BULK INDEXING ERROR: Processed: {len(e_bulk.errors)} docs, Failed: {len(e_bulk.errors)}. First error: {e_bulk.errors[0] if e_bulk.errors else 'N/A'}")
        except Exception as e_bulk_other:
            logging.error(f"Unexpected error during final bulk indexing: {e_bulk_other}", exc_info=True)

    end_time = time.time()
    logging.info("--- Document Indexing Script Finished ---")
    logging.info(f"Processed {file_count} files found in '{DOCS_FOLDER}'.")
    logging.info(f"Generated and attempted to index {total_chunks_processed} chunks.")
    logging.info(f"Total time: {end_time - start_time:.2f} seconds.")
