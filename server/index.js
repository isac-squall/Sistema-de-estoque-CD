import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { openDb } from "./db.js";
import { writeAudit } from "./audit.js";
import { signToken, authMiddleware } from "./auth.js";
import { movementNeedsApproval, tryApplyMovementStock } from "./movementService.js";
import { buildNessoftCsv } from "./nessoftExport.js";

const PORT = Number(process.env.PORT) || 3001;
const db = openDb();
const requireAuth = authMiddleware(db);
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function daysUntilExpiry(isoDate) {
  if (!isoDate) return null;
  const end = new Date(`${isoDate}T12:00:00`);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function stockStatus(row) {
  const d = daysUntilExpiry(row.expiry_date);
  if (d !== null && d <= 30) return "Critico";
  if (d !== null && d <= 60) return "Atencao";
  return "Normal";
}

function mapStock(row) {
  const expiryDays = daysUntilExpiry(row.expiry_date);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    location: row.location,
    qty: row.qty,
    reserved: row.reserved,
    unit: row.unit_price,
    batch: row.batch,
    expiry_date: row.expiry_date,
    expiryDays,
    min_qty: row.min_qty,
    status: stockStatus(row),
  };
}

function mapMovementRow(m) {
  return {
    id: m.ref,
    dbId: m.id,
    date: m.created_at,
    qty: m.qty,
    type: m.type,
    status: m.status,
    owner: m.owner_name,
    stock_item_id: m.stock_item_id,
    product_code: m.product_code,
    notes: m.notes,
    stock_effect_applied: !!m.stock_effect_applied,
    approvalDbId: m.approval_db_id ?? null,
    approvalStatus: m.approval_status ?? null,
    fefoLines:
      m.alloc_count != null && Number(m.alloc_count) > 0 ? Number(m.alloc_count) : null,
  };
}

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Usuario e senha obrigatorios" });
  }
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    writeAudit(db, {
      userId: user?.id ?? null,
      action: "LOGIN_FAIL",
      entityType: "user",
      entityId: username,
      after: { username },
      req,
    });
    return res.status(401).json({ error: "Credenciais invalidas" });
  }
  const token = signToken({ sub: user.id, username: user.username });
  writeAudit(db, {
    userId: user.id,
    action: "LOGIN",
    entityType: "user",
    entityId: user.id,
    after: { username: user.username },
    req,
  });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
    },
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/stock-items", requireAuth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM stock_items ORDER BY location, id").all();
  res.json(rows.map(mapStock));
});

app.post("/api/stock-items", requireAuth, (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "").trim();
  const name = String(b.name || "").trim();
  if (!code || !name) return res.status(400).json({ error: "code e name obrigatorios" });
  const r = db
    .prepare(
      `INSERT INTO stock_items (code, name, category, location, qty, reserved, unit_price, batch, expiry_date, min_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      code,
      name,
      String(b.category || "").trim() || "Geral",
      String(b.location || "").trim() || "—",
      Number(b.qty) || 0,
      Number(b.reserved) || 0,
      Number(b.unit_price ?? b.unit) || 0,
      b.batch ? String(b.batch) : null,
      b.expiry_date ? String(b.expiry_date) : null,
      Number(b.min_qty) || 0,
    );
  const row = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(r.lastInsertRowid);
  writeAudit(db, {
    userId: req.user.id,
    action: "CREATE",
    entityType: "stock_item",
    entityId: row.id,
    after: mapStock(row),
    req,
  });
  res.status(201).json(mapStock(row));
});

app.patch("/api/stock-items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "Nao encontrado" });
  const b = req.body || {};
  const fields = [];
  const vals = [];
  const map = {
    code: "code",
    name: "name",
    category: "category",
    location: "location",
    qty: "qty",
    reserved: "reserved",
    unit_price: "unit_price",
    unit: "unit_price",
    batch: "batch",
    expiry_date: "expiry_date",
    min_qty: "min_qty",
  };
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) {
      fields.push(`${col} = ?`);
      vals.push(col === "qty" || col === "reserved" || col === "min_qty" ? Number(b[k]) : b[k]);
    }
  }
  if (!fields.length) return res.json(mapStock(before));
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE stock_items SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  const after = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id);
  writeAudit(db, {
    userId: req.user.id,
    action: "UPDATE",
    entityType: "stock_item",
    entityId: id,
    before: mapStock(before),
    after: mapStock(after),
    req,
  });
  res.json(mapStock(after));
});

app.get("/api/movements", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, u.display_name AS owner_name,
        a.id AS approval_db_id, a.status AS approval_status,
        (SELECT COUNT(*) FROM movement_allocations ma WHERE ma.movement_id = m.id) AS alloc_count
       FROM movements m
       JOIN users u ON u.id = m.created_by
       LEFT JOIN approvals a ON a.movement_id = m.id
       ORDER BY m.created_at DESC`,
    )
    .all();
  res.json(rows.map(mapMovementRow));
});

app.post("/api/movements", requireAuth, (req, res) => {
  const b = req.body || {};
  const ref = String(b.ref || "").trim();
  const type = String(b.type || "").trim();
  if (!ref || !type) return res.status(400).json({ error: "ref e type obrigatorios" });
  let status = String(b.status || "Pendente").trim();
  const qty = Number(b.qty) || 0;
  const stockItemId = b.stock_item_id != null && b.stock_item_id !== "" ? Number(b.stock_item_id) : null;
  const productCode = b.product_code != null && b.product_code !== "" ? String(b.product_code).trim() : null;
  const skipApproval = b.skip_approval === true && req.user.role === "admin";
  const needsFlow = movementNeedsApproval(type) && !skipApproval;

  if (type === "Saida" && !stockItemId && !productCode) {
    return res.status(400).json({ error: "Saida exige product_code (FEFO) ou stock_item_id" });
  }
  if (type === "Ajuste" && !stockItemId) {
    return res.status(400).json({ error: "Ajuste exige stock_item_id" });
  }
  if (type === "Entrada" && status === "Concluido" && !stockItemId) {
    return res.status(400).json({ error: "Entrada concluida exige stock_item_id" });
  }

  if (needsFlow) {
    status = "Aguardando aprovacao";
  }

  let movementId;
  try {
    const r = db
      .prepare(
        `INSERT INTO movements (ref, type, status, qty, stock_item_id, product_code, notes, created_by, stock_effect_applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(ref, type, status, qty, stockItemId, productCode, b.notes ? String(b.notes) : null, req.user.id);
    movementId = r.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Referencia ja existe" });
    }
    throw e;
  }

  writeAudit(db, {
    userId: req.user.id,
    action: "CREATE",
    entityType: "movement",
    entityId: movementId,
    after: {
      ref,
      type,
      status,
      qty,
      stock_item_id: stockItemId,
      product_code: productCode,
      needs_approval: needsFlow,
    },
    req,
  });

  if (needsFlow) {
    const reqText = `${type} ${ref} — ${qty} un.${productCode ? ` SKU ${productCode}` : ""}${stockItemId ? ` linha #${stockItemId}` : ""}`;
    const ap = db
      .prepare(
        "INSERT INTO approvals (request_text, status, requested_by, movement_id) VALUES (?, 'Aguardando', ?, ?)",
      )
      .run(reqText, req.user.id, movementId);
    writeAudit(db, {
      userId: req.user.id,
      action: "CREATE",
      entityType: "approval",
      entityId: ap.lastInsertRowid,
      after: { request_text: reqText, movement_id: movementId },
      req,
    });
  } else if (status === "Concluido") {
    try {
      tryApplyMovementStock(db, movementId, req.user.id, req);
    } catch (err) {
      db.prepare("DELETE FROM movements WHERE id = ?").run(movementId);
      return res.status(422).json({ error: err.message || "Nao foi possivel aplicar estoque" });
    }
  }

  const row = db
    .prepare(
      `SELECT m.*, u.display_name AS owner_name,
        a.id AS approval_db_id, a.status AS approval_status,
        (SELECT COUNT(*) FROM movement_allocations ma WHERE ma.movement_id = m.id) AS alloc_count
       FROM movements m
       JOIN users u ON u.id = m.created_by
       LEFT JOIN approvals a ON a.movement_id = m.id
       WHERE m.id = ?`,
    )
    .get(movementId);
  res.status(201).json(mapMovementRow(row));
});

app.patch("/api/movements/:dbId", requireAuth, (req, res) => {
  const dbId = Number(req.params.dbId);
  const before = db.prepare("SELECT * FROM movements WHERE id = ?").get(dbId);
  if (!before) return res.status(404).json({ error: "Nao encontrado" });
  const b = req.body || {};
  const status = b.status != null ? String(b.status) : before.status;

  if (status === "Concluido" && before.status === "Aguardando aprovacao") {
    return res.status(400).json({ error: "Conclua pela fila de aprovacoes" });
  }

  db.prepare("UPDATE movements SET status = ? WHERE id = ?").run(status, dbId);

  if (status === "Concluido" && !before.stock_effect_applied) {
    try {
      tryApplyMovementStock(db, dbId, req.user.id, req);
    } catch (err) {
      db.prepare("UPDATE movements SET status = ? WHERE id = ?").run(before.status, dbId);
      return res.status(422).json({ error: err.message || "Nao foi possivel aplicar estoque" });
    }
  }

  const after = db.prepare("SELECT * FROM movements WHERE id = ?").get(dbId);
  writeAudit(db, {
    userId: req.user.id,
    action: "UPDATE",
    entityType: "movement",
    entityId: dbId,
    before,
    after,
    req,
  });
  const row = db
    .prepare(
      `SELECT m.*, u.display_name AS owner_name,
        a.id AS approval_db_id, a.status AS approval_status,
        (SELECT COUNT(*) FROM movement_allocations ma WHERE ma.movement_id = m.id) AS alloc_count
       FROM movements m
       JOIN users u ON u.id = m.created_by
       LEFT JOIN approvals a ON a.movement_id = m.id
       WHERE m.id = ?`,
    )
    .get(dbId);
  res.json(mapMovementRow(row));
});

app.get("/api/approvals", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.display_name AS requested_by_name
       FROM approvals a
       JOIN users u ON u.id = a.requested_by
       ORDER BY a.created_at DESC`,
    )
    .all();
  res.json(
    rows.map((a) => ({
      id: `APR-${String(a.id).padStart(3, "0")}`,
      dbId: a.id,
      request: a.request_text,
      requestedBy: a.requested_by_name,
      status: a.status,
      movementDbId: a.movement_id ?? null,
    })),
  );
});

app.post("/api/approvals", requireAuth, (req, res) => {
  const text = String((req.body || {}).request_text || "").trim();
  if (!text) return res.status(400).json({ error: "request_text obrigatorio" });
  const r = db
    .prepare("INSERT INTO approvals (request_text, status, requested_by) VALUES (?, 'Aguardando', ?)")
    .run(text, req.user.id);
  writeAudit(db, {
    userId: req.user.id,
    action: "CREATE",
    entityType: "approval",
    entityId: r.lastInsertRowid,
    after: { request_text: text },
    req,
  });
  res.status(201).json({ dbId: r.lastInsertRowid });
});

app.patch("/api/approvals/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "Nao encontrado" });
  const status = String((req.body || {}).status || before.status);

  if (status === "Aprovado" && before.movement_id) {
    const mov = db.prepare("SELECT * FROM movements WHERE id = ?").get(before.movement_id);
    if (mov && mov.status === "Aguardando aprovacao") {
      db.prepare("UPDATE movements SET status = 'Concluido' WHERE id = ?").run(mov.id);
      try {
        tryApplyMovementStock(db, mov.id, req.user.id, req);
      } catch (err) {
        db.prepare("UPDATE movements SET status = 'Aguardando aprovacao' WHERE id = ?").run(mov.id);
        return res.status(422).json({ error: err.message || "Estoque insuficiente ou dados invalidos" });
      }
    }
  }

  if (status === "Recusado" && before.movement_id) {
    db.prepare("UPDATE movements SET status = 'Recusada' WHERE id = ? AND status = 'Aguardando aprovacao'").run(
      before.movement_id,
    );
  }

  db.prepare("UPDATE approvals SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  const after = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  writeAudit(db, {
    userId: req.user.id,
    action: "UPDATE",
    entityType: "approval",
    entityId: id,
    before,
    after,
    req,
  });
  res.json({ ok: true });
});

app.post("/api/cycle-counts", requireAuth, (req, res) => {
  const b = req.body || {};
  const sessionId = String(b.session_id || `CC-${Date.now()}`).trim();
  const counts = Array.isArray(b.counts) ? b.counts : [];
  if (!counts.length) return res.status(400).json({ error: "counts obrigatorio" });
  const ins = db.prepare(
    `INSERT INTO cycle_counts (stock_item_id, expected_qty, counted_qty, session_id, created_by)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const inserted = [];
  for (const c of counts) {
    const sid = Number(c.stock_item_id);
    const counted = Number(c.counted_qty);
    if (!sid || Number.isNaN(counted)) continue;
    const item = db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(sid);
    if (!item) continue;
    const r = ins.run(sid, item.qty, counted, sessionId, req.user.id);
    inserted.push({ id: r.lastInsertRowid, stock_item_id: sid, expected: item.qty, counted });
  }
  writeAudit(db, {
    userId: req.user.id,
    action: "CYCLE_COUNT",
    entityType: "cycle_session",
    entityId: sessionId,
    after: { session_id: sessionId, lines: inserted.length },
    req,
  });
  res.status(201).json({ session_id: sessionId, lines: inserted.length });
});

app.get("/api/cycle-counts/recent", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare(
      `SELECT cc.*, si.code, si.name, si.location, si.batch,
        u.display_name AS counted_by_name
       FROM cycle_counts cc
       JOIN stock_items si ON si.id = cc.stock_item_id
       JOIN users u ON u.id = cc.created_by
       ORDER BY cc.created_at DESC
       LIMIT ?`,
    )
    .all(limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      stock_item_id: r.stock_item_id,
      code: r.code,
      name: r.name,
      location: r.location,
      batch: r.batch,
      expected_qty: r.expected_qty,
      counted_qty: r.counted_qty,
      variance: r.counted_qty != null ? r.counted_qty - r.expected_qty : null,
      counted_by: r.counted_by_name,
      created_at: r.created_at,
    })),
  );
});

app.get("/api/location-values", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT location, SUM(qty) AS items, SUM(qty * unit_price) AS value
       FROM stock_items
       GROUP BY location
       ORDER BY value DESC`,
    )
    .all();
  const total = rows.reduce((s, r) => s + r.value, 0);
  res.json({
    total,
    rows: rows.map((r) => ({
      location: r.location,
      items: r.items,
      value: r.value,
      pct: total > 0 ? (r.value / total) * 100 : 0,
    })),
  });
});

app.get("/api/dashboard/summary", requireAuth, (_req, res) => {
  const items = db.prepare("SELECT * FROM stock_items").all();
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const totalValue = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const lowStock = items.filter((i) => i.qty < i.min_qty).length;
  const expiring30 = items.filter((i) => {
    const d = daysUntilExpiry(i.expiry_date);
    return d !== null && d >= 0 && d <= 30;
  }).length;
  const mov7 = db
    .prepare(
      `SELECT COUNT(*) AS c FROM movements WHERE datetime(created_at) >= datetime('now', '-7 days')`,
    )
    .get().c;
  res.json({
    productLines: items.length,
    totalQty,
    totalValue,
    lowStock,
    expiring30,
    movements7d: mov7,
  });
});

app.get("/api/export/nessoft", requireAuth, (req, res) => {
  const toRaw = req.query.to ? String(req.query.to) : null;
  const fromRaw = req.query.from ? String(req.query.from) : null;
  const to = toRaw || new Date().toISOString().slice(0, 10);
  let from = fromRaw;
  if (!from) {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    from = d.toISOString().slice(0, 10);
  }
  const csv = buildNessoftCsv(db, from, to);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="nessoft_movimentos_${from}_${to}.csv"`);
  res.send(csv);
});

app.get("/api/audit", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
  let sql = `SELECT a.*, u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;
  const args = [];
  if (entityType) {
    sql += ` WHERE a.entity_type = ?`;
    args.push(entityType);
  }
  sql += ` ORDER BY a.created_at DESC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  res.json(
    rows.map((r) => ({
      id: r.id,
      user: r.actor_username,
      user_id: r.user_id,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      before: r.payload_before ? JSON.parse(r.payload_before) : null,
      after: r.payload_after ? JSON.parse(r.payload_after) : null,
      created_at: r.created_at,
    })),
  );
});

app.listen(PORT, () => {
  console.log(`API estoque http://localhost:${PORT}`);
});
