import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { Server, type Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@scorched-earth/shared";
import { lockAimSchema, joinRoomSchema, rejoinRoomSchema } from "./validation.js";
import { RoomManager } from "./room-manager.js";

const PORT = Number(process.env.PORT ?? 3001);
const STATIC_ROOT = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173,http://localhost:3001")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function contentTypeFor(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

async function serveFile(
  filePath: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  createReadStream(filePath).on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end("Internal Server Error");
  }).pipe(res);
  return true;
}

async function tryServeStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!STATIC_ROOT || !existsSync(STATIC_ROOT)) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const rawPath = req.url ?? "/";
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawPath, "http://localhost").pathname);
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }

  if (pathname.startsWith("/socket.io") || pathname === "/health") {
    return false;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = normalize(requestedPath);
  const fullPath = resolve(STATIC_ROOT, `.${normalizedPath}`);
  const rel = relative(STATIC_ROOT, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  if (await serveFile(fullPath, req, res)) {
    return true;
  }

  if (!extname(requestedPath)) {
    const indexPath = resolve(STATIC_ROOT, "index.html");
    return serveFile(indexPath, req, res);
  }

  return false;
}

const httpServer = createServer(async (req, res) => {
  if (await tryServeStatic(req, res)) {
    return;
  }

  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/health" || (path === "/" && !STATIC_ROOT)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Not Found" }));
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: CLIENT_ORIGINS,
    credentials: true
  }
});

const roomManager = new RoomManager(io);

function emitError(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  code: string,
  message: string
): void {
  socket.emit("error_event", { code, message });
}

io.on("connection", (socket) => {
  socket.on("create_room", () => {
    const result = roomManager.createRoom(socket);

    socket.emit("room_created", {
      roomCode: result.room.code,
      slot: result.slot,
      reconnectToken: result.reconnectToken
    });

    socket.emit("room_joined", {
      roomCode: result.room.code,
      slot: result.slot,
      players: roomManager.getPlayers(result.room),
      reconnectToken: result.reconnectToken
    });
  });

  socket.on("join_room", (rawPayload) => {
    const parsed = joinRoomSchema.safeParse(rawPayload);
    if (!parsed.success) {
      emitError(socket, "INVALID_JOIN_PAYLOAD", "Invalid room join payload.");
      return;
    }

    const result = roomManager.joinRoom(
      socket,
      parsed.data.roomCode,
      parsed.data.reconnectToken
    );

    if (!result) {
      emitError(socket, "ROOM_UNAVAILABLE", "Room not found, full, or reconnect token invalid.");
      return;
    }

    socket.emit("room_joined", {
      roomCode: result.room.code,
      slot: result.slot,
      players: roomManager.getPlayers(result.room),
      reconnectToken: result.reconnectToken
    });

    io.to(result.room.code).emit("state_snapshot", {
      state: result.room.state,
      serverTime: Date.now()
    });
  });

  socket.on("rejoin_room", (rawPayload) => {
    const parsed = rejoinRoomSchema.safeParse(rawPayload);
    if (!parsed.success) {
      emitError(socket, "INVALID_REJOIN_PAYLOAD", "Invalid rejoin payload.");
      return;
    }

    const result = roomManager.rejoinRoom(
      socket,
      parsed.data.roomCode,
      parsed.data.reconnectToken
    );

    if (!result) {
      emitError(socket, "REJOIN_FAILED", "Could not restore your player slot.");
      return;
    }

    socket.emit("room_joined", {
      roomCode: result.room.code,
      slot: result.slot,
      players: roomManager.getPlayers(result.room),
      reconnectToken: result.reconnectToken
    });
  });

  socket.on("lock_aim", (rawPayload) => {
    const parsed = lockAimSchema.safeParse(rawPayload);
    if (!parsed.success) {
      emitError(socket, "INVALID_AIM_PAYLOAD", "Invalid aiming values.");
      return;
    }

    const room = roomManager.applyAim(socket.id, parsed.data.angleDeg, parsed.data.power);
    if (!room) {
      emitError(socket, "AIM_REJECTED", "Cannot aim right now.");
    }
  });

  socket.on("fire", () => {
    const room = roomManager.fire(socket.id);
    if (!room) {
      emitError(socket, "FIRE_REJECTED", "Cannot fire right now.");
    }
  });

  socket.on("request_rematch", () => {
    const errorCode = roomManager.requestRematch(socket.id);
    if (!errorCode) {
      return;
    }

    const messageByCode: Record<string, string> = {
      NOT_IN_ROOM: "You are not currently in a room.",
      ROOM_UNAVAILABLE: "Room is unavailable.",
      REMATCH_NOT_AVAILABLE: "Rematch is only available after a match ends.",
      PLAYER_NOT_CONNECTED: "You must be connected to request a rematch."
    };

    emitError(
      socket,
      errorCode,
      messageByCode[errorCode] ?? "Unable to process rematch request."
    );
  });

  socket.on("ping", (sentAt) => {
    socket.emit("pong", sentAt);
  });

  socket.on("leave_room", () => {
    roomManager.leaveExplicit(socket.id);
  });

  socket.on("disconnect", () => {
    roomManager.leaveBySocketId(socket.id);
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`scorched-earth server listening on http://localhost:${PORT}`);
});
