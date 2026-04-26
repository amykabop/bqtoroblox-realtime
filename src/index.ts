import { DurableObject } from "cloudflare:workers";

type Facing = "up" | "down" | "left" | "right";
type PlayerAnimMode = "idle" | "walk" | "attack" | "death";

type PlayerRealtimeState = {
  userId: string;
  username: string;
  tile: { x: number; y: number };
  renderPosition: { x: number; y: number };
  facing: Facing;
  mode: PlayerAnimMode;
  dead: boolean;
  hp: number;
  maxHp: number;
  level: number;
  pvpEnabled: boolean;
  mapLevelId: number;
  animationStartedAt: number;
  updatedAt: number;
};

type SessionAttachment = {
  sessionId: string;
  roomId: string;
  player?: PlayerRealtimeState;
};

type ClientStateMessage = {
  type: "hello" | "state";
  player: PlayerRealtimeState;
};

type ClientPingMessage = {
  type: "ping";
};

type ClientMessage = ClientStateMessage | ClientPingMessage;

type SnapshotMessage = {
  type: "snapshot";
  roomId: string;
  serverNow: number;
  players: PlayerRealtimeState[];
};

type ErrorMessage = {
  type: "error";
  code: string;
  message: string;
};

type Env = {
  REALTIME_ROOM: DurableObjectNamespace<RealtimeRoom>;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function parseRoomId(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "room") {
    return null;
  }
  return parts[1] || null;
}

function parseRouteKind(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[2] || "";
}

function toFacing(value: unknown): Facing {
  return value === "up" || value === "down" || value === "left" || value === "right" ? value : "down";
}

function toMode(value: unknown): PlayerAnimMode {
  return value === "walk" || value === "attack" || value === "death" ? value : "idle";
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizePlayerState(value: unknown): PlayerRealtimeState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const root = value as Record<string, unknown>;
  const userId = typeof root.userId === "string" ? root.userId.trim() : "";
  const username = typeof root.username === "string" ? root.username.trim() : "";
  if (!userId || !username) {
    return null;
  }
  const tileValue = root.tile as Record<string, unknown> | undefined;
  const renderValue = root.renderPosition as Record<string, unknown> | undefined;
  const now = Date.now();
  return {
    userId,
    username,
    tile: {
      x: Math.floor(toFiniteNumber(tileValue?.x, 0)),
      y: Math.floor(toFiniteNumber(tileValue?.y, 0)),
    },
    renderPosition: {
      x: toFiniteNumber(renderValue?.x, toFiniteNumber(tileValue?.x, 0)),
      y: toFiniteNumber(renderValue?.y, toFiniteNumber(tileValue?.y, 0)),
    },
    facing: toFacing(root.facing),
    mode: toMode(root.mode),
    dead: Boolean(root.dead),
    hp: Math.max(0, Math.floor(toFiniteNumber(root.hp, 0))),
    maxHp: Math.max(1, Math.floor(toFiniteNumber(root.maxHp, 1))),
    level: Math.max(1, Math.floor(toFiniteNumber(root.level, 1))),
    pvpEnabled: Boolean(root.pvpEnabled),
    mapLevelId: Math.floor(toFiniteNumber(root.mapLevelId, -1)),
    animationStartedAt: Math.max(0, Math.floor(toFiniteNumber(root.animationStartedAt, now))),
    updatedAt: Math.max(0, Math.floor(toFiniteNumber(root.updatedAt, now))),
  };
}

function safeSend(ws: WebSocket, payload: SnapshotMessage | ErrorMessage) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    try {
      ws.close(1011, "send failed");
    } catch {
      // no-op
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: JSON_HEADERS,
      });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "bqtoroblox-realtime",
        transport: "durable-objects-websocket",
        now: Date.now(),
      });
    }

    const roomId = parseRoomId(url);
    if (!roomId) {
      return json(
        {
          ok: false,
          message: "Use /room/<roomId>/websocket or /room/<roomId>/debug",
        },
        { status: 404 },
      );
    }

    const routeKind = parseRouteKind(url);
    if (routeKind !== "websocket" && routeKind !== "debug") {
      return json({ ok: false, message: "Unknown route." }, { status: 404 });
    }

    if (routeKind === "websocket") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (request.method !== "GET") {
        return json({ ok: false, message: "Expected GET." }, { status: 405 });
      }
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return json({ ok: false, message: "Expected Upgrade: websocket." }, { status: 426 });
      }
    }

    const stub = env.REALTIME_ROOM.getByName(roomId);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class RealtimeRoom extends DurableObject {
  private sessions: Map<WebSocket, SessionAttachment>;
  private playersByUserId: Map<string, PlayerRealtimeState>;
  private roomId: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();
    this.playersByUserId = new Map();
    this.roomId = null;

    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment) {
        return;
      }
      this.roomId = this.roomId ?? attachment.roomId;
      this.sessions.set(ws, attachment);
      if (attachment.player) {
        this.playersByUserId.set(attachment.player.userId, attachment.player);
      }
    });

    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = parseRoomId(url);
    const routeKind = parseRouteKind(url);

    if (!roomId) {
      return json({ ok: false, message: "Missing room id." }, { status: 400 });
    }
    this.roomId = this.roomId ?? roomId;

    if (routeKind === "debug") {
      return json(this.snapshot());
    }

    if (routeKind !== "websocket") {
      return json({ ok: false, message: "Unknown room route." }, { status: 404 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);

    const attachment: SessionAttachment = {
      sessionId: crypto.randomUUID(),
      roomId,
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);

    safeSend(server, {
      type: "snapshot",
      roomId,
      serverNow: Date.now(),
      players: [...this.playersByUserId.values()],
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let payload: ClientMessage | null = null;
    try {
      payload = JSON.parse(raw) as ClientMessage;
    } catch {
      safeSend(ws, {
        type: "error",
        code: "bad_json",
        message: "Invalid realtime message payload.",
      });
      return;
    }

    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      safeSend(ws, {
        type: "error",
        code: "bad_message",
        message: "Missing message type.",
      });
      return;
    }

    if (payload.type === "ping") {
      safeSend(ws, {
        type: "snapshot",
        roomId: this.roomId ?? "unknown",
        serverNow: Date.now(),
        players: [...this.playersByUserId.values()],
      });
      return;
    }

    const player = normalizePlayerState(payload.player);
    if (!player) {
      safeSend(ws, {
        type: "error",
        code: "bad_player_state",
        message: "Missing or invalid player payload.",
      });
      return;
    }

    const attachment = (this.sessions.get(ws) ?? ws.deserializeAttachment() ?? {
      sessionId: crypto.randomUUID(),
      roomId: this.roomId ?? "unknown",
    }) as SessionAttachment;
    attachment.player = player;
    attachment.roomId = this.roomId ?? attachment.roomId;
    this.sessions.set(ws, attachment);
    ws.serializeAttachment(attachment);
    this.playersByUserId.set(player.userId, player);

    this.broadcastSnapshot();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const attachment = (this.sessions.get(ws) ?? ws.deserializeAttachment() ?? null) as SessionAttachment | null;
    this.sessions.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // no-op
    }

    if (attachment?.player?.userId) {
      const stillConnected = [...this.sessions.values()].some(
        (session) => session.player?.userId === attachment.player?.userId,
      );
      if (!stillConnected) {
        this.playersByUserId.delete(attachment.player.userId);
      }
    }

    this.broadcastSnapshot();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "websocket error", false);
  }

  private snapshot() {
    return {
      ok: true,
      roomId: this.roomId,
      connections: this.sessions.size,
      players: [...this.playersByUserId.values()],
      serverNow: Date.now(),
    };
  }

  private broadcastSnapshot() {
    const payload: SnapshotMessage = {
      type: "snapshot",
      roomId: this.roomId ?? "unknown",
      serverNow: Date.now(),
      players: [...this.playersByUserId.values()],
    };
    for (const ws of this.sessions.keys()) {
      safeSend(ws, payload);
    }
  }
}
