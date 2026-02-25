import { describe, expect, it } from "vitest";
import type { Server, Socket } from "socket.io";
import { RoomManager } from "../src/room-manager.js";

class FakeIo {
  public emitted: Array<{ room: string; event: string; payload: unknown }> = [];

  to(room: string): { emit: (event: string, payload: unknown) => void } {
    return {
      emit: (event: string, payload: unknown): void => {
        this.emitted.push({ room, event, payload });
      }
    };
  }
}

function fakeSocket(id: string): Socket {
  return {
    id,
    join: () => undefined
  } as unknown as Socket;
}

describe("RoomManager rematch", () => {
  it("starts a new match after both players request rematch", () => {
    const io = new FakeIo();
    const manager = new RoomManager(io as unknown as Server);

    const a = fakeSocket("socket-a");
    const b = fakeSocket("socket-b");

    const created = manager.createRoom(a);
    manager.joinRoom(b, created.room.code);

    const room = manager.getRoomBySocketId("socket-a") as any;
    expect(room).toBeTruthy();

    io.emitted.length = 0;
    room.state.phase = "match_end";
    room.state.winnerSlot = "A";
    room.state.turnEndsAt = null;

    expect(manager.requestRematch("socket-a")).toBeNull();
    expect(room.state.phase).toBe("match_end");

    expect(manager.requestRematch("socket-b")).toBeNull();
    expect(room.state.phase).toBe("aiming");
    expect(room.state.winnerSlot).toBeNull();

    expect(io.emitted.some((entry) => entry.event === "rematch_updated")).toBe(true);
    expect(io.emitted.some((entry) => entry.event === "game_started")).toBe(true);
  });

  it("rejects rematch request before match end", () => {
    const io = new FakeIo();
    const manager = new RoomManager(io as unknown as Server);

    const a = fakeSocket("socket-a");
    const b = fakeSocket("socket-b");

    const created = manager.createRoom(a);
    manager.joinRoom(b, created.room.code);

    expect(manager.requestRematch("socket-a")).toBe("REMATCH_NOT_AVAILABLE");
  });
});
