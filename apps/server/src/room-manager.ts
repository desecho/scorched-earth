import {
  RECONNECT_GRACE_MS,
  TICK_RATE,
  TURN_DURATION_MS,
  type GamePhase,
  type GameState,
  type PlayerSlot,
  type RoomCode,
  type Vector2
} from "@scorched-earth/shared";
import { Server, type Socket } from "socket.io";
import {
  applyBlastDamage,
  clampAngle,
  clampPower,
  createInitialState,
  deformTerrain,
  enterTurn,
  oppositeSlot,
  pickWind,
  resolveWinner,
  setPhase,
  spawnProjectile,
  stepProjectile,
  updateTankGrounding
} from "./game.js";
import { mulberry32, randomCode, randomToken } from "./random.js";

interface RoomPlayer {
  slot: PlayerSlot;
  token: string;
  socketId: string | null;
  connected: boolean;
}

interface PauseSnapshot {
  phaseBeforePause: GamePhase;
  remainingTurnMs: number | null;
}

interface Room {
  code: RoomCode;
  seed: number;
  random: () => number;
  nextStartingSlot: PlayerSlot;
  state: GameState;
  players: Record<PlayerSlot, RoomPlayer | null>;
  rematchVotes: Set<PlayerSlot>;
  turnTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  simulationTimer: NodeJS.Timeout | null;
  pauseSnapshot: PauseSnapshot | null;
  createdAt: number;
}

interface SocketBinding {
  roomCode: RoomCode;
  slot: PlayerSlot;
}

interface JoinResult {
  room: Room;
  slot: PlayerSlot;
  reconnectToken: string;
  started: boolean;
}

const TURN_TICK_MS = Math.round(1000 / TICK_RATE);

export class RoomManager {
  private readonly rooms = new Map<RoomCode, Room>();
  private readonly socketBindings = new Map<string, SocketBinding>();
  private readonly random = mulberry32(Date.now());

  constructor(private readonly io: Server) {}

  createRoom(socket: Socket): JoinResult {
    this.detachSocket(socket);

    const code = this.createUniqueCode();
    const seed = Math.floor(this.random() * 1_000_000_000);
    const roomRandom = mulberry32(seed);
    const room: Room = {
      code,
      seed,
      random: roomRandom,
      nextStartingSlot: "A",
      state: createInitialState(code, seed, "A"),
      players: { A: null, B: null },
      rematchVotes: new Set<PlayerSlot>(),
      turnTimer: null,
      reconnectTimer: null,
      simulationTimer: null,
      pauseSnapshot: null,
      createdAt: Date.now()
    };

    const token = randomToken(roomRandom);
    room.players.A = {
      slot: "A",
      token,
      socketId: socket.id,
      connected: true
    };

    this.rooms.set(code, room);
    this.socketBindings.set(socket.id, { roomCode: code, slot: "A" });
    room.state.tanks.A.connected = true;

    socket.join(code);

    return { room, slot: "A", reconnectToken: token, started: false };
  }

  joinRoom(socket: Socket, roomCode: string, reconnectToken?: string): JoinResult | null {
    this.detachSocket(socket);

    const room = this.rooms.get(roomCode);
    if (!room) {
      return null;
    }

    // Reclaim a slot via reconnect token.
    if (reconnectToken) {
      for (const slot of ["A", "B"] as const) {
        const player = room.players[slot];
        if (player && player.token === reconnectToken) {
          player.socketId = socket.id;
          player.connected = true;
          room.state.tanks[slot].connected = true;
          this.socketBindings.set(socket.id, { roomCode, slot });
          socket.join(roomCode);
          this.broadcastPlayerReconnected(room, slot);
          this.resumeFromPauseIfReady(room);
          if (room.state.phase === "match_end") {
            this.broadcastRematchUpdated(room, null);
          }
          this.broadcastSnapshot(room);
          return { room, slot, reconnectToken: player.token, started: false };
        }
      }
    }

    const slotToAssign = room.players.A ? (room.players.B ? null : "B") : "A";
    if (!slotToAssign) {
      return null;
    }

    const token = randomToken(room.random);
    room.players[slotToAssign] = {
      slot: slotToAssign,
      token,
      socketId: socket.id,
      connected: true
    };

    room.state.tanks[slotToAssign].connected = true;
    this.socketBindings.set(socket.id, { roomCode, slot: slotToAssign });
    socket.join(roomCode);

    const shouldStart = Boolean(room.players.A && room.players.B && room.state.phase === "lobby");
    if (shouldStart) {
      this.startMatch(room);
    }

    return { room, slot: slotToAssign, reconnectToken: token, started: shouldStart };
  }

  rejoinRoom(socket: Socket, roomCode: string, reconnectToken: string): JoinResult | null {
    return this.joinRoom(socket, roomCode, reconnectToken);
  }

  leaveBySocketId(socketId: string): void {
    const binding = this.socketBindings.get(socketId);
    if (!binding) {
      return;
    }

    this.socketBindings.delete(socketId);
    const room = this.rooms.get(binding.roomCode);
    if (!room) {
      return;
    }

    const player = room.players[binding.slot];
    if (!player || player.socketId !== socketId) {
      return;
    }

    player.socketId = null;
    player.connected = false;
    room.state.tanks[binding.slot].connected = false;

    if (room.state.phase === "lobby") {
      this.destroyRoomIfEmpty(room);
      return;
    }

    if (room.state.phase === "match_end") {
      room.rematchVotes.delete(binding.slot);
      this.broadcastRematchUpdated(room, null);
      this.destroyRoomIfEmpty(room);
      return;
    }

    this.pauseForReconnect(room, binding.slot);
  }

  leaveExplicit(socketId: string): void {
    this.leaveBySocketId(socketId);
  }

  applyAim(socketId: string, angleDeg: number, power: number): Room | null {
    const info = this.socketBindings.get(socketId);
    if (!info) {
      return null;
    }

    const room = this.rooms.get(info.roomCode);
    if (!room) {
      return null;
    }

    if (room.state.phase !== "aiming") {
      return null;
    }

    if (room.state.activeSlot !== info.slot) {
      return null;
    }

    room.state.tanks[info.slot].angleDeg = clampAngle(angleDeg);
    room.state.tanks[info.slot].power = clampPower(power);
    this.broadcastSnapshot(room);
    return room;
  }

  fire(socketId: string): Room | null {
    const info = this.socketBindings.get(socketId);
    if (!info) {
      return null;
    }

    const room = this.rooms.get(info.roomCode);
    if (!room) {
      return null;
    }

    if (room.state.phase !== "aiming" || room.state.activeSlot !== info.slot) {
      return null;
    }

    this.fireForSlot(room, info.slot);
    return room;
  }

  requestRematch(socketId: string): string | null {
    const info = this.socketBindings.get(socketId);
    if (!info) {
      return "NOT_IN_ROOM";
    }

    const room = this.rooms.get(info.roomCode);
    if (!room) {
      return "ROOM_UNAVAILABLE";
    }

    if (room.state.phase !== "match_end") {
      return "REMATCH_NOT_AVAILABLE";
    }

    const player = room.players[info.slot];
    if (!player || !player.connected) {
      return "PLAYER_NOT_CONNECTED";
    }

    room.rematchVotes.add(info.slot);
    this.broadcastRematchUpdated(room, info.slot);

    const hasBothPlayers = Boolean(room.players.A && room.players.B);
    const bothConnected = Boolean(room.players.A?.connected && room.players.B?.connected);
    const bothAccepted = room.rematchVotes.has("A") && room.rematchVotes.has("B");

    if (hasBothPlayers && bothConnected && bothAccepted) {
      this.startMatch(room);
    }

    return null;
  }

  getPlayers(room: Room): { slot: PlayerSlot; connected: boolean }[] {
    const players: { slot: PlayerSlot; connected: boolean }[] = [];
    for (const slot of ["A", "B"] as const) {
      const player = room.players[slot];
      if (player) {
        players.push({ slot, connected: player.connected });
      }
    }
    return players;
  }

  getSlotBySocketId(socketId: string): PlayerSlot | null {
    return this.socketBindings.get(socketId)?.slot ?? null;
  }

  getRoomBySocketId(socketId: string): Room | null {
    const info = this.socketBindings.get(socketId);
    if (!info) {
      return null;
    }
    return this.rooms.get(info.roomCode) ?? null;
  }

  private detachSocket(socket: Socket): void {
    this.leaveBySocketId(socket.id);
  }

  private createUniqueCode(): string {
    for (let i = 0; i < 1000; i += 1) {
      const code = randomCode(this.random);
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    return `${Math.floor(this.random() * 99999)}`.padStart(5, "0");
  }

  private startMatch(room: Room): void {
    const startingSlot = room.nextStartingSlot;
    room.nextStartingSlot = oppositeSlot(room.nextStartingSlot);
    room.seed = Math.floor(room.random() * 1_000_000_000);
    room.state = createInitialState(room.code, room.seed, startingSlot);
    room.rematchVotes.clear();
    room.pauseSnapshot = null;
    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
      room.reconnectTimer = null;
    }
    this.syncTankConnections(room);
    enterTurn(room.state, startingSlot, pickWind(room.random));
    this.clearTurnTimer(room);
    this.clearSimulation(room);

    this.io.to(room.code).emit("game_started", {
      seed: room.seed,
      initialState: room.state
    });

    this.io.to(room.code).emit("turn_started", {
      activeSlot: room.state.activeSlot,
      turnEndsAt: room.state.turnEndsAt
    });

    this.broadcastSnapshot(room);
    this.scheduleTurnTimeout(room);
  }

  private scheduleTurnTimeout(room: Room): void {
    this.clearTurnTimer(room);
    if (room.state.phase !== "aiming" || room.state.turnEndsAt === null) {
      return;
    }

    const remaining = Math.max(0, room.state.turnEndsAt - Date.now());
    room.turnTimer = setTimeout(() => {
      if (room.state.phase !== "aiming") {
        return;
      }
      this.fireForSlot(room, room.state.activeSlot);
    }, remaining);
  }

  private fireForSlot(room: Room, slot: PlayerSlot): void {
    if (room.state.phase !== "aiming") {
      return;
    }

    this.clearTurnTimer(room);
    setPhase(room.state, "projectile_flight");
    spawnProjectile(room.state, slot);

    if (room.state.projectile) {
      this.io.to(room.code).emit("projectile_spawned", {
        projectile: room.state.projectile
      });
    }

    this.broadcastSnapshot(room);

    this.clearSimulation(room);
    room.simulationTimer = setInterval(() => {
      const impact = stepProjectile(room.state, 1 / TICK_RATE);
      this.broadcastSnapshot(room);
      if (impact) {
        this.resolveImpact(room, impact.point);
      }
    }, TURN_TICK_MS);
  }

  private resolveImpact(room: Room, point: Vector2): void {
    this.clearSimulation(room);

    const shooter = room.state.projectile?.owner ?? room.state.activeSlot;
    room.state.projectile = null;

    deformTerrain(room.state, point);
    updateTankGrounding(room.state);
    const damage = applyBlastDamage(room.state, point);

    this.io.to(room.code).emit("terrain_updated", {
      heights: room.state.terrain.heights
    });

    for (const entry of damage) {
      this.io.to(room.code).emit("damage_applied", entry);
    }

    const winner = resolveWinner(room.state, shooter);
    if (winner) {
      room.state.phase = "match_end";
      room.state.winnerSlot = winner;
      room.state.turnEndsAt = null;
      room.rematchVotes.clear();
      this.io.to(room.code).emit("match_ended", { winnerSlot: winner });
      this.broadcastRematchUpdated(room, null);
      this.broadcastSnapshot(room);
      return;
    }

    setPhase(room.state, "round_end");
    this.broadcastSnapshot(room);

    setTimeout(() => {
      if (room.state.phase === "paused_reconnect" || room.state.phase === "match_end") {
        return;
      }
      const next = oppositeSlot(room.state.activeSlot);
      enterTurn(room.state, next, pickWind(room.random));
      this.io.to(room.code).emit("turn_started", {
        activeSlot: room.state.activeSlot,
        turnEndsAt: room.state.turnEndsAt ?? Date.now() + TURN_DURATION_MS
      });
      this.broadcastSnapshot(room);
      this.scheduleTurnTimeout(room);
    }, 650);
  }

  private pauseForReconnect(room: Room, disconnectedSlot: PlayerSlot): void {
    if (room.state.phase === "paused_reconnect" || room.state.phase === "match_end") {
      return;
    }

    const remainingTurnMs =
      room.state.phase === "aiming" && room.state.turnEndsAt !== null
        ? Math.max(0, room.state.turnEndsAt - Date.now())
        : null;

    room.pauseSnapshot = {
      phaseBeforePause: room.state.phase,
      remainingTurnMs
    };

    this.clearTurnTimer(room);
    this.clearSimulation(room);

    room.state.phase = "paused_reconnect";
    room.state.turnEndsAt = null;

    const reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    this.io.to(room.code).emit("player_disconnected", {
      slot: disconnectedSlot,
      reconnectDeadline
    });
    this.broadcastSnapshot(room);

    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
    }

    room.reconnectTimer = setTimeout(() => {
      if (room.state.phase !== "paused_reconnect") {
        return;
      }
      const disconnected = this.findDisconnectedSlot(room);
      if (!disconnected) {
        return;
      }
      const winner = oppositeSlot(disconnected);
      room.state.phase = "match_end";
      room.state.winnerSlot = winner;
      room.rematchVotes.clear();
      this.io.to(room.code).emit("match_ended", { winnerSlot: winner });
      this.broadcastRematchUpdated(room, null);
      this.broadcastSnapshot(room);
    }, RECONNECT_GRACE_MS);
  }

  private resumeFromPauseIfReady(room: Room): void {
    if (room.state.phase !== "paused_reconnect") {
      return;
    }

    const disconnected = this.findDisconnectedSlot(room);
    if (disconnected) {
      return;
    }

    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
      room.reconnectTimer = null;
    }

    const snapshot = room.pauseSnapshot;
    room.pauseSnapshot = null;

    if (!snapshot) {
      room.state.phase = "aiming";
      if (room.state.turnEndsAt === null) {
        room.state.turnEndsAt = Date.now() + TURN_DURATION_MS;
      }
      this.scheduleTurnTimeout(room);
      this.broadcastSnapshot(room);
      return;
    }

    room.state.phase = snapshot.phaseBeforePause;

    if (snapshot.phaseBeforePause === "aiming") {
      const remaining = snapshot.remainingTurnMs ?? TURN_DURATION_MS;
      room.state.turnEndsAt = Date.now() + remaining;
      this.scheduleTurnTimeout(room);
      this.io.to(room.code).emit("turn_started", {
        activeSlot: room.state.activeSlot,
        turnEndsAt: room.state.turnEndsAt
      });
    }

    if (snapshot.phaseBeforePause === "projectile_flight") {
      this.clearSimulation(room);
      room.simulationTimer = setInterval(() => {
        const impact = stepProjectile(room.state, 1 / TICK_RATE);
        this.broadcastSnapshot(room);
        if (impact) {
          this.resolveImpact(room, impact.point);
        }
      }, TURN_TICK_MS);
    }

    if (snapshot.phaseBeforePause === "round_end") {
      const next = oppositeSlot(room.state.activeSlot);
      enterTurn(room.state, next, pickWind(room.random));
      this.io.to(room.code).emit("turn_started", {
        activeSlot: room.state.activeSlot,
        turnEndsAt: room.state.turnEndsAt ?? Date.now() + TURN_DURATION_MS
      });
      this.scheduleTurnTimeout(room);
    }

    this.broadcastSnapshot(room);
  }

  private broadcastPlayerReconnected(room: Room, slot: PlayerSlot): void {
    this.io.to(room.code).emit("player_reconnected", { slot });
  }

  private broadcastRematchUpdated(room: Room, requestedBy: PlayerSlot | null): void {
    this.io.to(room.code).emit("rematch_updated", {
      requestedBy,
      requestedSlots: [...room.rematchVotes]
    });
  }

  private syncTankConnections(room: Room): void {
    for (const slot of ["A", "B"] as const) {
      room.state.tanks[slot].connected = Boolean(room.players[slot]?.connected);
    }
  }

  private findDisconnectedSlot(room: Room): PlayerSlot | null {
    for (const slot of ["A", "B"] as const) {
      const player = room.players[slot];
      if (!player || !player.connected) {
        return slot;
      }
    }
    return null;
  }

  private clearTurnTimer(room: Room): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  private clearSimulation(room: Room): void {
    if (room.simulationTimer) {
      clearInterval(room.simulationTimer);
      room.simulationTimer = null;
    }
  }

  private destroyRoomIfEmpty(room: Room): void {
    const hasConnected = ["A", "B"].some((slot) => {
      const player = room.players[slot as PlayerSlot];
      return Boolean(player?.connected);
    });

    if (hasConnected) {
      return;
    }

    this.clearTurnTimer(room);
    this.clearSimulation(room);
    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
      room.reconnectTimer = null;
    }

    this.rooms.delete(room.code);
  }

  private broadcastSnapshot(room: Room): void {
    this.io.to(room.code).emit("state_snapshot", {
      state: room.state,
      serverTime: Date.now()
    });
  }
}
