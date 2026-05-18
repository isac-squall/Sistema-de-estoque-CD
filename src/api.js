const TOKEN_KEY = "estoque_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401) {
    clearToken();
    const err = new Error(data.error || "Sessao expirada");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function downloadNessoftCsv({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const q = params.toString();
  const t = getToken();
  const res = await fetch(`/api/export/nessoft${q ? `?${q}` : ""}`, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Sessao expirada");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nessoft_movimentos_${from || "export"}_${to || ""}.csv`.replace(/_$/, "");
  a.click();
  URL.revokeObjectURL(url);
}
