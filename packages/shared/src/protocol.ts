import type { GameState, PlayerPresence, PlayerSlot, RoomCode } from "./types.js";

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface RoomCreatedPayload {
  roomCode: RoomCode;
  slot: PlayerSlot;
  reconnectToken: string;
}

export interface RoomJoinedPayload {
  roomCode: RoomCode;
  slot: PlayerSlot;
  players: PlayerPresence[];
  reconnectToken: string;
}

export interface GameStartedPayload {
  seed: number;
  initialState: GameState;
}

export interface StateSnapshotPayload {
  state: GameState;
  serverTime: number;
}

export interface TurnStartedPayload {
  activeSlot: PlayerSlot;
  turnEndsAt: number;
}

export interface ProjectileSpawnedPayload {
  projectile: NonNullable<GameState["projectile"]>;
}

export interface TerrainUpdatedPayload {
  heights: number[];
}

export interface DamageAppliedPayload {
  slot: PlayerSlot;
  hpAfter: number;
  amount: number;
}

export interface PlayerDisconnectedPayload {
  slot: PlayerSlot;
  reconnectDeadline: number;
}

export interface PlayerReconnectedPayload {
  slot: PlayerSlot;
}

export interface MatchEndedPayload {
  winnerSlot: PlayerSlot;
}

export interface RematchUpdatedPayload {
  requestedSlots: PlayerSlot[];
  requestedBy: PlayerSlot | null;
}

export interface JoinRoomPayload {
  roomCode: RoomCode;
  reconnectToken?: string;
}

export interface LockAimPayload {
  angleDeg: number;
  power: number;
}

export interface RejoinRoomPayload {
  roomCode: RoomCode;
  reconnectToken: string;
}

export interface ServerToClientEvents {
  room_created: (payload: RoomCreatedPayload) => void;
  room_joined: (payload: RoomJoinedPayload) => void;
  game_started: (payload: GameStartedPayload) => void;
  state_snapshot: (payload: StateSnapshotPayload) => void;
  turn_started: (payload: TurnStartedPayload) => void;
  projectile_spawned: (payload: ProjectileSpawnedPayload) => void;
  terrain_updated: (payload: TerrainUpdatedPayload) => void;
  damage_applied: (payload: DamageAppliedPayload) => void;
  player_disconnected: (payload: PlayerDisconnectedPayload) => void;
  player_reconnected: (payload: PlayerReconnectedPayload) => void;
  match_ended: (payload: MatchEndedPayload) => void;
  rematch_updated: (payload: RematchUpdatedPayload) => void;
  error_event: (payload: ErrorPayload) => void;
  pong: (sentAt: number) => void;
}

export interface ClientToServerEvents {
  create_room: () => void;
  join_room: (payload: JoinRoomPayload) => void;
  rejoin_room: (payload: RejoinRoomPayload) => void;
  lock_aim: (payload: LockAimPayload) => void;
  fire: () => void;
  request_rematch: () => void;
  leave_room: () => void;
  ping: (sentAt: number) => void;
}
