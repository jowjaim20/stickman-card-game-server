import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameData } from "./routes/sessions";

export type ResolvedCardUpdate = {
  id: number; gameData: GameData; sequence: number; count: number | null;
  player_turn: "player_1" | "player_2"; phase: string;
};
type Membership = { id: number; playerKey: "player_1" | "player_2" } | undefined;

// Persist the completed board even when nobody else is connected to the room.
export async function persistResolvedCard(database: SupabaseClient, membership: Membership, result: ResolvedCardUpdate) {
  if (!result || !membership || membership.id !== result.id || membership.playerKey !== result.player_turn ||
      !Number.isInteger(result.sequence) || result.sequence <= 0 || !result.gameData ||
      (result.count !== null && !Number.isInteger(result.count))) {
    return { ok: false, error: "Invalid resolved card" };
  }
  const { data: session, error: readError } = await database.from("battle_sessions")
    .select("*").eq("id", result.id).maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  if (!session) return { ok: false, error: "Battle not found" };
  const lastCard = session.card_activated?.at(-1);
  // Ignore delayed results from an older card/turn, preserving newer moves and quits.
  if (session.status === "ended" || (session.count ?? 0) > (result.count ?? 0) ||
      (lastCard?.sequence ?? 0) > result.sequence) return { ok: true };
  if (session.status !== "ready" || session.count !== result.count ||
      session.player_turn !== result.player_turn || session.phase !== result.phase ||
      lastCard?.sequence !== result.sequence || lastCard.player_key !== membership.playerKey) {
    return { ok: false, error: "Card no longer matches the active battle" };
  }
  const previous = session.game_data.resolved_sequence;
  if ((previous ?? 0) >= result.sequence) return { ok: true };
  const gameData = { ...result.gameData, resolved_sequence: result.sequence };
  let query = database.from("battle_sessions").update({ game_data: gameData })
    .eq("id", result.id).eq("status", "ready").eq("phase", result.phase).eq("player_turn", result.player_turn);
  query = session.count === null ? query.is("count", null) : query.eq("count", session.count);
  query = previous == null ? query.is("game_data->>resolved_sequence", null)
    : query.eq("game_data->>resolved_sequence", previous);
  const { data: saved, error } = await query.select("*").maybeSingle();
  if (error) return { ok: false, error: error.message };
  // A simultaneous newer update won the compare-and-swap. Never overwrite it.
  if (!saved) return { ok: true };
  return { ok: true, saved: { ...result, gameData: saved.game_data } };
}
