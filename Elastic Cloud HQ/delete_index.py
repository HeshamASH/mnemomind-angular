# WARNING: this script deletes all the files that was indexed in the given elastic cloud

import os
import logging
from pathlib import Path
from dotenv import load_dotenv
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk
from sentence_transformers import SentenceTransformer
from langchain.text_splitter import RecursiveCharacterTextSplitter
import PyPDF2
import docx
import time

# --- Configuration ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Constants ---
ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ES_INDEX_NAME = "rag_documents" # Make sure this matches your app config
EMBEDDING_MODEL_NAME = 'sentence-transformers/all-MiniLM-L6-v2'
EMBEDDING_DIM = 384
DOCS_FOLDER = "./fixed_documents" # Folder containing your files
TARGET_USER_ID = os.getenv("PRELOAD_USER_ID", "preloaded_general_docs")

# --- Helper Functions ---
def parse_pdf(file_path: str) -> str:
    text = ""
    try:
        with open(file_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            if reader.is_encrypted:
                try:
                    reader.decrypt('') # Try empty password
                except Exception:
                    logging.warning(f"Skipping encrypted PDF (password needed): {file_path}")
                    return ""
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
    except Exception as e:
        logging.error(f"Error parsing PDF {Path(file_path).name}: {e}", exc_info=True)
    return text

def parse_docx(file_path: str) -> str:
    text = ""
    try:
        doc = docx.Document(file_path)
        for para in doc.paragraphs:
            text += para.text + "\n"
    except Exception as e:
        logging.error(f"Error parsing DOCX {Path(file_path).name}: {e}", exc_info=True)
    return text

def parse_text_file(file_path: str) -> str:
    """Reads content from a plain text file (UTF-8 encoding)."""
    text = ""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        logging.error(f"Error parsing text/markdown file {Path(file_path).name}: {e}", exc_info=True)
    return text


# --- Main Execution ---
if __name__ == "__main__":
    logging.info("--- Starting Pre-loading Script ---")

    if not ELASTIC_CLOUD_ID or not ELASTIC_API_KEY:
        logging.error("Elastic Cloud ID or API Key not found in .env file. Exiting.")
        exit(1)

    docs_path = Path(DOCS_FOLDER)
    if not docs_path.is_dir():
        logging.error(f"Documents folder '{DOCS_FOLDER}' not found. Exiting.")
        exit(1)

    # 1. Connect to Elasticsearch
    logging.info("Connecting to Elastic Cloud...")
    try:
        es_client = Elasticsearch(
            cloud_id=ELASTIC_CLOUD_ID,
            api_key=ELASTIC_API_KEY,
            request_timeout=60 # Default timeout for general client actions
        )
        if not es_client.ping():
             raise ConnectionError("Ping failed.")
        logging.info("Connected to Elastic Cloud successfully.")
    except Exception as e:
        logging.error(f"Failed to connect to Elastic Cloud: {e}", exc_info=True)
        exit(1)

    # 2. Load Embedding Model
    logging.info(f"Loading embedding model: {EMBEDDING_MODEL_NAME}...")
    try:
        embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
        logging.info("Embedding model loaded.")
    except Exception as e:
        logging.error(f"Failed to load embedding model: {e}", exc_info=True)
        exit(1)

    # 3. Initialize Text Splitter
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=150,
        length_function=len,
    )

    # 4. Process Documents in the Folder
    all_actions = []
    file_count = 0
    total_chunks = 0
    start_time = time.time()

    logging.info(f"Scanning documents in '{DOCS_FOLDER}'...")
    supported_suffixes = {".pdf", ".docx", ".txt", ".md"}

    for file_path in docs_path.rglob('*'): # Use rglob to search subdirectories too
        if file_path.is_file() and file_path.suffix.lower() in supported_suffixes:
            file_name = file_path.name
            logging.info(f"Processing file: {file_name}")
            file_count += 1
            text = ""
            file_suffix = file_path.suffix.lower()

            # --- Parsing Logic ---
            if file_suffix == ".pdf":
                text = parse_pdf(str(file_path))
            elif file_suffix == ".docx":
                text = parse_docx(str(file_path))
            elif file_suffix == ".txt" or file_suffix == ".md":
                text = parse_text_file(str(file_path))
            else:
                logging.warning(f"Skipping unsupported file type: {file_name}")
                continue

            if not text or text.isspace():
                logging.warning(f"No text extracted from {file_name}. Skipping.")
                continue

            # Chunk the text
            chunks = text_splitter.split_text(text)
            if not chunks:
                 logging.warning(f"No chunks generated for {file_name}. Skipping.")
                 continue

            logging.info(f"  Split into {len(chunks)} chunks.")
            total_chunks += len(chunks)

            # Embed and create bulk actions
            for i, chunk in enumerate(chunks):
                 if not chunk or chunk.isspace(): continue
                 try:
                      vector = embedding_model.encode(chunk).tolist()
                      doc = {
                          "_index": ES_INDEX_NAME,
                          "_source": {
                              "user_id": TARGET_USER_ID,
                              "file_name": file_name,
                              "chunk_text": chunk,
                              "chunk_vector": vector
                          }
                      }
                      all_actions.append(doc)
                 except Exception as e_embed:
                      logging.error(f"Error embedding chunk {i+1} of {file_name}: {e_embed}")

            # Optional: Buffer for bulk indexing
            if len(all_actions) >= 1000:
                logging.info(f"Indexing batch of {len(all_actions)} actions...")
                try:
                    # --- FIX APPLIED HERE for batch ---
                    success, failed = bulk(
                        client=es_client.options(request_timeout=120), # Set timeout via options()
                        actions=all_actions,
                        raise_on_error=False,
                        raise_on_exception=False
                    )
                    # ------------------------------------
                    logging.info(f"  Batch Indexing: {success} succeeded.")
                    if failed:
                        logging.error(f"  Batch Indexing Failed Docs: {len(failed)}")
                    all_actions = [] # Clear batch
                except Exception as e_bulk:
                    logging.error(f"Error during bulk indexing batch: {e_bulk}", exc_info=True)
                    # Decide policy on error (stop? continue?)

    # 5. Index remaining actions
    if all_actions:
        logging.info(f"Indexing final batch of {len(all_actions)} actions...")
        try:
             # --- FIX APPLIED HERE for final batch ---
             success, failed = bulk(
                 client=es_client.options(request_timeout=120), # Set timeout via options()
                 actions=all_actions,
                 raise_on_error=False,
                 raise_on_exception=False
             )
             # ---------------------------------------
             logging.info(f"  Final Batch Indexing: {success} succeeded.")
             if failed:
                 logging.error(f"  Final Batch Indexing Failed Docs: {len(failed)}")
        except Exception as e_bulk:
            logging.error(f"Error during final bulk indexing batch: {e_bulk}", exc_info=True)

    end_time = time.time()
    logging.info("--- Pre-loading Script Finished ---")
    logging.info(f"Processed {file_count} files.")
    logging.info(f"Generated and attempted to index {total_chunks} chunks.")
    logging.info(f"Total time: {end_time - start_time:.2f} seconds.")