// sync.js

// .env 読み込み
require("dotenv").config();

// ファイル操作
const fs = require("fs");

// PostgreSQL
const { Pool } = require("pg");

// Spotify認証情報
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// token保存ファイル
const TOKEN_FILE = "tokens.json";

// Neon接続
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// token読み込み
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

// token保存
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

// access_token更新
async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.access_token;
}

// 有効token取得
async function getValidAccessToken() {
  const tokens = loadTokens();

  if (!tokens) {
    throw new Error("tokens.json がありません");
  }

  if (Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }

  const newAccessToken = await refreshAccessToken(tokens.refresh_token);

  const newTokens = {
    ...tokens,
    access_token: newAccessToken,
    expires_at: Date.now() + 55 * 60 * 1000,
  };

  saveTokens(newTokens);

  return newAccessToken;
}

// Spotify最近50件取得
async function getRecentTracks() {
  const token = await getValidAccessToken();

  const res = await fetch(
    "https://api.spotify.com/v1/me/player/recently-played?limit=50",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error("Spotify取得失敗");
  }

  const data = await res.json();

  return data.items;
}

// DB保存
async function syncSpotifyToDb() {
  const tracks = await getRecentTracks();

  let savedCount = 0;

  for (const item of tracks) {
    const track = item.track;

    const playedAt = item.played_at;
    const trackId = track.id;
    const playKey = `${playedAt}_${trackId}`;

    const title = track.name;
    const artist = track.artists.map((a) => a.name).join(", ");
    const album = track.album.name;

    const imageUrl =
      track.album.images?.[1]?.url ||
      track.album.images?.[0]?.url ||
      "";

    const spotifyUrl = track.external_urls.spotify;

    const result = await pool.query(
      `
      INSERT INTO plays
      (
        play_key,
        played_at,
        track_id,
        title,
        artist,
        album,
        image_url,
        spotify_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (play_key) DO NOTHING
      `,
      [
        playKey,
        playedAt,
        trackId,
        title,
        artist,
        album,
        imageUrl,
        spotifyUrl,
      ]
    );

    if (result.rowCount > 0) {
      savedCount++;
    }
  }

  return savedCount;
}

// 実行
(async () => {
  try {
    const saved = await syncSpotifyToDb();

    console.log(`同期成功: ${saved}件 保存`);

    await pool.end();

    process.exit(0);
  } catch (error) {
    console.error("同期失敗:", error.message);

    await pool.end();

    process.exit(1);
  }
})();