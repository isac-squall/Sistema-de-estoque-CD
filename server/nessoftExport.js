function esc(value) {
  if (value == null || value === "") return "";
  const t = String(value);
  if (/[;"\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function nessoftTipoMovimento(type) {
  const map = { Entrada: "E", Saida: "S", Ajuste: "A", Transferencia: "T" };
  return map[type] || "X";
}

export function buildNessoftCsv(db, fromDate, toDate) {
  const rows = db
    .prepare(
      `SELECT ma.id AS aloc_id, ma.qty AS alloc_qty,
        m.id AS mov_id, m.ref, m.type, m.created_at, m.qty AS mov_qty,
        si.code AS sku, si.name, si.category, si.batch, si.expiry_date, si.location, si.unit_price,
        u.username
      FROM movement_allocations ma
      INNER JOIN movements m ON m.id = ma.movement_id
      INNER JOIN stock_items si ON si.id = ma.stock_item_id
      INNER JOIN users u ON u.id = m.created_by
      WHERE m.status = 'Concluido'
        AND date(m.created_at) >= date(?)
        AND date(m.created_at) <= date(?)
      ORDER BY m.created_at ASC, ma.id ASC`,
    )
    .all(fromDate, toDate);

  const header = [
    "codigo_produto",
    "descricao_produto",
    "categoria",
    "numero_lote",
    "data_validade",
    "endereco_estoque",
    "quantidade",
    "valor_unitario",
    "tipo_movimento",
    "numero_documento",
    "data_hora_registro",
    "usuario_lancamento",
    "id_alocacao_sistema",
    "id_movimento_sistema",
  ].join(";");

  const lines = [header];
  for (const r of rows) {
    const tipo = nessoftTipoMovimento(r.type);
    const qtd = r.type === "Ajuste" ? String(Number(r.mov_qty) || 0) : String(Number(r.alloc_qty) || 0);
    lines.push(
      [
        esc(r.sku),
        esc(r.name),
        esc(r.category),
        esc(r.batch),
        esc(r.expiry_date),
        esc(r.location),
        esc(qtd),
        esc(Number(r.unit_price).toFixed(2).replace(".", ",")),
        esc(tipo),
        esc(r.ref),
        esc(r.created_at),
        esc(r.username),
        esc(r.aloc_id),
        esc(r.mov_id),
      ].join(";"),
    );
  }

  return "\ufeff" + lines.join("\r\n");
}
