import { useState } from "react";
import { setToken } from "./api";

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || "Falha no login");
        return;
      }
      setToken(data.token);
      onSuccess(data.user);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Controle de Estoque CD</h1>
        <p className="login-hint">Entre com usuario e senha. Padrao: admin / admin123</p>
        {err ? <div className="error-banner">{err}</div> : null}
        <label>
          Usuario
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </main>
  );
}
