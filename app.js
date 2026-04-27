// app.js

// Webサーバー用
const express = require("express");

// ファイル操作用。tokens.json保存に使う
const fs = require("fs");

// .env読み込み
require("dotenv").config();

// PostgreSQL接続用
const { Pool } = require("pg");

// Express開始
const app = express();

// ポート番号
const PORT = 3000;

// Spotify認証情報
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Neon接続情報
const DATABASE_URL = process.env.DATABASE_URL;

// Spotify権限
const SCOPE = "user-read-recently-played";

// token保存ファイル
const TOKEN_FILE = "tokens.json";

// Neon/PostgreSQL接続
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// HTMLで危険な文字を無害化する
function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// DBテーブル作成
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plays (
      play_key TEXT PRIMARY KEY,
      played_at TIMESTAMPTZ,
      track_id TEXT,
      title TEXT,
      artist TEXT,
      album TEXT,
      image_url TEXT,
      spotify_url TEXT
    )
  `);
}

// tokens.json読み込み
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

// tokens.json保存
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

// 有効なaccess_token取得
async function getValidAccessToken() {
  const tokens = loadTokens();

  if (!tokens) return null;

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

// Spotifyから最近50件取得
async function getRecentTracks() {
  const token = await getValidAccessToken();

  if (!token) return [];

  const res = await fetch(
    "https://api.spotify.com/v1/me/player/recently-played?limit=50",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) return [];

  const data = await res.json();

  return data.items;
}

// Spotify履歴をNeon DBに保存
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

// トップページ
app.get("/", async (req, res) => {
  const tokens = loadTokens();

  if (!tokens) {
    return res.send(`
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body{background:#121212;color:white;font-family:Arial;padding:40px;}
          a{background:#1DB954;color:white;padding:14px 22px;border-radius:999px;text-decoration:none;font-weight:bold;}
        </style>
      </head>
      <body>
        <h1>🎧 Shu Spotify Stats</h1>
        <p>Spotifyにログインしてください。</p>
        <a href="/login">Spotifyでログイン</a>
      </body>
      </html>
    `);
  }

  // ページを開くたびにSpotifyからNeonへ保存
  const savedCount = await syncSpotifyToDb();

  // 今日の再生数 JST基準
  const todayCountResult = await pool.query(`
    SELECT COUNT(*) AS count
    FROM plays
    WHERE (played_at AT TIME ZONE 'Asia/Tokyo')::date =
          (NOW() AT TIME ZONE 'Asia/Tokyo')::date
  `);

  const todayCount = todayCountResult.rows[0].count;

  // 総再生数
  const totalCountResult = await pool.query(`
    SELECT COUNT(*) AS count
    FROM plays
  `);

  const totalCount = totalCountResult.rows[0].count;

  // 最近聴いた曲
  const recentResult = await pool.query(`
    SELECT *
    FROM plays
    ORDER BY played_at DESC
    LIMIT 30
  `);

  const recentRows = recentResult.rows;

  // 曲ランキング
  const rankingResult = await pool.query(`
    SELECT
      track_id,
      title,
      artist,
      MAX(image_url) AS image_url,
      MAX(spotify_url) AS spotify_url,
      COUNT(*) AS plays
    FROM plays
    GROUP BY track_id, title, artist
    ORDER BY plays DESC
    LIMIT 20
  `);

  const rankingRows = rankingResult.rows;

  res.send(`
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body{
          background:#121212;
          color:white;
          font-family:Arial;
          padding:30px;
        }

        h1{
          color:#1DB954;
        }

        a{
          color:#1DB954;
        }

        .card{
          background:#1e1e1e;
          padding:20px;
          border-radius:14px;
          margin-bottom:20px;
        }

        .track{
          display:flex;
          gap:14px;
          align-items:center;
          margin-bottom:16px;
        }

        img{
          border-radius:8px;
        }

        small{
          color:#aaa;
        }
      </style>
    </head>

    <body>
      <h1>🎧 Shu Spotify Stats</h1>

      <p>
        <a href="/sync">手動同期</a> |
        <a href="/logout">ログアウト</a>
      </p>

      <div class="card">
        <h2>保存状況</h2>
        <p>今回新しく保存した曲数: ${savedCount}</p>
        <p>Neon DB内の総再生数: ${totalCount}</p>
      </div>

      <div class="card">
        <h2>今日の視聴曲数</h2>
        <p>${todayCount}</p>
      </div>

      <div class="card">
        <h2>最近聴いた曲</h2>
        ${recentRows
          .map(
            (row) => `
              <div class="track">
                ${
                  row.image_url
                    ? `<img src="${row.image_url}" width="70" height="70">`
                    : ""
                }

                <div>
                  <strong>${escapeHtml(row.title)}</strong><br>
                  ${escapeHtml(row.artist)}<br>
                  <small>${escapeHtml(row.album)}</small><br>
                  <small>${new Date(row.played_at).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}</small><br>
                  <a href="${row.spotify_url}" target="_blank">Spotifyで開く</a>
                </div>
              </div>
            `
          )
          .join("")}
      </div>

      <div class="card">
        <h2>曲ランキング</h2>
        <ol>
          ${rankingRows
            .map(
              (row) => `
                <li class="track">
                  ${
                    row.image_url
                      ? `<img src="${row.image_url}" width="50" height="50">`
                      : ""
                  }

                  <div>
                    <strong>${escapeHtml(row.title)}</strong><br>
                    ${escapeHtml(row.artist)}<br>
                    <small>${row.plays}回</small><br>
                    <a href="${row.spotify_url}" target="_blank">Spotifyで開く</a>
                  </div>
                </li>
              `
            )
            .join("")}
        </ol>
      </div>
    </body>
    </html>
  `);
});

// 手動同期
app.get("/sync", async (req, res) => {
  const savedCount = await syncSpotifyToDb();

  res.send(`
    <p>${savedCount}件、新しくNeon DBへ保存しました。</p>
    <p><a href="/">戻る</a></p>
  `);
});

// Spotifyログイン開始
app.get("/login", (req, res) => {
  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
    });

  res.redirect(authUrl);
});

// Spotifyログイン後
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) return res.send("code がありません。");

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    return res.send(`<pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
  }

  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + 55 * 60 * 1000,
  };

  saveTokens(tokens);

  res.redirect("/");
});

// ログアウト
app.get("/logout", (req, res) => {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  res.redirect("/");
});

// サーバー起動前にDB準備
initDb().then(() => {
  app.listen(PORT, () => {
    console.log("Neon版で起動しました");
    console.log(`http://localhost:${PORT}`);
  });
});