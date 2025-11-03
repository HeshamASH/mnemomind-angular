# MnemoMind Workflow

This document explains the workflow of the MnemoMind RAG-based AI application.

## 1. User Input and Intent Classification

- The user enters a query.
- A **Router LLM** classifies the user's intent into one of the following categories:
    - **Chit-chat:** For conversational queries.
    - **Document Query:** For questions that require information from the provided documents.
    - **Code Generation:** For requests to write or modify code.

## 2. Document Query Workflow

- If the intent is a document query, a **Rewriter LLM** refines the user's query into a more effective search query.
- The rewritten query is used to perform a hybrid search on an **Elasticsearch** database, combining keyword and vector search for optimal results.
- The retrieved document chunks are then passed to a **Summarizer API** to create a concise summary of the relevant information.
- Finally, the user-selected **Main Brain LLM** generates a comprehensive answer based on the summarized context.

## 3. Code Generation Workflow

- If the intent is code generation, the system searches the codebase for relevant files.
- The user-selected **Main Brain LLM** generates code suggestions based on the user's request and the content of the relevant files.

## 4. Chit-Chat Workflow

- If the intent is chit-chat, the user-selected **Main Brain LLM** generates a conversational response.
