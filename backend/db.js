"use strict";

// MySQL app database. Holds accounts and owner-submitted station listings.
// Connection via DATABASE_URL (e.g. mysql://root:pass@localhost:3306/voltroute);
// schema is created on boot with retry. If MySQL is unreachable, account/listing
// endpoints fail gracefully while the core station/map/routing APIs keep working
// (they never require the database — community listings simply resolve to []).

const mysql = require("mysql2/promise");

const DATABASE_URL = process.env.DATABASE_URL || "mysql://root:@localhost:3306/voltroute";

let pool = null;
let schemaReady = false;
let initPromise = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000,
      queueLimit: 0,
    });
    pool.on("error", (err) => console.error("[db] pool error:", err.message));
  }
  return pool;
}

// MySQL has no CREATE INDEX IF NOT EXISTS: ignore duplicate-key (1061) errors.
// Duplicate table (1050) and duplicate column (1060) are also safe to ignore.
async function ignoreDup(err) {
  if (!err) return;
  const dup = new Set([1050, 1061, 1060]);
  if (dup.has(err.errno)) return;
  throw err;
}

async function run(sql) {
  try {
    await getPool().query(sql);
  } catch (err) {
    await ignoreDup(err);
  }
}

async function ensureListingColumns() {
  const [rows] = await getPool().query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'station_listings'`
  );
  const have = new Set(rows.map((row) => row.COLUMN_NAME));
  const additions = [
    ["phone", "phone VARCHAR(30) NOT NULL DEFAULT ''"],
    ["city", "city VARCHAR(80) NOT NULL DEFAULT 'Bengaluru'"],
    ["state", "state VARCHAR(80) NOT NULL DEFAULT 'Karnataka'"],
    ["postal_code", "postal_code VARCHAR(20) NOT NULL DEFAULT ''"],
    ["charging_points", "charging_points INT DEFAULT NULL"],
    ["tariff", "tariff VARCHAR(80) NOT NULL DEFAULT ''"],
    ["opening_hours", "opening_hours VARCHAR(120) NOT NULL DEFAULT ''"],
    ["operational_status", "operational_status VARCHAR(30) NOT NULL DEFAULT 'operational'"],
    ["image_url", "image_url VARCHAR(500) NOT NULL DEFAULT ''"],
  ];
  for (const [name, ddl] of additions) {
    if (have.has(name)) continue;
    try {
      await getPool().query(`ALTER TABLE station_listings ADD COLUMN ${ddl}`);
    } catch (err) {
      await ignoreDup(err);
    }
  }
}

async function migrate() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'owner') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
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
      power_kw DOUBLE DEFAULT NULL,
      operator VARCHAR(80) NOT NULL DEFAULT '',
      status ENUM('pending', 'approved') NOT NULL DEFAULT 'approved',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      phone VARCHAR(30) NOT NULL DEFAULT '',
      city VARCHAR(80) NOT NULL DEFAULT 'Bengaluru',
      state VARCHAR(80) NOT NULL DEFAULT 'Karnataka',
      postal_code VARCHAR(20) NOT NULL DEFAULT '',
      charging_points INT DEFAULT NULL,
      tariff VARCHAR(80) NOT NULL DEFAULT '',
      opening_hours VARCHAR(120) NOT NULL DEFAULT '',
      operational_status VARCHAR(30) NOT NULL DEFAULT 'operational',
      image_url VARCHAR(500) NOT NULL DEFAULT '',
      CONSTRAINT fk_listings_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureListingColumns();
  await run("CREATE INDEX idx_listings_status ON station_listings(status)");
  await run("CREATE INDEX idx_listings_owner ON station_listings(owner_id)");
}

// Retry schema setup up to 3 times with backoff. After the first success it is
// a no-op. A failed boot does not poison later requests — each account/listing
// endpoint calls initDb() again and will succeed once MySQL recovers.
function initDb() {
  if (schemaReady) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await migrate();
        schemaReady = true;
        return;
      } catch (err) {
        lastErr = err;
        console.error(`[db] schema attempt ${attempt}/3 failed:`, err.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw lastErr;
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

// Lightweight connectivity check: returns true if MySQL can answer SELECT 1.
async function healthCheck() {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

module.exports = { getPool, initDb, healthCheck, toPublicUser };
