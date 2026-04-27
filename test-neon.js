// test-neon.js

// .envを読み込む
require("dotenv").config();

// PostgreSQL接続用
const { Pool } = require("pg");

// NeonのDATABASE_URLで接続
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// 接続テスト
async function test() {
  const result = await pool.query("SELECT NOW()");
  console.log("Neon接続成功:", result.rows[0]);
  await pool.end();
}

test();