import { Router, Request, Response } from "express";
import { Server } from "socket.io";
import { supabase } from "../supabase";

const SELECT_FIELDS =
  "id, created_at, user_id, game_data, card_activated, player_1, player_2, player_1_deck, player_2_deck, status, count";

// ── Types (mirrored from client) ──────────────────────────────────────────────

type DeckSlot = {
  suit: string;
  hero_id: number | null;
  user_card_hero_id: number | null;
  cards: (number | null)[];
  user_cards_id: (number | null)[];
};
type PlayerDeck = DeckSlot[];

type HeroCard = {
  hero_id: number;
  hero_suit_number: number;
  health: number;
  remaining_health: number;
  energy: number;
  shield: number;
  is_cannot_take_action: boolean;
  buffs: unknown[];
  debuffs: unknown[];
  status: { silence: boolean; stun: boolean; taunt: boolean; veil: boolean };
};

type PlayerCard = {
  card_id: number;
  user_card_id: number;
  card_suit_index: number;
  player_owner: number;
  hero_id: number;
};

type PlayerData = {
  deck_cards: PlayerCard[];
  hand_cards: PlayerCard[];
  field_cards: (HeroCard | null)[];
  field_buff_cards: null[];
  field_debuff_cards: null[];
  void_cards: never[];
  game_state: never[];
};

type GameData = {
  sequence: number;
  player_1: PlayerData;
  player_2: PlayerData;
};

type Card = {
  id: number;
  card_type: "hero" | "spell" | "equip";
  health?: number;
  energy?: number;
};

type CardActivated = {
  sequence: number;
  played_card: PlayerCard | null;
  player_key: "player_1" | "player_2" | null;
  targer_slot: number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const extractIds = (deck: PlayerDeck | null): number[] =>
  (deck ?? [])
    .flatMap((slot) => [slot.hero_id, ...slot.cards])
    .filter((id): id is number => id !== null);

const fetchCards = async (ids: number[]): Promise<Card[]> => {
  if (ids.length === 0) return [];
  const { data } = await supabase.from("cards").select("*").in("id", ids);
  return (data ?? []) as Card[];
};

const buildDeckCards = (
  deck: PlayerDeck,
  playerOwner: number,
  cards: Card[]
): PlayerCard[] =>
  deck.flatMap((slot) =>
    slot.cards.flatMap((card_id, cardIndex) => {
      const user_card_id = slot.user_cards_id[cardIndex];
      if (card_id === null || user_card_id === null || slot.hero_id === null)
        return [];
      return [
        {
          card_id,
          user_card_id,
          card_suit_index: cardIndex + 2,
          player_owner: playerOwner,
          hero_id: slot.hero_id
        }
      ];
    })
  );

const buildFieldCards = (deck: PlayerDeck, cards: Card[]): HeroCard[] =>
  deck.flatMap((slot, suitIndex) => {
    if (slot.hero_id === null) return [];
    const hero = cards.find(
      (c) => c.id === slot.hero_id && c.card_type === "hero"
    );
    return [
      {
        hero_id: slot.hero_id,
        hero_suit_number: suitIndex,
        health: hero?.health ?? 100,
        remaining_health: hero?.health ?? 100,
        energy: hero?.energy ?? 3,
        shield: 0,
        is_cannot_take_action: false,
        buffs: [],
        debuffs: [],
        status: { silence: false, stun: false, taunt: false, veil: false }
      }
    ];
  });

const emptyPlayerData = (): PlayerData => ({
  deck_cards: [],
  hand_cards: [],
  field_cards: [],
  field_buff_cards: [],
  field_debuff_cards: [],
  void_cards: [],
  game_state: []
});

// ── Router factory ────────────────────────────────────────────────────────────

export const createSessionsRouter = (io: Server): Router => {
  const router = Router();

  // POST /api/sessions/join-or-create
  router.post("/join-or-create", async (req: Request, res: Response) => {
    const { playerId, playerDeck } = req.body as {
      playerId: string;
      playerDeck: PlayerDeck;
    };
    // console.log("playerDeck", playerDeck);
    // console.log("playerId", playerId);
    if (!playerId || !playerDeck) {
      res.status(400).json({ error: "playerId and playerDeck are required" });
      return;
    }

    try {
      // Look for a waiting session not owned by this player
      const { data: waiting, error: fetchError } = await supabase
        .from("battle_sessions")
        .select(SELECT_FIELDS)
        .eq("status", "waiting")
        .neq("player_1", playerId)
        .limit(1)
        .maybeSingle();

      if (fetchError) {
        res.status(500).json({ error: fetchError.message });
        return;
      }

      if (waiting) {
        // ── Join as player_2 ──────────────────────────────────────────────
        const ids = [
          ...new Set([
            ...extractIds(waiting.player_1_deck),
            ...extractIds(playerDeck)
          ])
        ];
        const cards = await fetchCards(ids);

        const p1All = buildDeckCards(waiting.player_1_deck ?? [], 1, cards);
        const p2All = buildDeckCards(playerDeck, 2, cards);

        const game_data: GameData = {
          sequence: 0,
          player_1: {
            deck_cards: p1All.slice(10),
            hand_cards: p1All.slice(0, 10),
            field_cards: buildFieldCards(waiting.player_1_deck ?? [], cards),
            field_buff_cards: [],
            field_debuff_cards: [],
            void_cards: [],
            game_state: []
          },
          player_2: {
            deck_cards: p2All.slice(10),
            hand_cards: p2All.slice(0, 10),
            field_cards: buildFieldCards(playerDeck, cards),
            field_buff_cards: [],
            field_debuff_cards: [],
            void_cards: [],
            game_state: []
          }
        };

        const { data, error } = await supabase
          .from("battle_sessions")
          .update({
            player_2: playerId,
            player_2_deck: playerDeck,
            status: "ready",
            game_data,
            count: (waiting.count ?? 0) + 1
          })
          .eq("id", waiting.id)
          .select(SELECT_FIELDS)
          .single();

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }

        // Broadcast to session room (player_1 is already listening there)
        // io.to(`session:${waiting.id}`).emit("session:updated", data);
        // Also notify via user rooms for the debug screen
        // io.to(`user:${waiting.player_1}`).emit("session:updated", data);
        // io.to(`user:${playerId}`).emit("session:updated", data);

        res.json({ session: data, role: "player_2" });
        return;
      }

      // ── Create as player_1 ────────────────────────────────────────────────
      const ids = [...new Set(extractIds(playerDeck))];
      const cards = await fetchCards(ids);
      const p1All = buildDeckCards(playerDeck, 1, cards);

      const game_data: GameData = {
        sequence: 0,
        player_1: {
          deck_cards: p1All.slice(10),
          hand_cards: p1All.slice(0, 10),
          field_cards: buildFieldCards(playerDeck, cards),
          field_buff_cards: [],
          field_debuff_cards: [],
          void_cards: [],
          game_state: []
        },
        player_2: emptyPlayerData()
      };

      const { data, error } = await supabase
        .from("battle_sessions")
        .insert({
          player_1: playerId,
          player_1_deck: playerDeck,
          status: "waiting",
          game_data,
          count: 1
        })
        .select(SELECT_FIELDS)
        .single();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ session: data, role: "player_1" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id
  router.get("/:id", async (req: Request, res: Response) => {
    const { data, error } = await supabase
      .from("battle_sessions")
      .select(SELECT_FIELDS)
      .eq("id", req.params.id)
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  });

  // PATCH /api/sessions/:id/update  — card played, game_data changed
  router.patch("/:id/update", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const {
      gameData,
      activatedCard,
      count
    }: { gameData: GameData; activatedCard: CardActivated; count: number } =
      req.body;

    const { data, error } = await supabase
      .from("battle_sessions")
      .update({
        game_data: gameData,
        card_activated: [activatedCard],
        count
      })
      .eq("id", id)
      .select(SELECT_FIELDS)
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    io.to(`session:${id}`).emit("receive:session", data);
    res.json(data);
  });

  // PATCH /api/sessions/:id/sequence  — append card_activated via DB trigger
  // for remove

  // PATCH /api/sessions/:id/end
  router.patch("/:id/end", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);

    const { error } = await supabase
      .from("battle_sessions")
      .update({ status: "ended" })
      .eq("id", id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    io.to(`session:${id}`).emit("session:ended", { id });
    res.json({ success: true });
  });

  return router;
};
