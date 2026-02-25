import "./styles.css";
import { io, type Socket } from "socket.io-client";
import {
  MAX_ANGLE,
  MAX_POWER,
  MIN_ANGLE,
  MIN_POWER,
  PHYSICS,
  type ClientToServerEvents,
  type GameState,
  type PlayerSlot,
  type ServerToClientEvents
} from "@scorched-earth/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
const STORAGE_ROOM_KEY = "se_room_code";
const STORAGE_TOKEN_KEY = "se_reconnect_token";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Missing app root");
}

root.innerHTML = `
  <main class="shell">
    <section class="panel">
      <h1 class="title">Scorched Earth</h1>
      <p class="status" id="connectionStatus">Connecting...</p>
      <div class="lobby-grid" id="lobby">
        <article class="card">
          <strong>Create room</strong>
          <p>Start a room and share the code with your opponent.</p>
          <button id="createRoomBtn" type="button">Create Room</button>
        </article>
        <article class="card">
          <strong>Join room</strong>
          <div class="row">
            <input id="roomCodeInput" class="text-input" maxlength="8" placeholder="ROOM CODE" />
            <button id="joinRoomBtn" type="button">Join</button>
          </div>
        </article>
        <article class="card">
          <strong>Room details</strong>
          <p class="badge" id="roomInfo">Not in a room</p>
          <p class="status" id="eventStatus"></p>
        </article>
      </div>
    </section>

    <section class="panel game-wrap hidden" id="gameSection">
      <canvas id="battlefield" width="1000" height="600" aria-label="Battlefield"></canvas>

      <div class="hud">
        <article class="card"><strong>Turn</strong><span id="turnInfo">-</span></article>
        <article class="card"><strong>Timer</strong><span id="timerInfo">-</span></article>
        <article class="card"><strong>Wind</strong><span id="windInfo">-</span></article>
        <article class="card"><strong>HP</strong><span id="hpInfo">-</span></article>
      </div>

      <div class="controls">
        <label class="control">
          <span>Angle <span id="angleValue">0</span>°</span>
          <input id="angleInput" type="range" min="${MIN_ANGLE}" max="${MAX_ANGLE}" step="1" />
        </label>
        <label class="control">
          <span>Power <span id="powerValue">0</span></span>
          <input id="powerInput" type="range" min="${MIN_POWER}" max="${MAX_POWER}" step="1" />
        </label>
        <div class="control">
          <span>Action</span>
          <div class="action-buttons">
            <button id="fireBtn" type="button">Fire</button>
            <button id="rematchBtn" class="hidden" type="button">Rematch</button>
          </div>
          <p id="rematchInfo" class="status hidden"></p>
        </div>
      </div>
    </section>
  </main>
`;

const connectionStatusEl = must<HTMLParagraphElement>("connectionStatus");
const eventStatusEl = must<HTMLParagraphElement>("eventStatus");
const roomInfoEl = must<HTMLParagraphElement>("roomInfo");
const gameSectionEl = must<HTMLElement>("gameSection");
const turnInfoEl = must<HTMLSpanElement>("turnInfo");
const timerInfoEl = must<HTMLSpanElement>("timerInfo");
const windInfoEl = must<HTMLSpanElement>("windInfo");
const hpInfoEl = must<HTMLSpanElement>("hpInfo");
const angleValueEl = must<HTMLSpanElement>("angleValue");
const powerValueEl = must<HTMLSpanElement>("powerValue");

const createRoomBtn = must<HTMLButtonElement>("createRoomBtn");
const joinRoomBtn = must<HTMLButtonElement>("joinRoomBtn");
const fireBtn = must<HTMLButtonElement>("fireBtn");
const rematchBtn = must<HTMLButtonElement>("rematchBtn");
const roomCodeInput = must<HTMLInputElement>("roomCodeInput");
const angleInput = must<HTMLInputElement>("angleInput");
const powerInput = must<HTMLInputElement>("powerInput");
const rematchInfoEl = must<HTMLParagraphElement>("rematchInfo");
const canvas = must<HTMLCanvasElement>("battlefield");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: true,
  transports: ["websocket"]
});

let currentState: GameState | null = null;
let mySlot: PlayerSlot | null = null;
let roomCode: string | null = null;
let reconnectToken: string | null = null;
let serverTimeOffset = 0;
let latestNotice = "";
let rematchRequestedSlots = new Set<PlayerSlot>();

const savedRoom = localStorage.getItem(STORAGE_ROOM_KEY);
const savedToken = localStorage.getItem(STORAGE_TOKEN_KEY);

if (savedRoom && savedToken) {
  roomCode = savedRoom;
  reconnectToken = savedToken;
}

socket.on("connect", () => {
  setConnectionStatus("Connected", "ok");
  if (roomCode && reconnectToken) {
    socket.emit("rejoin_room", { roomCode, reconnectToken });
  }
});

socket.on("disconnect", () => {
  setConnectionStatus("Disconnected - trying to reconnect", "error");
});

socket.on("room_created", (payload) => {
  roomCode = payload.roomCode;
  mySlot = payload.slot;
  reconnectToken = payload.reconnectToken;
  persistSession();
  setRoomInfo(`Room ${payload.roomCode} | You are ${payload.slot}`);
  setEventStatus("Room created. Waiting for opponent.", "ok");
  rematchRequestedSlots.clear();
  updateRematchUi();
  gameSectionEl.classList.remove("hidden");
});

socket.on("room_joined", (payload) => {
  roomCode = payload.roomCode;
  mySlot = payload.slot;
  reconnectToken = payload.reconnectToken;
  persistSession();
  setRoomInfo(`Room ${payload.roomCode} | You are ${payload.slot}`);
  setEventStatus("Joined room.", "ok");
  updateRematchUi();
  gameSectionEl.classList.remove("hidden");
});

socket.on("game_started", (payload) => {
  currentState = payload.initialState;
  rematchRequestedSlots.clear();
  syncControlsFromState();
  gameSectionEl.classList.remove("hidden");
  setEventStatus("Match started.", "ok");
});

socket.on("state_snapshot", (payload) => {
  currentState = payload.state;
  serverTimeOffset = payload.serverTime - Date.now();
  if (currentState.phase !== "match_end" && rematchRequestedSlots.size > 0) {
    rematchRequestedSlots.clear();
  }
  syncControlsFromState();
  refreshHud();
});

socket.on("turn_started", (payload) => {
  latestNotice = `Turn: ${payload.activeSlot}`;
  refreshHud();
});

socket.on("player_disconnected", (payload) => {
  setEventStatus(
    `Player ${payload.slot} disconnected. Waiting to reconnect...`,
    "error"
  );
});

socket.on("player_reconnected", (payload) => {
  setEventStatus(`Player ${payload.slot} reconnected.`, "ok");
});

socket.on("match_ended", (payload) => {
  setEventStatus(`Match ended. Winner: ${payload.winnerSlot}`, "ok");
  updateRematchUi();
});

socket.on("rematch_updated", (payload) => {
  rematchRequestedSlots = new Set(payload.requestedSlots);
  if (payload.requestedBy && mySlot && payload.requestedBy !== mySlot) {
    setEventStatus("Opponent requested rematch.", "ok");
  }
  updateRematchUi();
});

socket.on("error_event", (payload) => {
  setEventStatus(payload.message, "error");
});

socket.on("pong", (sentAt) => {
  const latency = Date.now() - sentAt;
  setConnectionStatus(`Connected (${latency}ms)`, "ok");
});

createRoomBtn.addEventListener("click", () => {
  socket.emit("create_room");
});

joinRoomBtn.addEventListener("click", () => {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) {
    setEventStatus("Enter a room code.", "error");
    return;
  }

  socket.emit("join_room", {
    roomCode: code,
    reconnectToken: reconnectToken && roomCode === code ? reconnectToken : undefined
  });
});

fireBtn.addEventListener("click", () => {
  socket.emit("fire");
});

rematchBtn.addEventListener("click", () => {
  socket.emit("request_rematch");
});

const emitAim = () => {
  if (!currentState || !mySlot) {
    return;
  }

  if (currentState.phase !== "aiming" || currentState.activeSlot !== mySlot) {
    return;
  }

  const angleDeg = Number(angleInput.value);
  const power = Number(powerInput.value);
  socket.emit("lock_aim", { angleDeg, power });
};

angleInput.addEventListener("input", () => {
  angleValueEl.textContent = angleInput.value;
  emitAim();
});

powerInput.addEventListener("input", () => {
  powerValueEl.textContent = powerInput.value;
  emitAim();
});

setInterval(() => {
  if (socket.connected) {
    socket.emit("ping", Date.now());
  }
}, 5000);

setInterval(() => {
  refreshHud();
}, 200);

function syncControlsFromState(): void {
  if (!currentState || !mySlot) {
    return;
  }

  const mine = currentState.tanks[mySlot];
  const canAct = currentState.phase === "aiming" && currentState.activeSlot === mySlot;

  angleInput.value = Math.round(mine.angleDeg).toString();
  powerInput.value = Math.round(mine.power).toString();
  angleValueEl.textContent = angleInput.value;
  powerValueEl.textContent = powerInput.value;

  angleInput.disabled = !canAct;
  powerInput.disabled = !canAct;
  fireBtn.disabled = !canAct;
  updateRematchUi();
}

function refreshHud(): void {
  if (!currentState) {
    return;
  }

  turnInfoEl.textContent =
    currentState.phase === "match_end"
      ? `Winner: ${currentState.winnerSlot ?? "-"}`
      : `Active: ${currentState.activeSlot} (${currentState.phase})`;

  if (currentState.turnEndsAt) {
    const remainingMs = currentState.turnEndsAt - (Date.now() + serverTimeOffset);
    timerInfoEl.textContent = `${Math.max(0, Math.ceil(remainingMs / 1000))}s`;
  } else {
    timerInfoEl.textContent = "-";
  }

  const wind = currentState.wind.force;
  windInfoEl.textContent = `${wind > 0 ? "->" : wind < 0 ? "<-" : "--"} ${Math.abs(wind).toFixed(1)}`;
  hpInfoEl.textContent = `A: ${currentState.tanks.A.hp} | B: ${currentState.tanks.B.hp}`;

  if (latestNotice) {
    setEventStatus(latestNotice, "ok");
    latestNotice = "";
  }
}

function updateRematchUi(): void {
  const visible = currentState?.phase === "match_end" && mySlot !== null;
  rematchBtn.classList.toggle("hidden", !visible);
  rematchInfoEl.classList.toggle("hidden", !visible);

  if (!visible || !mySlot) {
    rematchInfoEl.textContent = "";
    return;
  }

  const mineRequested = rematchRequestedSlots.has(mySlot);
  const opponentSlot: PlayerSlot = mySlot === "A" ? "B" : "A";
  const opponentRequested = rematchRequestedSlots.has(opponentSlot);
  const canRequest = currentState?.tanks[mySlot].connected ?? false;

  rematchBtn.disabled = mineRequested || !canRequest;

  if (mineRequested && opponentRequested) {
    rematchInfoEl.textContent = "Rematch accepted. Starting...";
    return;
  }

  if (mineRequested) {
    rematchInfoEl.textContent = "Rematch requested. Waiting for opponent.";
    return;
  }

  if (opponentRequested) {
    rematchInfoEl.textContent = "Opponent wants a rematch.";
    return;
  }

  rematchInfoEl.textContent = "Match ended. Request a rematch to play again.";
}

function draw(): void {
  requestAnimationFrame(draw);

  if (!currentState) {
    drawWaitingScene();
    return;
  }

  drawSky();
  drawTerrain(currentState);
  drawTanks(currentState);

  if (currentState.projectile?.active) {
    ctx.beginPath();
    ctx.fillStyle = "#ffe169";
    ctx.arc(
      currentState.projectile.pos.x,
      currentState.projectile.pos.y,
      PHYSICS.projectileRadius,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

draw();

function drawWaitingScene(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSky();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "28px 'Russo One', sans-serif";
  ctx.fillText("Create or join a room to start", 300, 290);
}

function drawSky(): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#ffd28a");
  gradient.addColorStop(0.45, "#f28b59");
  gradient.addColorStop(1, "#4f2a1a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawTerrain(state: GameState): void {
  const { terrain } = state;
  ctx.beginPath();
  ctx.moveTo(0, terrain.height);
  for (let x = 0; x < terrain.width; x += 1) {
    ctx.lineTo(x, terrain.heights[x] ?? terrain.height);
  }
  ctx.lineTo(terrain.width, terrain.height);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, 260, 0, terrain.height);
  gradient.addColorStop(0, "#8f5a36");
  gradient.addColorStop(1, "#3b2419");
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawTanks(state: GameState): void {
  for (const slot of ["A", "B"] as const) {
    const tank = state.tanks[slot];
    const color = slot === "A" ? "#5cc8ff" : "#ff7a7a";
    const bodyShade = slot === "A" ? "#369dcc" : "#cc5454";
    const trackColor = slot === "A" ? "#223a49" : "#4f2525";
    const outline = "#fff9e8";

    const treadWidth = PHYSICS.tankRadius * 2.8;
    const treadHeight = PHYSICS.tankRadius * 0.72;
    const treadX = tank.x - treadWidth / 2;
    const treadY = tank.y + PHYSICS.tankRadius - treadHeight;

    const hullWidth = PHYSICS.tankRadius * 2.15;
    const hullHeight = PHYSICS.tankRadius * 0.92;
    const hullX = tank.x - hullWidth / 2;
    const hullY = treadY - hullHeight + 1;

    const turretRadius = PHYSICS.tankRadius * 0.62;
    const turretY = hullY - turretRadius * 0.12;

    // Tread block.
    ctx.fillStyle = trackColor;
    ctx.fillRect(treadX, treadY, treadWidth, treadHeight);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(treadX, treadY, treadWidth, treadHeight);

    // Road wheels.
    const wheelCount = 5;
    for (let i = 0; i < wheelCount; i += 1) {
      const wheelX = treadX + (i + 0.5) * (treadWidth / wheelCount);
      const wheelY = treadY + treadHeight * 0.54;
      const wheelR = treadHeight * 0.2;
      ctx.beginPath();
      ctx.fillStyle = "#b8a58e";
      ctx.arc(wheelX, wheelY, wheelR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "#3d2c24";
      ctx.arc(wheelX, wheelY, wheelR * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sloped hull.
    ctx.beginPath();
    ctx.moveTo(hullX, hullY + hullHeight);
    ctx.lineTo(hullX + hullWidth * 0.12, hullY + hullHeight * 0.18);
    ctx.lineTo(hullX + hullWidth * 0.88, hullY + hullHeight * 0.18);
    ctx.lineTo(hullX + hullWidth, hullY + hullHeight);
    ctx.closePath();
    ctx.fillStyle = bodyShade;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Turret dome.
    ctx.beginPath();
    ctx.ellipse(tank.x, turretY, turretRadius * 1.05, turretRadius * 0.82, 0, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Turret hatch.
    ctx.beginPath();
    ctx.fillStyle = "rgba(255, 249, 232, 0.25)";
    ctx.arc(tank.x - turretRadius * 0.15, turretY - turretRadius * 0.15, turretRadius * 0.3, 0, Math.PI * 2);
    ctx.fill();

    const rad = (tank.angleDeg * Math.PI) / 180;
    const barrelStartX = tank.x + Math.cos(rad) * turretRadius * 0.45;
    const barrelStartY = turretY - Math.sin(rad) * turretRadius * 0.45;
    const barrelLen = PHYSICS.tankRadius * 1.85;
    const endX = barrelStartX + Math.cos(rad) * barrelLen;
    const endY = barrelStartY - Math.sin(rad) * barrelLen;

    ctx.strokeStyle = "#d6d2c6";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(barrelStartX, barrelStartY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Barrel muzzle ring.
    ctx.beginPath();
    ctx.fillStyle = "#746d61";
    ctx.arc(endX, endY, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff9e8";
    ctx.font = "13px 'Space Grotesk', sans-serif";
    const status = tank.connected ? "online" : "offline";
    ctx.fillText(`${slot} ${tank.hp}hp ${status}`, tank.x - 34, hullY - 8);
  }
}

function setRoomInfo(message: string): void {
  roomInfoEl.textContent = message;
}

function setConnectionStatus(message: string, kind: "ok" | "error"): void {
  connectionStatusEl.textContent = message;
  connectionStatusEl.className = `status ${kind}`;
}

function setEventStatus(message: string, kind: "ok" | "error"): void {
  eventStatusEl.textContent = message;
  eventStatusEl.className = `status ${kind}`;
}

function persistSession(): void {
  if (roomCode) {
    localStorage.setItem(STORAGE_ROOM_KEY, roomCode);
  }
  if (reconnectToken) {
    localStorage.setItem(STORAGE_TOKEN_KEY, reconnectToken);
  }
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
