export function writeAudit(db, { userId, action, entityType, entityId, before, after, req }) {
  const ip = req?.ip || req?.socket?.remoteAddress || null;
  const ua = req?.get?.("user-agent") || null;
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, payload_before, payload_after, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId ?? null,
    action,
    entityType,
    entityId != null ? String(entityId) : null,
    before != null ? JSON.stringify(before) : null,
    after != null ? JSON.stringify(after) : null,
    ip,
    ua,
  );
}
