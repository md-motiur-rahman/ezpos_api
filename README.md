# POS API

Backend API for the Enterprise POS System.

## Status

🚧 Under active module-by-module development. See `/docs` (added later) for the full module breakdown.

## Requirements

- Node.js >= 20

## Setup

1. Install dependencies:
```bash
   npm install
```

2. Copy the example env file and fill in values:
```bash
   cp .env.example .env.development
```

3. Run in development (auto-restarts on file changes):
```bash
   npm run dev
```

4. Verify it's running:
```bash
   curl http://localhost:4000/health
```

## Project structure


## Local Postgres (Docker)

This project's local dev database runs in Docker, mapped to **port 5433** on the host
(not the default 5432) to avoid clashing with any native Postgres install on your machine:

```bash
docker run --name epos-db \
  -e POSTGRES_PASSWORD=yourpassword \
  -e POSTGRES_DB=ezpos-db \
  -p 5433:5432 \
  -d postgres:16
```

Because of that mapping, **`DATABASE_URL` in both `.env.development` and `.env.test` must use port 5433**, e.g.: