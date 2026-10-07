import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import {
  createSessionsRouter,
  CardActivated,
  GameData
} from "./routes/sessions";
import { supabase } from "./supabase";
import { createBattlePresence } from "./battle-presence";

const SESSION_FIELDS =
  "id, created_at, user_id, game_data, card_activated, player_1, player_2, player_1_deck, player_2_deck, status, count";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.get("/ping", (_req, res) => res.json({ pong: true }));
app.use("/api/sessions", createSessionsRouter(io));

// ── Socket.io connection handling ─────────────────────────────────────────────

const registerBattlePresence = createBattlePresence(io, async (id) => {
  const { data, error } = await supabase.from("battle_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
});

io.on("connection", (socket) => {
  console.log(`[socket] connected  ${socket.id}`);

  registerBattlePresence(socket);

  // Client joins a user room (for the debug/battle-sessions screen)
  socket.on("join-user", (userId: string) => {
    socket.join(`user:${userId}`);
    console.log(`[socket] ${socket.id} → user:${userId}`);
  });

  socket.on(
    "update:session",
    async ({
      id,
      gameData,
      activatedCard,
      count
    }: {
      id: number;
      gameData: GameData;
      activatedCard: CardActivated;
      count: number;
    }) => {
      const { data, error } = await supabase
        .from("battle_sessions")
        .update({
          game_data: gameData,
          card_activated: [activatedCard],
          count
        })
        .eq("id", id)
        .eq("status", "ready")
        .select("*")
        .maybeSingle();

      if (error || !data) {
        socket.emit("update:session:error", { error: error?.message ?? "Battle is no longer active" });
        return;
      }

      io.to(`session:${id}`).emit("receive:session", data);
    }
  );

  socket.on(
    "update:change_phase",
    async ({
      id,
      gameData,
      count,
      player_key,
      phase,
      player_turn
    }: {
      id: number;
      gameData: GameData;
      count: number;
      player_key: string;
      phase: string;
      player_turn: string;
    }) => {
      const data1 = {
        game_data: gameData,
        count,
        phase: phase,
        player_turn
      };
      
      const { data, error } = await supabase
        .from("battle_sessions")
        .update(data1)
        .eq("id", id)
        .eq("status", "ready")
        .select("*")
        .maybeSingle();

      if (error || !data) {
        socket.emit("update:session:error", { error: error?.message ?? "Battle is no longer active" });
        return;
      }

      io.to(`session:${id}`).emit("receive:change_phase", data);
    }
  );

  // Share completed effects without replaying the card or changing the turn.
  socket.on("update:resolved_card", (result: {
    id: number; gameData: GameData; sequence: number; player_turn: string; phase: string;
  }) => {
    if (!socket.rooms.has(`session:${result.id}`)) return;
    socket.to(`session:${result.id}`).emit("receive:resolved_card", result);
  });

  socket.on("disconnect", () => {
    console.log(`[socket] disconnected ${socket.id}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
httpServer.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Card Master server running on http://0.0.0.0:${PORT}`);
  console.log(`  → LAN: http://192.168.1.53:${PORT}`);
});
