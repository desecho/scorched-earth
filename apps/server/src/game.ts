import {
  MAX_ANGLE,
  MAX_POWER,
  MIN_ANGLE,
  MIN_POWER,
  PHYSICS,
  STARTING_HP,
  TURN_DURATION_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type GamePhase,
  type GameState,
  type PlayerSlot,
  type TerrainState,
  type Vector2
} from "@scorched-earth/shared";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function clampAngle(value: number): number {
  return clamp(value, MIN_ANGLE, MAX_ANGLE);
}

export function clampPower(value: number): number {
  return clamp(value, MIN_POWER, MAX_POWER);
}

export function oppositeSlot(slot: PlayerSlot): PlayerSlot {
  return slot === "A" ? "B" : "A";
}

export function heightAt(terrain: TerrainState, x: number): number {
  const index = clamp(Math.round(x), 0, terrain.width - 1);
  return terrain.heights[index] ?? terrain.height;
}

export function generateTerrain(seed: number, width = WORLD_WIDTH, height = WORLD_HEIGHT): TerrainState {
  const heights = new Array<number>(width);
  const base = height * 0.62;

  for (let x = 0; x < width; x += 1) {
    const waveA = Math.sin((x + seed * 0.13) * 0.009) * 42;
    const waveB = Math.sin((x + seed * 0.37) * 0.021) * 26;
    const waveC = Math.sin((x + seed * 0.91) * 0.043) * 12;
    heights[x] = clamp(Math.round(base + waveA + waveB + waveC), Math.round(height * 0.3), height - 20);
  }

  // Small smoothing pass to avoid sharp 1px peaks.
  for (let x = 1; x < width - 1; x += 1) {
    const prev = heights[x - 1] ?? heights[x] ?? base;
    const current = heights[x] ?? base;
    const next = heights[x + 1] ?? heights[x] ?? base;
    heights[x] = Math.round((prev + current + next) / 3);
  }

  return { width, height, heights };
}

function tankYForX(state: GameState, x: number): number {
  return heightAt(state.terrain, x) - PHYSICS.tankRadius - 1;
}

export function createInitialState(roomCode: string, seed: number, startingSlot: PlayerSlot): GameState {
  const terrain = generateTerrain(seed);

  const initialState: GameState = {
    roomCode,
    phase: "lobby",
    activeSlot: startingSlot,
    turnEndsAt: null,
    terrain,
    wind: { force: 0 },
    tanks: {
      A: {
        slot: "A",
        x: Math.round(terrain.width * 0.18),
        y: 0,
        angleDeg: 45,
        power: 72,
        hp: STARTING_HP,
        connected: false
      },
      B: {
        slot: "B",
        x: Math.round(terrain.width * 0.82),
        y: 0,
        angleDeg: 135,
        power: 72,
        hp: STARTING_HP,
        connected: false
      }
    },
    projectile: null,
    winnerSlot: null
  };

  initialState.tanks.A.y = tankYForX(initialState, initialState.tanks.A.x);
  initialState.tanks.B.y = tankYForX(initialState, initialState.tanks.B.x);

  return initialState;
}

export function updateTankGrounding(state: GameState): void {
  state.tanks.A.y = tankYForX(state, state.tanks.A.x);
  state.tanks.B.y = tankYForX(state, state.tanks.B.x);
}

export function pickWind(random: () => number): number {
  const raw = (random() * 2 - 1) * 24;
  return Math.round(raw * 10) / 10;
}

export function spawnProjectile(state: GameState, slot: PlayerSlot): void {
  const tank = state.tanks[slot];
  const angle = clampAngle(tank.angleDeg);
  const power = clampPower(tank.power);
  const launchSpeed = power * PHYSICS.projectileSpeedScale;

  const rad = (angle * Math.PI) / 180;
  const muzzleDistance = PHYSICS.tankRadius + 5;
  const spawnX = tank.x + Math.cos(rad) * muzzleDistance;
  const spawnY = tank.y - Math.sin(rad) * muzzleDistance;

  state.projectile = {
    pos: { x: spawnX, y: spawnY },
    vel: {
      x: Math.cos(rad) * launchSpeed,
      y: -Math.sin(rad) * launchSpeed
    },
    active: true,
    owner: slot
  };
}

export interface ImpactResult {
  point: Vector2;
}

export function stepProjectile(state: GameState, dtSeconds: number): ImpactResult | null {
  const projectile = state.projectile;
  if (!projectile || !projectile.active) {
    return null;
  }

  projectile.vel.x += state.wind.force * PHYSICS.windAccelerationScale * dtSeconds;
  projectile.vel.y += PHYSICS.gravity * dtSeconds;
  projectile.pos.x += projectile.vel.x * dtSeconds;
  projectile.pos.y += projectile.vel.y * dtSeconds;

  for (const slot of ["A", "B"] as const) {
    const tank = state.tanks[slot];
    const dx = projectile.pos.x - tank.x;
    const dy = projectile.pos.y - tank.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= PHYSICS.tankRadius + PHYSICS.projectileRadius) {
      return {
        point: {
          x: projectile.pos.x,
          y: projectile.pos.y
        }
      };
    }
  }

  const terrainY = heightAt(state.terrain, projectile.pos.x);
  if (projectile.pos.y + PHYSICS.projectileRadius >= terrainY) {
    return {
      point: {
        x: projectile.pos.x,
        y: terrainY
      }
    };
  }

  if (
    projectile.pos.x < 0 ||
    projectile.pos.x >= state.terrain.width ||
    projectile.pos.y > state.terrain.height + 100 ||
    projectile.pos.y < -100
  ) {
    const clampedX = clamp(projectile.pos.x, 0, state.terrain.width - 1);
    const clampedY = clamp(projectile.pos.y, 0, state.terrain.height);
    return {
      point: {
        x: clampedX,
        y: clampedY
      }
    };
  }

  return null;
}

export function deformTerrain(state: GameState, impact: Vector2): void {
  const { craterRadius } = PHYSICS;
  const start = clamp(Math.floor(impact.x - craterRadius), 0, state.terrain.width - 1);
  const end = clamp(Math.ceil(impact.x + craterRadius), 0, state.terrain.width - 1);

  for (let x = start; x <= end; x += 1) {
    const dx = x - impact.x;
    const chord = Math.sqrt(Math.max(0, craterRadius * craterRadius - dx * dx));
    const targetHeight = Math.round(impact.y + chord);
    if (targetHeight > (state.terrain.heights[x] ?? state.terrain.height)) {
      state.terrain.heights[x] = clamp(targetHeight, 0, state.terrain.height);
    }
  }
}

export interface DamageResult {
  slot: PlayerSlot;
  amount: number;
  hpAfter: number;
}

export function applyBlastDamage(state: GameState, impact: Vector2): DamageResult[] {
  const results: DamageResult[] = [];

  for (const slot of ["A", "B"] as const) {
    const tank = state.tanks[slot];
    const distance = Math.hypot(tank.x - impact.x, tank.y - impact.y);
    if (distance > PHYSICS.blastRadius) {
      continue;
    }

    const ratio = 1 - distance / PHYSICS.blastRadius;
    const damage = Math.max(1, Math.round(PHYSICS.maxDamage * ratio));
    tank.hp = Math.max(0, tank.hp - damage);
    results.push({ slot, amount: damage, hpAfter: tank.hp });
  }

  return results;
}

export function resolveWinner(state: GameState, lastShooter: PlayerSlot): PlayerSlot | null {
  const hpA = state.tanks.A.hp;
  const hpB = state.tanks.B.hp;

  if (hpA > 0 && hpB > 0) {
    return null;
  }

  if (hpA <= 0 && hpB <= 0) {
    return oppositeSlot(lastShooter);
  }

  return hpA > 0 ? "A" : "B";
}

export function enterTurn(state: GameState, slot: PlayerSlot, wind: number): void {
  state.phase = "aiming";
  state.activeSlot = slot;
  state.wind.force = wind;
  state.turnEndsAt = Date.now() + TURN_DURATION_MS;
}

export function setPhase(state: GameState, phase: GamePhase): void {
  state.phase = phase;
  if (phase !== "aiming") {
    state.turnEndsAt = null;
  }
}
