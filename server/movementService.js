import { writeAudit } from "./audit.js";

export function selectFefoLines(db, productCode) {
  const code = String(productCode || "").trim();
  if (!code) return [];
  return db
    .prepare(
      `SELECT * FROM stock_items
       WHERE code = ? AND qty > 0
       ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, id ASC`,
    )
    .all(code);
}

export function applyMovementStock(db, movementId, userId, req) {
  const m = db.prepare("SELECT * FROM movements WHERE id = ?").get(movementId);
  if (!m) throw new Error("Movimentacao nao encontrada");
  if (m.stock_effect_applied) {
    return { applied: false, reason: "already_applied", allocations: [] };
  }

  const allocations = [];

  const run = db.transaction(() => {
    if (m.type === "Entrada") {
      const sid = m.stock_item_id;
      if (!sid) throw new Error("Entrada exige stock_item_id (linha de estoque)");
      const line = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(sid);
      if (!line) throw new Error("Linha de estoque invalida");
      const q = Number(m.qty) || 0;
      if (q <= 0) throw new Error("Quantidade invalida");
      db.prepare("UPDATE stock_items SET qty = qty + ?, updated_at = datetime('now') WHERE id = ?").run(q, sid);
      db.prepare(
        "INSERT INTO movement_allocations (movement_id, stock_item_id, qty) VALUES (?, ?, ?)",
      ).run(movementId, sid, q);
      allocations.push({ stock_item_id: sid, qty: q });
    } else if (m.type === "Saida") {
      const qTotal = Number(m.qty) || 0;
      if (qTotal <= 0) throw new Error("Quantidade invalida");
      let remaining = qTotal;

      if (m.stock_item_id) {
        const line = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(m.stock_item_id);
        if (!line) throw new Error("Linha de estoque invalida");
        if (line.qty < remaining) throw new Error(`Saldo insuficiente na linha ${line.id}`);
        db.prepare("UPDATE stock_items SET qty = qty - ?, updated_at = datetime('now') WHERE id = ?").run(remaining, line.id);
        db.prepare(
          "INSERT INTO movement_allocations (movement_id, stock_item_id, qty) VALUES (?, ?, ?)",
        ).run(movementId, line.id, remaining);
        allocations.push({ stock_item_id: line.id, qty: remaining });
      } else {
        const code = String(m.product_code || "").trim();
        if (!code) throw new Error("Saida FEFO exige product_code ou stock_item_id");
        const lines = selectFefoLines(db, code);
        if (!lines.length) throw new Error(`Sem saldo para o SKU ${code}`);
        for (const line of lines) {
          if (remaining <= 0) break;
          const take = Math.min(line.qty, remaining);
          if (take <= 0) continue;
          db.prepare("UPDATE stock_items SET qty = qty - ?, updated_at = datetime('now') WHERE id = ?").run(take, line.id);
          db.prepare(
            "INSERT INTO movement_allocations (movement_id, stock_item_id, qty) VALUES (?, ?, ?)",
          ).run(movementId, line.id, take);
          allocations.push({ stock_item_id: line.id, qty: take });
          remaining -= take;
        }
        if (remaining > 0) throw new Error("Saldo insuficiente para completar a saida (FEFO)");
      }
    } else if (m.type === "Ajuste") {
      const sid = m.stock_item_id;
      if (!sid) throw new Error("Ajuste exige stock_item_id");
      const delta = Number(m.qty) || 0;
      if (delta === 0) throw new Error("Ajuste com quantidade zero");
      const line = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(sid);
      if (!line) throw new Error("Linha de estoque invalida");
      const next = line.qty + delta;
      if (next < 0) throw new Error("Ajuste resultaria em saldo negativo");
      db.prepare("UPDATE stock_items SET qty = ?, updated_at = datetime('now') WHERE id = ?").run(next, sid);
      db.prepare(
        "INSERT INTO movement_allocations (movement_id, stock_item_id, qty) VALUES (?, ?, ?)",
      ).run(movementId, sid, Math.abs(delta));
      allocations.push({ stock_item_id: sid, qty: delta });
    } else {
      throw new Error(`Tipo ${m.type} sem baixa automatica configurada`);
    }

    db.prepare("UPDATE movements SET stock_effect_applied = 1 WHERE id = ?").run(movementId);
  });

  run();

  writeAudit(db, {
    userId,
    action: "MOVEMENT_STOCK_APPLIED",
    entityType: "movement",
    entityId: movementId,
    after: { type: m.type, ref: m.ref, allocations },
    req,
  });

  return { applied: true, allocations };
}

export function tryApplyMovementStock(db, movementId, userId, req) {
  const m = db.prepare("SELECT * FROM movements WHERE id = ?").get(movementId);
  if (!m) throw new Error("Movimentacao nao encontrada");
  if (m.stock_effect_applied) return { applied: false, reason: "already_applied", allocations: [] };
  if (!["Entrada", "Saida", "Ajuste"].includes(m.type)) {
    return { applied: false, reason: "no_auto_stock", allocations: [] };
  }
  return applyMovementStock(db, movementId, userId, req);
}

export function movementNeedsApproval(type) {
  return type === "Saida" || type === "Ajuste";
}
