import { describe, expect, it } from "vitest";
import { PHYSICS } from "@scorched-earth/shared";
import {
  applyBlastDamage,
  clampAngle,
  clampPower,
  createInitialState,
  deformTerrain,
  generateTerrain,
  stepProjectile
} from "../src/game.js";

describe("game helpers", () => {
  it("clamps angle and power", () => {
    expect(clampAngle(-10)).toBeGreaterThanOrEqual(0);
    expect(clampAngle(999)).toBeLessThanOrEqual(175);
    expect(clampPower(0)).toBeGreaterThanOrEqual(20);
    expect(clampPower(999)).toBeLessThanOrEqual(120);
  });

  it("generates terrain with expected shape", () => {
    const terrain = generateTerrain(12345);
    expect(terrain.heights).toHaveLength(terrain.width);
    const min = Math.min(...terrain.heights);
    const max = Math.max(...terrain.heights);
    expect(min).toBeGreaterThan(50);
    expect(max).toBeLessThan(terrain.height);
  });

  it("deforms terrain downward at impact point", () => {
    const state = createInitialState("ABCDE", 42, "A");
    const x = Math.floor(state.terrain.width * 0.5);
    const before = state.terrain.heights[x] ?? 0;
    deformTerrain(state, { x, y: before });
    const after = state.terrain.heights[x] ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("applies blast damage based on proximity", () => {
    const state = createInitialState("ABCDE", 42, "A");
    const tankA = state.tanks.A;
    const results = applyBlastDamage(state, { x: tankA.x, y: tankA.y });
    const damageA = results.find((entry) => entry.slot === "A");
    expect(damageA).toBeDefined();
    expect(damageA?.amount ?? 0).toBeGreaterThan(0);
    expect(state.tanks.A.hp).toBeLessThan(100);
  });

  it("steps projectile and eventually collides", () => {
    const state = createInitialState("ABCDE", 42, "A");
    state.wind.force = 0;
    state.projectile = {
      pos: { x: state.tanks.A.x, y: state.tanks.A.y - 20 },
      vel: { x: 65, y: -35 },
      active: true,
      owner: "A"
    };

    let impact = null;
    for (let i = 0; i < 600; i += 1) {
      impact = stepProjectile(state, 1 / 60);
      if (impact) {
        break;
      }
    }

    expect(impact).not.toBeNull();
    expect(impact?.point.y).toBeGreaterThanOrEqual(0);
    expect(PHYSICS.gravity).toBeGreaterThan(0);
  });
});
