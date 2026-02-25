# Scorched Earth

Turn-based 2-player browser artillery game built with TypeScript, Vite, and Socket.IO.

## Workspace

- `apps/client`: Vite browser client with Canvas 2D renderer
- `apps/server`: Node.js authoritative game server
- `packages/shared`: Shared protocol and game types

## Run locally

1. Install dependencies:
   - `npm install`
2. Start both server and client:
   - `npm run dev`
3. Open two browser tabs at `http://localhost:5173`, create room in first tab, join via room code in second tab.

## Docker deployment

Build and run:

1. Build image:
   - `docker build -t scorched-earth:latest .`
2. Run container:
   - `docker run --rm -p 3001:3001 scorched-earth:latest`
3. Open:
   - `http://localhost:3001`

The container serves both the API/WebSocket server and the built client from one process.
Health endpoint: `GET /health`.

## Gameplay (v1)

- 2 players only, room code matchmaking
- Turn-based aiming/firing (30s turn timer)
- Wind + gravity projectile physics
- Destructible terrain (heightmap craters)
- Health-based damage and win condition
- 30s reconnect grace pause before forfeit
- Rematch voting (both players must accept)
