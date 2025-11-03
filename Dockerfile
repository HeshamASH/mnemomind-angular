# Stage 1: Build the Angular frontend
FROM node:20 AS builder
WORKDIR /app
RUN npm install -g npm@latest
COPY package.json package-lock.json ./
RUN npm install
RUN npm audit fix
COPY . .
RUN npm run build

# Stage 2: Run the Python backend
FROM python:3.11-slim

RUN addgroup --system nonroot && adduser --system --ingroup nonroot --home /home/nonroot nonroot

WORKDIR /app

COPY --from=builder /app/dist/frontend-ng /app/static
COPY api/requirements.txt .
COPY api /app/api

RUN chown -R nonroot:nonroot /app

USER nonroot
ENV HOME=/home/nonroot
ENV PATH=$HOME/.local/bin:$PATH

RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

WORKDIR /app/api

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
