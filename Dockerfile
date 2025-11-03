# Stage 1: Build the Angular frontend
FROM node:20 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Run the Python backend
FROM python:3.11-slim
WORKDIR /app
COPY --from=builder /app/dist/frontend-ng /app/static
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api /app/api
WORKDIR /app/api
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
