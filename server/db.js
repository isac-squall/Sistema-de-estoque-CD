import Database from "better-sqlite3";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SQLITE_PATH || join(__dirname, "data", "estoque.db");

export function openDb() {
  const dir = dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seedIfEmpty(db);
  return db;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrateV2(db) {
  const mCols = tableColumns(db, "movements");
  if (!mCols.includes("product_code")) {
    db.exec("ALTER TABLE movements ADD COLUMN product_code TEXT");
  }
  if (!mCols.includes("stock_effect_applied")) {
    db.exec("ALTER TABLE movements ADD COLUMN stock_effect_applied INTEGER NOT NULL DEFAULT 0");
  }
  const aCols = tableColumns(db, "approvals");
  if (!aCols.includes("movement_id")) {
    db.exec("ALTER TABLE approvals ADD COLUMN movement_id INTEGER REFERENCES movements(id)");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_one_movement ON approvals(movement_id) WHERE movement_id IS NOT NULL",
  );
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operador',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      batch TEXT,
      expiry_date TEXT,
      min_qty INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      qty INTEGER NOT NULL,
      stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
      notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Aguardando',
      requested_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cycle_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      expected_qty INTEGER NOT NULL,
      counted_qty INTEGER,
      session_id TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      payload_before TEXT,
      payload_after TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS movement_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
      qty INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ma_movement ON movement_allocations(movement_id);
  `);
  migrateV2(db);
}

function seedIfEmpty(db) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (row.c > 0) return;

  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10);
  const r = db
    .prepare("INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)")
    .run("admin", hash, "Administrador", "admin");
  const adminId = r.lastInsertRowid;

  const stock = [
    ["8908.84", "Ristretto", "Capsulas", "3A", 300620, 0, 0.88, "LT-2026-01", "2026-08-18", 5000],
    ["8908.84", "Ristretto", "Capsulas", "3XA", 168750, 0, 0.88, "LT-2026-02", "2026-07-05", 5000],
    ["8908.84", "Ristretto", "Capsulas", "30A", 139250, 0, 0.88, "LT-2026-03", "2026-07-02", 5000],
    ["8908.84", "Ristretto", "Capsulas", "3AV", 25000, 0, 0.88, "LT-2026-04", "2026-06-16", 5000],
    ["8908.84", "Ristretto", "Capsulas", "2A", 750, 0, 0.88, "LT-2026-05", "2026-05-27", 5000],
  ];
  const insStock = db.prepare(
    `INSERT INTO stock_items (code, name, category, location, qty, reserved, unit_price, batch, expiry_date, min_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of stock) insStock.run(...s);

  const movs = [
    ["PED-206-001", "Saida", "Concluido", 20, null, "8908.84", 1],
    ["PED-206-002", "Saida", "Em separacao", 2, null, "8908.84", 0],
    ["REC-206-001", "Entrada", "Concluido", 300, null, null, 1],
    ["PED-206-003", "Saida", "Pendente", 50, null, "8908.84", 0],
  ];
  const insMov = db.prepare(
    `INSERT INTO movements (ref, type, status, qty, stock_item_id, product_code, notes, created_by, stock_effect_applied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of movs) insMov.run(m[0], m[1], m[2], m[3], m[4], m[5], null, adminId, m[6]);

  const appr = [
    ["Ajuste manual de estoque lote LT-2026-04", "Aguardando"],
    ["Liberacao de transferencia 3A -> 2A", "Aprovado"],
  ];
  const insAp = db.prepare("INSERT INTO approvals (request_text, status, requested_by) VALUES (?, ?, ?)");
  for (const a of appr) insAp.run(a[0], a[1], adminId);

  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, payload_after)
     VALUES (?, 'SEED', 'system', 'bootstrap', ?)`,
  ).run(adminId, JSON.stringify({ message: "Banco inicializado com dados de demonstracao" }));
}
