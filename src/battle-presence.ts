import type { Server, Socket } from "socket.io";

type PlayerKey = "player_1" | "player_2";
type Presence = "online" | "away" | "offline";
type Session = { id: number; player_1: string | null; player_2: string | null; status: string | null; game_data?: { sequence?: number } };
type Member = { playerKey: PlayerKey; active: boolean };
type Reply = (result: { ok: boolean; error?: string }) => void;

export function createBattlePresence(io: Server, readSession: (id: number) => Promise<Session | null>) {
  const sessions = new Map<number, Map<string, Member>>();
  function broadcast(id: number) {
    const members = [...(sessions.get(id)?.values() ?? [])];
    const status = (key: PlayerKey): Presence => members.some(member => member.playerKey === key && member.active)
      ? "online" : members.some(member => member.playerKey === key) ? "away" : "offline";
    io.to("session:" + id).emit("session:presence", { id, player_1: status("player_1"), player_2: status("player_2") });
  }
  return (socket: Socket) => {
    let membership: { id: number; playerKey: PlayerKey } | null = null;
    let pendingId: number | null = null;
    let revision = 0;
    const remove = () => {
      if (!membership) return;
      const id = membership.id;
      membership = null;
      delete socket.data.battleMembership;
      sessions.get(id)?.delete(socket.id);
      if (sessions.get(id)?.size === 0) sessions.delete(id);
      broadcast(id);
    };
    socket.on("join-session", async (id: number, playerKey: PlayerKey, userId: string, callback?: Reply) => {
      const reply: Reply = result => { if (typeof callback === "function") callback(result); };
      if (!Number.isInteger(id) || id <= 0 || !["player_1", "player_2"].includes(playerKey) || !userId) {
        reply({ ok: false, error: "Invalid battle membership" }); return;
      }
      const request = ++revision;
      pendingId = id;
      try {
        const session = await readSession(id);
        if (request !== revision || !socket.connected) return;
        if (!session || session[playerKey] !== userId) {
          reply({ ok: false, error: "You are not a player in this battle" }); return;
        }
        if (membership && membership.id !== id) {
          const oldId = membership.id;
          remove();
          await socket.leave("session:" + oldId);
          if (request !== revision || !socket.connected) return;
        }
        await socket.join("session:" + id);
        if (request !== revision || !socket.connected) {
          if (membership?.id !== id) await socket.leave("session:" + id);
          return;
        }
        membership = { id, playerKey };
        socket.data.battleMembership = membership;
        pendingId = null;
        const members = sessions.get(id) ?? new Map<string, Member>();
        members.set(socket.id, { playerKey, active: true });
        sessions.set(id, members);
        broadcast(id);
        // Notify the waiting player when their opponent first joins.
        if (playerKey === "player_2" && session.status === "ready" && session.game_data?.sequence === 0) {
          io.to("session:" + id).emit("receive:session", session);
        }
        reply({ ok: true });
      } catch {
        if (request === revision && socket.connected) reply({ ok: false, error: "Could not join battle" });
      }
    });
    socket.on("session:activity", (payload: { id: number; active: boolean }) => {
      if (!payload || membership?.id !== payload.id || typeof payload.active !== "boolean") return;
      const member = sessions.get(payload.id)?.get(socket.id);
      if (!member || member.active === payload.active) return;
      member.active = payload.active;
      broadcast(payload.id);
    });
    socket.on("leave-session", async (id: number) => {
      if (membership?.id !== id && pendingId !== id) return;
      revision++;
      pendingId = null;
      if (membership?.id === id) remove();
      await socket.leave("session:" + id);
    });
    socket.on("disconnect", () => {
      revision++;
      pendingId = null;
      remove();
    });
  };
}
