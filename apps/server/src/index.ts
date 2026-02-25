import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@scorched-earth/shared";
import { lockAimSchema, joinRoomSchema, rejoinRoomSchema } from "./validation.js";
import { RoomManager } from "./room-manager.js";

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

const httpServer = createServer((_, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: [CLIENT_ORIGIN],
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
