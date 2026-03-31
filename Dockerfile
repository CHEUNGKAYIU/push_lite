# syntax=docker/dockerfile:1

FROM node:18-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:18-slim AS runtime
WORKDIR /app/backend

# Optional channel support for keys starting with "apprise " / "apprise:raw "
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir apprise \
    && ln -s /opt/apprise-venv/bin/apprise /usr/local/bin/apprise \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY --from=frontend-builder /app/frontend/dist ./build

EXPOSE 8000
CMD ["node", "app.js"]
