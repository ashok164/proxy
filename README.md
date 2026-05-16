# VPS Proxy Server

A Node.js Express proxy server that forwards requests to an external API with custom headers.

## Prerequisites

- Docker & Docker Compose (for containerized deployment)
- Node.js 20+ (for local development)

## Quick Start with Docker

### 1. Setup Environment Variables

Copy `.env.example` to `.env` and update with your values:

```bash
cp .env.example .env
```

Edit `.env` with your API configuration:
```
API_URL=https://your-api-endpoint.com
CLIENT_ID=your_client_id
SHEET_URL=https://your-google-sheet-csv-url
PORT=3000
WS_PUSH_INTERVAL_MS=5000
```

### 2. Build and Run with Docker Compose

```bash
docker-compose up --build
```

The server will be available at `http://localhost:3000`

### 3. Access the Proxy

- Health check: `http://localhost:3000/`
- Forward request: `http://localhost:3000/realtime/{matchId}`
- Table standings: `http://localhost:3000/tablestandings/{matchId}`
- Realtime websocket: `ws://localhost:3000/ws/realtime/{matchId}`
- Table standings websocket: `ws://localhost:3000/ws/tablestandings/{matchId}`

## Docker Commands

### Build the image
```bash
docker build -t proxy-server .
```

### Run the container
```bash
docker run -p 3000:3000 \
  -e API_URL=https://your-api-endpoint.com \
  -e CLIENT_ID=your_client_id \
  -e SHEET_URL=https://your-google-sheet-csv-url \
  -e WS_PUSH_INTERVAL_MS=5000 \
  proxy-server
```

### Stop the container
```bash
docker-compose down
```

### View logs
```bash
docker-compose logs -f
```

## Local Development

### Install dependencies
```bash
npm install
```

### Run locally
```bash
npm start
```

## Environment Variables

| Variable  | Description | Default |
|-----------|-------------|---------|
| API_URL   | External API endpoint URL | Required |
| CLIENT_ID | Authentication Client ID | Required |
| SHEET_URL | Published Google Sheet CSV URL for team metadata | Optional |
| PORT      | Server port | 3000 |
| NODE_ENV  | Environment mode | production |
| WS_PUSH_INTERVAL_MS | Websocket push interval in milliseconds | 5000 |

## Architecture

- **Base Image**: Node.js 20 Alpine (lightweight)
- **Port**: 3000 (inside container), mapped to 3000 (on host)
- **Health Check**: Enabled with 30s intervals
- **Restart Policy**: Auto-restart on failure
