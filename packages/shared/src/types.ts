export type RoomCode = string;

export type PlayerSlot = "A" | "B";

export type GamePhase =
  | "lobby"
  | "aiming"
  | "projectile_flight"
  | "round_end"
  | "match_end"
  | "paused_reconnect";

export interface Vector2 {
  x: number;
  y: number;
}

export interface TankState {
  slot: PlayerSlot;
  x: number;
  y: number;
  angleDeg: number;
  power: number;
  hp: number;
  connected: boolean;
}

export interface ProjectileState {
  pos: Vector2;
  vel: Vector2;
  active: boolean;
  owner: PlayerSlot;
}

export interface TerrainState {
  width: number;
  height: number;
  heights: number[];
}

export interface WindState {
  force: number;
}

export interface PlayerPresence {
  slot: PlayerSlot;
  connected: boolean;
}

export interface GameState {
  roomCode: RoomCode;
  phase: GamePhase;
  activeSlot: PlayerSlot;
  turnEndsAt: number | null;
  terrain: TerrainState;
  wind: WindState;
  tanks: Record<PlayerSlot, TankState>;
  projectile: ProjectileState | null;
  winnerSlot: PlayerSlot | null;
}

export interface PhysicsConfig {
  gravity: number;
  windAccelerationScale: number;
  projectileSpeedScale: number;
  tankRadius: number;
  projectileRadius: number;
  craterRadius: number;
  blastRadius: number;
  maxDamage: number;
}

export const WORLD_WIDTH = 1000;
export const WORLD_HEIGHT = 600;
export const TICK_RATE = 60;
export const TURN_DURATION_MS = 30_000;
export const RECONNECT_GRACE_MS = 30_000;

export const PHYSICS: PhysicsConfig = {
  gravity: 130,
  windAccelerationScale: 1,
  projectileSpeedScale: 2.8,
  tankRadius: 12,
  projectileRadius: 4,
  craterRadius: 36,
  blastRadius: 84,
  maxDamage: 55
};

export const MIN_ANGLE = 5;
export const MAX_ANGLE = 175;
export const MIN_POWER = 20;
export const MAX_POWER = 120;

export const STARTING_HP = 100;
