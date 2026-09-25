"use strict";

// MySQL app database. Holds accounts and owner-submitted station listings.
// Connection via DATABASE_URL (e.g. mysql://root:pass@localhost:3306/voltroute);
// schema is created on boot. If MySQL is unreachable, account/listing endpoints
// fail gracefully while the core station/map/routing APIs keep working (they
// never require the database — community listings simply resolve to []).

const mysql = require("mysql2/promise");

const DATABASE_URL = process.env.DATABASE_URL || "mysql://root:@localhost:3306/voltroute";

let pool = null;
let initAttempted = false;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000,
    });
    pool.on("error", (err) => console.error("[db] pool error:", err.message));
  }
  return pool;
}

async function initDb() {
  if (initAttempted) return;
  initAttempted = true;
  const pool = getPool();
  // MySQL has no CREATE INDEX IF NOT EXISTS: ignore duplicate-key (1061) errors.
  const run = async (sql) => {
    try {
      await pool.query(sql);
    } catch (err) {
      if (!err || err.errno !== 1061) throw err;
    }
  };
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'owner') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS station_listings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      lat DOUBLE NOT NULL,
      lng DOUBLE NOT NULL,
      address VARCHAR(200) NOT NULL DEFAULT '',
      connectors TEXT NOT NULL,
      power_kw DOUBLE NULL,
      operator VARCHAR(80) NOT NULL DEFAULT '',
      status ENUM('pending', 'approved') NOT NULL DEFAULT 'approved',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_listings_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run("CREATE INDEX idx_listings_status ON station_listings(status)");
  await run("CREATE INDEX idx_listings_owner ON station_listings(owner_id)");
}

function toPublicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at };
}

module.exports = { getPool, initDb, toPublicUser };
