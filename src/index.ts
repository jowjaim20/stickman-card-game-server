import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { createSessionsRouter } from "./routes/sessions";
import { supabase } from "./supabase";

const SESSION_FIELDS =
  "id, created_at, user_id, game_data, card_activated, player_1, player_2, player_1_deck, player_2_deck, status, count";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());
app.get("/ping", (_req, res) => res.json({ pong: true }));
app.use("/api/sessions", createSessionsRouter(io));

// ── Socket.io connection handling ─────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[socket] connected  ${socket.id}`);

  // Client joins a specific battle session room.
  // After joining, if the session is already "ready" (opponent joined while the
  // client was still connecting), push the current state directly to this socket
  // so Player 1 never misses the broadcast due to a timing race.
  socket.on("join-session", async (sessionId: number) => {
    await socket.join(`session:${sessionId}`);
    console.log(`[socket] ${socket.id} → session:${sessionId}`);

    const { data } = await supabase
      .from("battle_sessions")
      .select(SESSION_FIELDS)
      .eq("id", sessionId)
      .single();

    if (data?.status === "ready") {
      socket.emit("session:updated", data);
    }
  });

  // Client leaves a battle session room
  socket.on("leave-session", (sessionId: number) => {
    socket.leave(`session:${sessionId}`);
  });

  // Client joins a user room (for the debug/battle-sessions screen)
  socket.on("join-user", (userId: string) => {
    socket.join(`user:${userId}`);
    console.log(`[socket] ${socket.id} → user:${userId}`);
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
