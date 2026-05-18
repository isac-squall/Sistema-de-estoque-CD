import { useCallback, useEffect, useMemo, useState } from "react";
import Login from "./Login";
import { api, clearToken, downloadNessoftCsv, getToken } from "./api";

const MENUS = [
  { id: "produtos", label: "Produtos", icon: "📦" },
  { id: "movimentacoes", label: "Movimentacoes", icon: "↔" },
  { id: "inventario", label: "Inventario", icon: "📋" },
  { id: "relatorios", label: "Relatorios", icon: "📊" },
];

const MOV_TYPES = ["Entrada", "Saida", "Ajuste"];
const MOV_STATUSES = ["Pendente", "Em separacao", "Concluido", "Aguardando aprovacao", "Recusada"];

export function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function statusClass(s) {
  const x = String(s || "").toLowerCase();
  if (x.includes("critico") || x.includes("recusad")) return "badge-danger";
  if (x.includes("atencao") || x.includes("aguardando") || x.includes("pendente")) return "badge-warn";
  if (x.includes("concluid") || x.includes("aprovad") || x.includes("normal")) return "badge-ok";
  return "badge-muted";
}

function nextRef(prefix) {
  return `${prefix}-${String(Date.now()).slice(-6)}`;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [view, setView] = useState("produtos");
  const [stock, setStock] = useState([]);
  const [movements, setMovements] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [audit, setAudit] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [locationValues, setLocationValues] = useState({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const [movForm, setMovForm] = useState({
    ref: nextRef("MOV"),
    type: "Saida",
    qty: "",
    status: "Concluido",
    stock_item_id: "",
    product_code: "",
    notes: "",
    skip_approval: false,
  });
  const [movBusy, setMovBusy] = useState(false);

  const [productForm, setProductForm] = useState({
    code: "",
    name: "",
    category: "Geral",
    location: "",
    qty: 0,
    unit_price: 0,
    batch: "",
    expiry_date: "",
    min_qty: 0,
  });
  const [productBusy, setProductBusy] = useState(false);

  const [cycleCounts, setCycleCounts] = useState({});
  const [cycleBusy, setCycleBusy] = useState(false);

  const [exportFrom, setExportFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [exportTo, setExportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [exportBusy, setExportBusy] = useState(false);

  const isAdmin = user?.role === "admin";

  const uniqueSkus = useMemo(() => {
    const m = new Map();
    for (const s of stock) {
      if (!m.has(s.code)) m.set(s.code, s.name);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [stock]);

  const kpis = useMemo(() => {
    if (dashboard) {
      return [
        { label: "Linhas de estoque", value: dashboard.productLines, sub: "SKUs / lotes" },
        { label: "Quantidade total", value: dashboard.totalQty.toLocaleString("pt-BR"), sub: "unidades" },
        { label: "Valor em estoque", value: money(dashboard.totalValue), sub: "preco x qty" },
        { label: "Abaixo do minimo", value: dashboard.lowStock, sub: "alertas" },
        { label: "Vence em 30 dias", value: dashboard.expiring30, sub: "validade" },
        { label: "Mov. 7 dias", value: dashboard.movements7d, sub: "operacoes" },
      ];
    }
    const totalValue = stock.reduce((s, i) => s + i.qty * (i.unit || 0), 0);
    const low = stock.filter((i) => i.qty < i.min_qty).length;
    const exp = stock.filter((i) => i.expiryDays != null && i.expiryDays >= 0 && i.expiryDays <= 30).length;
    return [
      { label: "Linhas de estoque", value: stock.length, sub: "SKUs / lotes" },
      { label: "Quantidade total", value: stock.reduce((s, i) => s + i.qty, 0).toLocaleString("pt-BR"), sub: "unidades" },
      { label: "Valor em estoque", value: money(totalValue), sub: "preco x qty" },
      { label: "Abaixo do minimo", value: low, sub: "alertas" },
      { label: "Vence em 30 dias", value: exp, sub: "validade" },
      { label: "Mov. recentes", value: movements.length, sub: "carregadas" },
    ];
  }, [dashboard, stock, movements]);

  const showMsg = useCallback((msg) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 4000);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [items, movs, appr, dash, loc, aud] = await Promise.all([
        api("/stock-items"),
        api("/movements"),
        api("/approvals"),
        api("/dashboard/summary"),
        api("/location-values"),
        api("/audit?limit=80"),
      ]);
      setStock(items);
      setMovements(movs);
      setApprovals(appr);
      setDashboard(dash);
      setLocationValues(loc);
      setAudit(aud);
    } catch (e) {
      if (e.status === 401) setUser(null);
      else setError(e.message || "Erro ao carregar dados");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setBooting(false);
      return;
    }
    (async () => {
      try {
        const { user: u } = await api("/me");
        setUser(u);
        await loadAll();
      } catch {
        clearToken();
        setUser(null);
      } finally {
        setBooting(false);
      }
    })();
  }, [loadAll]);

  function handleLogout() {
    clearToken();
    setUser(null);
    setStock([]);
    setMovements([]);
    setApprovals([]);
    setAudit([]);
    setDashboard(null);
  }

  async function handleLoginSuccess(u) {
    setUser(u);
    await loadAll();
  }

  async function submitMovement(e) {
    e.preventDefault();
    setMovBusy(true);
    setError("");
    try {
      const body = {
        ref: movForm.ref.trim(),
        type: movForm.type,
        qty: Number(movForm.qty),
        status: movForm.status,
        notes: movForm.notes.trim() || undefined,
      };
      if (movForm.type === "Saida") {
        if (movForm.product_code) body.product_code = movForm.product_code;
        else if (movForm.stock_item_id) body.stock_item_id = Number(movForm.stock_item_id);
      } else if (movForm.stock_item_id) {
        body.stock_item_id = Number(movForm.stock_item_id);
      }
      if (isAdmin && movForm.skip_approval) body.skip_approval = true;

      await api("/movements", { method: "POST", body: JSON.stringify(body) });
      showMsg("Movimentacao registrada");
      setMovForm({
        ref: nextRef("MOV"),
        type: movForm.type,
        qty: "",
        status: "Concluido",
        stock_item_id: "",
        product_code: movForm.product_code,
        notes: "",
        skip_approval: false,
      });
      await loadAll();
    } catch (err) {
      setError(err.message || "Falha ao registrar movimentacao");
    } finally {
      setMovBusy(false);
    }
  }

  async function submitProduct(e) {
    e.preventDefault();
    setProductBusy(true);
    setError("");
    try {
      await api("/stock-items", {
        method: "POST",
        body: JSON.stringify({
          ...productForm,
          qty: Number(productForm.qty),
          unit_price: Number(productForm.unit_price),
          min_qty: Number(productForm.min_qty),
          batch: productForm.batch || null,
          expiry_date: productForm.expiry_date || null,
        }),
      });
      showMsg("Produto / linha criada");
      setProductForm({
        code: "",
        name: "",
        category: "Geral",
        location: "",
        qty: 0,
        unit_price: 0,
        batch: "",
        expiry_date: "",
        min_qty: 0,
      });
      await loadAll();
    } catch (err) {
      setError(err.message || "Falha ao criar produto");
    } finally {
      setProductBusy(false);
    }
  }

  async function submitCycleCount(e) {
    e.preventDefault();
    const counts = Object.entries(cycleCounts)
      .filter(([, v]) => v !== "" && v != null)
      .map(([stock_item_id, counted_qty]) => ({
        stock_item_id: Number(stock_item_id),
        counted_qty: Number(counted_qty),
      }));
    if (!counts.length) {
      setError("Informe ao menos uma contagem");
      return;
    }
    setCycleBusy(true);
    setError("");
    try {
      const res = await api("/cycle-counts", {
        method: "POST",
        body: JSON.stringify({ counts }),
      });
      showMsg(`Inventario salvo: ${res.lines} linha(s) — sessao ${res.session_id}`);
      setCycleCounts({});
      await loadAll();
    } catch (err) {
      setError(err.message || "Falha no inventario ciclico");
    } finally {
      setCycleBusy(false);
    }
  }

  async function handleApproval(dbId, status) {
    setError("");
    try {
      await api(`/approvals/${dbId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      showMsg(status === "Aprovado" ? "Aprovado" : "Recusado");
      await loadAll();
    } catch (err) {
      setError(err.message || "Falha na aprovacao");
    }
  }

  async function handleExport() {
    setExportBusy(true);
    setError("");
    try {
      await downloadNessoftCsv({ from: exportFrom, to: exportTo });
      showMsg("CSV Nessoft exportado");
    } catch (err) {
      setError(err.message || "Falha na exportacao");
    } finally {
      setExportBusy(false);
    }
  }

  if (booting) {
    return (
      <div className="boot-screen">
        <p>Carregando...</p>
      </div>
    );
  }

  if (!user) {
    return <Login onSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">CD</span>
          <div>
            <strong>Estoque CD</strong>
            <small>{user.display_name || user.username}</small>
          </div>
        </div>
        <nav className="nav">
          {MENUS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`nav-item${view === m.id ? " active" : ""}`}
              onClick={() => setView(m.id)}
            >
              <span className="nav-icon">{m.icon}</span>
              {m.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`role-tag ${isAdmin ? "admin" : ""}`}>{user.role}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={handleLogout}>
            Sair
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{MENUS.find((m) => m.id === view)?.label}</h1>
          <button type="button" className="btn-secondary btn-sm" onClick={loadAll} disabled={loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </button>
        </header>

        {flash ? <div className="flash-banner">{flash}</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}

        <section className="kpi-row">
          {kpis.map((k) => (
            <article key={k.label} className="kpi-card">
              <span className="kpi-label">{k.label}</span>
              <strong className="kpi-value">{k.value}</strong>
              <span className="kpi-sub">{k.sub}</span>
            </article>
          ))}
        </section>

        {view === "produtos" && (
          <section className="panel">
            <div className="panel-head">
              <h2>Linhas de estoque</h2>
              <span className="muted">{stock.length} registros</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>SKU</th>
                    <th>Produto</th>
                    <th>Local</th>
                    <th>Lote</th>
                    <th>Validade</th>
                    <th>Qty</th>
                    <th>Min</th>
                    <th>Unit.</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((row) => (
                    <tr key={row.id}>
                      <td>{row.id}</td>
                      <td>
                        <code>{row.code}</code>
                      </td>
                      <td>{row.name}</td>
                      <td>{row.location}</td>
                      <td>{row.batch || "—"}</td>
                      <td>
                        {formatDate(row.expiry_date)}
                        {row.expiryDays != null ? (
                          <span className="muted tiny"> ({row.expiryDays}d)</span>
                        ) : null}
                      </td>
                      <td className="num">{row.qty.toLocaleString("pt-BR")}</td>
                      <td className="num">{row.min_qty}</td>
                      <td className="num">{money(row.unit)}</td>
                      <td>
                        <span className={`badge ${statusClass(row.status)}`}>{row.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details className="inline-form-details">
              <summary>Nova linha de estoque</summary>
              <form className="grid-form" onSubmit={submitProduct}>
                <label>
                  SKU
                  <input
                    required
                    value={productForm.code}
                    onChange={(e) => setProductForm((f) => ({ ...f, code: e.target.value }))}
                  />
                </label>
                <label>
                  Nome
                  <input
                    required
                    value={productForm.name}
                    onChange={(e) => setProductForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </label>
                <label>
                  Categoria
                  <input
                    value={productForm.category}
                    onChange={(e) => setProductForm((f) => ({ ...f, category: e.target.value }))}
                  />
                </label>
                <label>
                  Local
                  <input
                    value={productForm.location}
                    onChange={(e) => setProductForm((f) => ({ ...f, location: e.target.value }))}
                  />
                </label>
                <label>
                  Qty inicial
                  <input
                    type="number"
                    value={productForm.qty}
                    onChange={(e) => setProductForm((f) => ({ ...f, qty: e.target.value }))}
                  />
                </label>
                <label>
                  Preco unit.
                  <input
                    type="number"
                    step="0.01"
                    value={productForm.unit_price}
                    onChange={(e) => setProductForm((f) => ({ ...f, unit_price: e.target.value }))}
                  />
                </label>
                <label>
                  Lote
                  <input
                    value={productForm.batch}
                    onChange={(e) => setProductForm((f) => ({ ...f, batch: e.target.value }))}
                  />
                </label>
                <label>
                  Validade
                  <input
                    type="date"
                    value={productForm.expiry_date}
                    onChange={(e) => setProductForm((f) => ({ ...f, expiry_date: e.target.value }))}
                  />
                </label>
                <label>
                  Qty minima
                  <input
                    type="number"
                    value={productForm.min_qty}
                    onChange={(e) => setProductForm((f) => ({ ...f, min_qty: e.target.value }))}
                  />
                </label>
                <div className="form-actions span-all">
                  <button type="submit" className="btn-primary" disabled={productBusy}>
                    {productBusy ? "Salvando..." : "Criar linha"}
                  </button>
                </div>
              </form>
            </details>
          </section>
        )}

        {view === "movimentacoes" && (
          <>
            <section className="panel">
              <h2>Nova movimentacao</h2>
              <form className="mov-form" onSubmit={submitMovement}>
                <label>
                  Referencia
                  <input
                    required
                    value={movForm.ref}
                    onChange={(e) => setMovForm((f) => ({ ...f, ref: e.target.value }))}
                  />
                </label>
                <label>
                  Tipo
                  <select
                    value={movForm.type}
                    onChange={(e) =>
                      setMovForm((f) => ({
                        ...f,
                        type: e.target.value,
                        product_code: e.target.value === "Saida" ? f.product_code : "",
                      }))
                    }
                  >
                    {MOV_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Quantidade
                  <input
                    type="number"
                    required
                    value={movForm.qty}
                    onChange={(e) => setMovForm((f) => ({ ...f, qty: e.target.value }))}
                  />
                </label>
                <label>
                  Status
                  <select
                    value={movForm.status}
                    onChange={(e) => setMovForm((f) => ({ ...f, status: e.target.value }))}
                  >
                    {MOV_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>

                {movForm.type === "Saida" ? (
                  <label className="span-2">
                    SKU (FEFO) — baixa automatica por validade
                    <select
                      value={movForm.product_code}
                      onChange={(e) =>
                        setMovForm((f) => ({
                          ...f,
                          product_code: e.target.value,
                          stock_item_id: "",
                        }))
                      }
                    >
                      <option value="">Selecione o SKU...</option>
                      {uniqueSkus.map(([code, name]) => (
                        <option key={code} value={code}>
                          {code} — {name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {(movForm.type === "Entrada" || movForm.type === "Ajuste") && (
                  <label className="span-2">
                    Linha de estoque
                    <select
                      required={movForm.type === "Ajuste" || movForm.status === "Concluido"}
                      value={movForm.stock_item_id}
                      onChange={(e) => setMovForm((f) => ({ ...f, stock_item_id: e.target.value }))}
                    >
                      <option value="">Selecione linha #...</option>
                      {stock.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.id} {s.code} — {s.location} ({s.qty} un.)
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {movForm.type === "Saida" && !movForm.product_code ? (
                  <label className="span-2">
                    Ou linha especifica (opcional)
                    <select
                      value={movForm.stock_item_id}
                      onChange={(e) => setMovForm((f) => ({ ...f, stock_item_id: e.target.value }))}
                    >
                      <option value="">Usar FEFO por SKU acima</option>
                      {stock.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.id} {s.code} — {s.location} ({s.qty} un.)
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="span-2">
                  Observacoes
                  <input
                    value={movForm.notes}
                    onChange={(e) => setMovForm((f) => ({ ...f, notes: e.target.value }))}
                  />
                </label>

                {isAdmin ? (
                  <label className="checkbox-row span-2">
                    <input
                      type="checkbox"
                      checked={movForm.skip_approval}
                      onChange={(e) => setMovForm((f) => ({ ...f, skip_approval: e.target.checked }))}
                    />
                    Admin: aplicar sem fila de aprovacao (Saida / Ajuste)
                  </label>
                ) : null}

                <div className="form-actions span-all">
                  <button type="submit" className="btn-primary" disabled={movBusy}>
                    {movBusy ? "Registrando..." : "Registrar movimentacao"}
                  </button>
                </div>
              </form>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Historico de movimentacoes</h2>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ref</th>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th>Qty</th>
                      <th>Status</th>
                      <th>Responsavel</th>
                      <th>Aprovacao</th>
                      <th>FEFO</th>
                      <th>Estoque</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.dbId}>
                        <td>
                          <code>{m.id}</code>
                        </td>
                        <td>{formatDate(m.date)}</td>
                        <td>{m.type}</td>
                        <td className="num">{m.qty}</td>
                        <td>
                          <span className={`badge ${statusClass(m.status)}`}>{m.status}</span>
                        </td>
                        <td>{m.owner}</td>
                        <td>
                          {m.approvalStatus ? (
                            <span className={`badge ${statusClass(m.approvalStatus)}`}>{m.approvalStatus}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {m.fefoLines != null ? (
                            <span className="fefo-pill">{m.fefoLines} linha(s)</span>
                          ) : m.product_code ? (
                            <span className="muted">SKU {m.product_code}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{m.stock_effect_applied ? "Aplicado" : "Pendente"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {view === "inventario" && (
          <section className="panel">
            <div className="panel-head">
              <h2>Contagem ciclica</h2>
              <span className="muted">Informe a quantidade contada por linha</span>
            </div>
            <form onSubmit={submitCycleCount}>
              <div className="table-wrap">
                <table className="data-table cycle-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>SKU</th>
                      <th>Local</th>
                      <th>Sistema</th>
                      <th>Contado</th>
                      <th>Diferenca</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stock.map((row) => {
                      const raw = cycleCounts[row.id];
                      const counted = raw === "" || raw == null ? null : Number(raw);
                      const diff = counted != null && !Number.isNaN(counted) ? counted - row.qty : null;
                      return (
                        <tr key={row.id}>
                          <td>{row.id}</td>
                          <td>
                            <code>{row.code}</code>
                          </td>
                          <td>{row.location}</td>
                          <td className="num">{row.qty.toLocaleString("pt-BR")}</td>
                          <td>
                            <input
                              className="cycle-input"
                              type="number"
                              placeholder="—"
                              value={raw ?? ""}
                              onChange={(e) => setCycleCounts((c) => ({ ...c, [row.id]: e.target.value }))}
                            />
                          </td>
                          <td className={`num ${diff != null && diff !== 0 ? "diff-warn" : ""}`}>
                            {diff != null ? diff.toLocaleString("pt-BR") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={cycleBusy}>
                  {cycleBusy ? "Salvando..." : "Enviar contagem"}
                </button>
              </div>
            </form>
          </section>
        )}

        {view === "relatorios" && (
          <>
            <section className="panel">
              <h2>Exportacao Nessoft (CSV)</h2>
              <div className="export-row">
                <label>
                  De
                  <input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} />
                </label>
                <label>
                  Ate
                  <input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} />
                </label>
                <button type="button" className="btn-primary" onClick={handleExport} disabled={exportBusy}>
                  {exportBusy ? "Exportando..." : "Baixar CSV"}
                </button>
              </div>
            </section>

            <section className="mini-dash">
              {dashboard
                ? [
                    { label: "Linhas", value: dashboard.productLines },
                    { label: "Qty total", value: dashboard.totalQty.toLocaleString("pt-BR") },
                    { label: "Valor", value: money(dashboard.totalValue) },
                    { label: "Baixo min.", value: dashboard.lowStock },
                    { label: "Vence 30d", value: dashboard.expiring30 },
                    { label: "Mov. 7d", value: dashboard.movements7d },
                  ].map((c) => (
                    <article key={c.label} className="mini-card">
                      <span>{c.label}</span>
                      <strong>{c.value}</strong>
                    </article>
                  ))
                : null}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Valor por localizacao</h2>
                <span className="muted">Total: {money(locationValues.total)}</span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Local</th>
                      <th>Itens (qty)</th>
                      <th>Valor</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locationValues.rows.map((r) => (
                      <tr key={r.location}>
                        <td>{r.location}</td>
                        <td className="num">{r.items?.toLocaleString("pt-BR")}</td>
                        <td className="num">{money(r.value)}</td>
                        <td className="num">{r.pct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Fila de aprovacoes</h2>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Solicitacao</th>
                      <th>Solicitante</th>
                      <th>Status</th>
                      <th>Acoes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvals.map((a) => (
                      <tr key={a.dbId}>
                        <td>{a.id}</td>
                        <td>{a.request}</td>
                        <td>{a.requestedBy}</td>
                        <td>
                          <span className={`badge ${statusClass(a.status)}`}>{a.status}</span>
                        </td>
                        <td className="actions-cell">
                          {a.status === "Aguardando" ? (
                            <>
                              <button
                                type="button"
                                className="btn-sm btn-ok"
                                onClick={() => handleApproval(a.dbId, "Aprovado")}
                              >
                                Aprovar
                              </button>
                              <button
                                type="button"
                                className="btn-sm btn-danger"
                                onClick={() => handleApproval(a.dbId, "Recusado")}
                              >
                                Recusar
                              </button>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Auditoria</h2>
                <span className="muted">Ultimos 80 eventos</span>
              </div>
              <div className="table-wrap audit-wrap">
                <table className="data-table audit-table">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Usuario</th>
                      <th>Acao</th>
                      <th>Entidade</th>
                      <th>ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((ev) => (
                      <tr key={ev.id}>
                        <td>{formatDate(ev.created_at)}</td>
                        <td>{ev.user || "—"}</td>
                        <td>
                          <code>{ev.action}</code>
                        </td>
                        <td>{ev.entity_type}</td>
                        <td>{ev.entity_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
