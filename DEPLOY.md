# Deploy To VPS

This project can be deployed from this Windows folder to your VPS with `deploy.ps1`.

## One-Time VPS Setup

Run these commands on the VPS first:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo mkdir -p /opt/proxy
```

If your VPS uses a firewall, open the app port:

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

## One-Time Local Setup

From PowerShell in this project folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Make sure `.env` has your real values:

```txt
API_URL=your_api_url
CLIENT_ID=your_client_id
PORT=3000
NODE_ENV=production
WS_PUSH_INTERVAL_MS=5000
```

## Deploy Command

From this folder on your PC:

```powershell
.\deploy.ps1 -VpsHost 82.29.155.252 -VpsUser root -RemoteDir /opt/proxy
```

The script will:

1. Show changed git files.
2. Run `node --check server.js`.
3. Run `node --check Routes\realtime.js`.
4. Run `docker compose config`.
5. Create `proxy-deploy.tar.gz`.
6. Upload it to the VPS.
7. Rebuild and restart Docker Compose on the VPS.
8. Show the live HTTP and websocket endpoints.

## Deploy Without Copying `.env`

Use this if `.env` is already on the VPS and you do not want to upload it again:

```powershell
.\deploy.ps1 -VpsHost 82.29.155.252 -VpsUser root -RemoteDir /opt/proxy -SkipEnv
```

## Useful VPS Commands

Check containers:

```bash
cd /opt/proxy
docker compose ps
```

View logs:

```bash
cd /opt/proxy
docker compose logs -f
```

Restart:

```bash
cd /opt/proxy
docker compose restart
```

Rebuild manually:

```bash
cd /opt/proxy
docker compose up -d --build
```

## Live Endpoints

Replace `82.29.155.252` with your domain if one is pointed to the VPS.

```txt
http://82.29.155.252:3000/realtime/{matchId}
http://82.29.155.252:3000/tablestandings/{matchId}

ws://82.29.155.252:3000/ws/realtime/{matchId}
ws://82.29.155.252:3000/ws/tablestandings/{matchId}
```
