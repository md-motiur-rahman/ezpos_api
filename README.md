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