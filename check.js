const Database = require("better-sqlite3");

const db = new Database("spotify.db");

const rows = db.prepare(`
SELECT title, artist, played_at
FROM plays
ORDER BY played_at DESC
LIMIT 10
`).all();

console.log(rows);