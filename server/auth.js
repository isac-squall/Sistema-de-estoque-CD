import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-altere-em-producao-use-env";

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function authMiddleware(db) {
  return (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token ausente" });
    }
    const decoded = verifyToken(h.slice(7));
    if (!decoded?.sub) {
      return res.status(401).json({ error: "Token invalido" });
    }
    const user = db.prepare("SELECT id, username, display_name, role FROM users WHERE id = ?").get(decoded.sub);
    if (!user) {
      return res.status(401).json({ error: "Usuario nao encontrado" });
    }
    req.user = user;
    next();
  };
}
