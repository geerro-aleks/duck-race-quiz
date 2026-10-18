import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { ANSWER_SECONDS, MAX_PLAYERS, RACE_SECONDS, REVEAL_SECONDS, quiz } from "./quiz.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
let database;

function getDatabase() {
  if (!process.env.DATABASE_URL) {
    throw Object.assign(
      new Error("DATABASE_URL is not configured. Add your Neon connection string to the server environment."),
      { status: 503 }
    );
  }
  database ||= neon(process.env.DATABASE_URL);
  return database;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function fail(message, status) {
  return json({ error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createHostToken(hostKey, pin) {
  return crypto.createHmac("sha256", hostKey).update(`duck-race-host:${pin}`).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function ensureGame(sql) {
  const pin = process.env.GAME_PIN || String(100000 + crypto.randomInt(900000));
  if (!/^\d{6}$/.test(pin)) throw new Error("GAME_PIN must be exactly six digits.");
  await sql`
    INSERT INTO quiz_games (id, pin, phase, question_index)
    VALUES ('main', ${pin}, 'lobby', -1)
    ON CONFLICT (id) DO NOTHING
  `;
  const [game] = await sql`SELECT * FROM quiz_games WHERE id = 'main'`;
  if (!game) throw new Error("Could not initialize the preset quiz room.");
  return game;
}

async function getGame(sql, pin) {
  if (!/^\d{6}$/.test(pin)) return null;
  const [game] = await sql`SELECT * FROM quiz_games WHERE id = 'main' AND pin = ${pin}`;
  return game || null;
}

async function advanceGame(sql, pin) {
  const now = Date.now();

  await sql`
    UPDATE quiz_games
    SET phase = 'race',
        race_started_at = ${now},
        race_ends_at = ${now + RACE_SECONDS * 1000}
    WHERE id = 'main' AND pin = ${pin}
      AND phase = 'question' AND deadline <= ${now}
  `;

  const [expiredRace] = await sql`
    SELECT question_index
    FROM quiz_games
    WHERE id = 'main' AND pin = ${pin}
      AND phase = 'race' AND race_ends_at <= ${now}
  `;
  const correctIndex = expiredRace ? quiz[Number(expiredRace.question_index)].correct : null;
  await sql`
    WITH transitioned AS (
      UPDATE quiz_games
      SET phase = 'reveal',
          correct_index = ${correctIndex},
          deadline = ${now + REVEAL_SECONDS * 1000}
      WHERE id = 'main' AND pin = ${pin}
        AND phase = 'race' AND race_ends_at <= ${now} AND ${correctIndex} IS NOT NULL
      RETURNING pin, correct_index
    )
    UPDATE quiz_players AS players
    SET score = players.score + 100
    FROM transitioned
    WHERE players.game_pin = transitioned.pin
      AND players.answer_index = transitioned.correct_index
  `;

  const nextQuestionDeadline = now + ANSWER_SECONDS * 1000;
  await sql`
    WITH transitioned AS (
      UPDATE quiz_games
      SET phase = CASE
            WHEN question_index + 1 >= ${quiz.length} THEN 'finished'
            ELSE 'question'
          END,
          question_index = CASE
            WHEN question_index + 1 >= ${quiz.length} THEN question_index
            ELSE question_index + 1
          END,
          correct_index = NULL,
          deadline = CASE
            WHEN question_index + 1 >= ${quiz.length} THEN NULL
            ELSE ${nextQuestionDeadline}
          END,
          race_started_at = NULL,
          race_ends_at = NULL
      WHERE id = 'main' AND pin = ${pin}
        AND phase = 'reveal' AND deadline <= ${now}
      RETURNING pin, phase
    )
    UPDATE quiz_players AS players
    SET answer_index = NULL
    FROM transitioned
    WHERE players.game_pin = transitioned.pin
      AND transitioned.phase = 'question'
  `;
}

async function publicState(sql, game, role, token) {
  const ownHash = role === "player" ? hashToken(token) : null;
  const current = game.question_index >= 0 ? quiz[game.question_index] : null;
  let players = [];
  let ownPlayer = null;
  let playerCount = 0;
  let answerCount = 0;

  if (game.phase === "lobby" || game.phase === "reveal" || game.phase === "finished") {
    players = await sql`
      SELECT id, name, score, token_hash, answer_index
      FROM quiz_players WHERE game_pin = ${game.pin}
      ORDER BY score DESC, name ASC
    `;
    playerCount = players.length;
    answerCount = players.filter(player => player.answer_index !== null).length;
    ownPlayer = ownHash ? players.find(player => player.token_hash === ownHash) : null;
  } else if (role === "host") {
    const [counts] = await sql`
      SELECT COUNT(*)::int AS player_count,
             COUNT(answer_index)::int AS answer_count
      FROM quiz_players WHERE game_pin = ${game.pin}
    `;
    playerCount = counts.player_count;
    answerCount = counts.answer_count;
  } else {
    const [player] = await sql`
      SELECT id, name, score, token_hash, answer_index,
             (SELECT COUNT(*)::int FROM quiz_players WHERE game_pin = ${game.pin}) AS player_count
      FROM quiz_players
      WHERE game_pin = ${game.pin} AND token_hash = ${ownHash}
    `;
    ownPlayer = player || null;
    playerCount = ownPlayer ? ownPlayer.player_count : 0;
  }

  return {
    pin: game.pin,
    phase: game.phase,
    questionNumber: Number(game.question_index) + 1,
    questionTotal: quiz.length,
    players: players.map(({ id, name, score }) => ({ id, name, score })),
    playerCount,
    question: current ? { q: current.q, choices: current.choices } : null,
    score: ownPlayer ? ownPlayer.score : null,
    deadline: game.deadline === null ? null : Number(game.deadline),
    raceStartedAt: game.race_started_at === null ? null : Number(game.race_started_at),
    raceEndsAt: game.race_ends_at === null ? null : Number(game.race_ends_at),
    correctIndex: game.phase === "reveal" || game.phase === "finished" ? game.correct_index : null,
    answered: Boolean(ownPlayer?.answer_index !== null && ownPlayer?.answer_index !== undefined),
    answerCount,
    ...(role === "host" ? { role: "host" } : ownPlayer ? { role: "player", playerId: ownPlayer.id } : {})
  };
}

async function route(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const sql = getDatabase();

  if (request.method === "GET" && url.pathname === "/health") {
    await sql`SELECT 1`;
    return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (request.method === "POST" && url.pathname === "/api/host/session") {
    const hostKey = process.env.HOST_KEY;
    if (!hostKey) return fail("HOST_KEY is not configured on the server.", 503);
    const body = await readJson(request);
    if (typeof body.hostKey !== "string" || !safeEqual(body.hostKey, hostKey)) {
      return fail("The host key is incorrect.", 403);
    }
    const game = await ensureGame(sql);
    return json({ pin: game.pin, hostToken: createHostToken(hostKey, game.pin) });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const pin = (url.searchParams.get("pin") || "").trim();
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") || "";
    const game = await getGame(sql, pin);
    if (!game) return fail("Game not found. Check the PIN and make sure the quiz is hosted.", 404);
    if (role === "host") {
      if (!process.env.HOST_KEY || !safeEqual(token, createHostToken(process.env.HOST_KEY, pin))) {
        return fail("Invalid host session.", 403);
      }
    } else if (role === "player") {
      const [player] = await sql`
        SELECT id FROM quiz_players
        WHERE game_pin = ${pin} AND token_hash = ${hashToken(token)}
      `;
      if (!player) return fail("Player session not found. Join the game again.", 403);
    } else {
      return fail("Invalid session role.", 400);
    }
    await advanceGame(sql, pin);
    const [updatedGame] = await sql`SELECT * FROM quiz_games WHERE id = 'main' AND pin = ${pin}`;
    return json(await publicState(sql, updatedGame, role, token));
  }

  if (parts[0] !== "api" || parts[1] !== "games" || !parts[2] || parts[2].length !== 6) {
    return fail("API endpoint not found.", 404);
  }
  const pin = parts[2];
  const game = await getGame(sql, pin);
  if (!game) return fail("Game not found. Check the PIN and make sure the quiz is hosted.", 404);
  const body = request.method === "POST" ? await readJson(request) : {};
  await advanceGame(sql, pin);
  const [currentGame] = await sql`SELECT * FROM quiz_games WHERE id = 'main' AND pin = ${pin}`;

  if (request.method === "POST" && parts[3] === "join") {
    if (currentGame.phase !== "lobby") return fail("This quiz has already started.", 409);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 20) return fail("Enter a nickname between 1 and 20 characters.", 400);
    const id = crypto.randomUUID();
    const playerToken = crypto.randomBytes(32).toString("hex");
    try {
      const [player] = await sql`
        INSERT INTO quiz_players (id, game_pin, token_hash, name, score)
        SELECT ${id}, ${pin}, ${hashToken(playerToken)}, ${name}, 0
        WHERE EXISTS (
          SELECT 1 FROM quiz_games
          WHERE id = 'main' AND pin = ${pin} AND phase = 'lobby'
        )
          AND (SELECT COUNT(*) FROM quiz_players WHERE game_pin = ${pin}) < ${MAX_PLAYERS}
          RETURNING id
        `;
        if (!player) {
          const [latestGame] = await sql`SELECT phase FROM quiz_games WHERE id = 'main' AND pin = ${pin}`;
          if (latestGame?.phase !== "lobby") {
            return fail("The quiz started before you joined. Ask the host to restart it.", 409);
          }
          return fail(`This game has reached its ${MAX_PLAYERS}-player limit.`, 409);
        }
        return json({ playerToken, playerId: id }, 201);
    } catch (error) {
      if (error.code === "23505") return fail("That nickname is already in use in this game.", 409);
      throw error;
    }
  }

  if (request.method === "POST" && parts[3] === "start") {
    if (!process.env.HOST_KEY || !safeEqual(body.hostToken || "", createHostToken(process.env.HOST_KEY, pin))) {
      return fail("Only the host can start the quiz.", 403);
    }
    const now = Date.now();
    const [started] = await sql`
      UPDATE quiz_games
      SET phase = 'question', question_index = 0, deadline = ${now + ANSWER_SECONDS * 1000}
      WHERE id = 'main' AND pin = ${pin} AND phase = 'lobby'
        AND EXISTS (SELECT 1 FROM quiz_players WHERE game_pin = ${pin})
      RETURNING pin
    `;
    if (!started) {
      if (currentGame.phase !== "lobby") return fail("The quiz has already started.", 409);
      return fail("At least one player must join before starting.", 409);
    }
    return json({ ok: true });
  }

  if (request.method === "POST" && parts[3] === "reset") {
    if (!process.env.HOST_KEY || !safeEqual(body.hostToken || "", createHostToken(process.env.HOST_KEY, pin))) {
      return fail("Only the host can reset the quiz.", 403);
    }
    const [reset] = await sql`
      WITH reset_game AS (
        UPDATE quiz_games
        SET phase = 'lobby', question_index = -1, deadline = NULL,
            race_started_at = NULL, race_ends_at = NULL, correct_index = NULL
        WHERE id = 'main' AND pin = ${pin} AND phase = 'finished'
        RETURNING pin
      ),
      removed_players AS (
        DELETE FROM quiz_players
        USING reset_game
        WHERE quiz_players.game_pin = reset_game.pin
        RETURNING quiz_players.id
      )
      SELECT pin FROM reset_game
    `;
    if (!reset) return fail("The quiz can only be reset after it has finished.", 409);
    return json({ ok: true });
  }

  if (request.method === "POST" && parts[3] === "answer") {
    if (typeof body.playerToken !== "string") return fail("Player session not found. Join the game again.", 403);
    if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice > 3) {
      return fail("Select one of the four answer choices.", 400);
    }
    const now = Date.now();
    const [answer] = await sql`
      UPDATE quiz_players AS players
      SET answer_index = ${body.choice}
      FROM quiz_games AS games
      WHERE players.game_pin = ${pin}
        AND players.token_hash = ${hashToken(body.playerToken)}
        AND players.answer_index IS NULL
        AND games.id = 'main' AND games.pin = ${pin}
        AND games.phase = 'question' AND games.deadline > ${now}
      RETURNING players.id
    `;
    if (answer) return json({ ok: true });
    return fail("Your answer could not be recorded. Time may be up, or you may have already answered.", 409);
  }

  return fail("API endpoint not found.", 404);
}

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
        return await route(request);
      }
      if (request.method !== "GET") return fail("Method not allowed.", 405);
      const asset = url.pathname === "/" || url.pathname === "/index.html"
        ? "index.html"
        : url.pathname === "/assets/race-character.png"
          ? "assets/race-character.png"
          : null;
      if (!asset) return fail("Not found.", 404);
      const content = await fs.readFile(path.join(root, asset));
      const type = asset.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
      return new Response(content, {
        headers: {
          "Content-Type": type,
          "Cache-Control": asset.endsWith(".png") ? "public, max-age=86400" : "no-store"
        }
      });
    } catch (error) {
      if (error.status) return fail(error.message, error.status);
      console.error("Duck Race Quiz request failed:", error);
      return fail("The server could not complete the request. Check its configuration and logs.", 500);
    }
  }
};
