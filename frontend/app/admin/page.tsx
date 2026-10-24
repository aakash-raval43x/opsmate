"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// ============================================================
// Admin Panel — orders / users / products / dashboard
// Same brand styling rules as the login page (Tailwind).
// All data comes from /api/admin/* (backend-verified admin session).
// ============================================================

type Stats = {
  users: { n: number; new_7d: number };
  orders: { n: number; processing: number; new_7d: number };
  products: { n: number; active: number; stock: number };
  revenue_total: string;
  recent_orders: Array<{
    order_id: string;
    customer_name: string;
    status: string;
    total_amount: string;
    created_at: string;
  }>;
};

type AdminUser = {
  id: number;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
};

type AdminOrder = {
  id: number;
  order_id: string;
  customer_name: string;
  status: string;
  total_amount: string;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
};

type AdminProduct = {
  id: number;
  sku: string;
  name: string;
  price: string;
  stock_quantity: number;
  is_active: boolean;
};

type Tab = "dashboard" | "orders" | "users" | "products";

const STATUS_COLORS: Record<string, string> = {
  processing: "bg-blue-100 text-blue-700",
  shipped: "bg-indigo-100 text-indigo-700",
  delivered: "bg-emerald-100 text-emerald-700",
  completed: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-teal-100 text-teal-700",
  cancelled: "bg-rose-100 text-rose-700",
  canceled: "bg-rose-100 text-rose-700",
  refunded: "bg-slate-200 text-slate-700",
};

function statusClass(status: string) {
  return STATUS_COLORS[status?.toLowerCase()] ?? "bg-slate-100 text-slate-600";
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [me, setMe] = useState<{ name: string; email: string; role: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);

  const [notice, setNotice] = useState<string | null>(null);

  const token = () =>
    typeof window !== "undefined" ? sessionStorage.getItem("opsmate_auth_token") : null;

  const authedFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const t = token();
      const res = await fetch(`/api/admin/${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
        },
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        setAuthError("Your session expired. Please sign in again as an administrator.");
        throw new Error("unauthorized");
      }
      if (res.status === 403) {
        setAuthError("Administrator privileges are required to view this panel.");
        throw new Error("forbidden");
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      return data;
    },
    []
  );

  async function loadAll() {
    const [s, u, o, p] = await Promise.all([
      authedFetch("stats"),
      authedFetch("users"),
      authedFetch("orders"),
      authedFetch("products"),
    ]);
    setStats(s);
    setUsers(u.users);
    setOrders(o.orders);
    setProducts(p.products);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      // Identity gate first: the panel is admin-only, so resolve the session
      // before pulling anything.
      try {
        const t = token();
        if (!t) throw new Error("no token");
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${t}` },
          cache: "no-store",
        });
        const data = await res.json();
        if (!alive) return;
        if (!res.ok || data?.user?.role !== "admin") {
          setAuthError(
            res.ok && data?.user
              ? "You are signed in, but this panel is for administrators only."
              : "Sign in with an administrator account to open the admin panel."
          );
          return;
        }
        setMe(data.user);
        await loadAll();
      } catch {
        if (alive) setAuthError("Sign in with an administrator account to open the admin panel.");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patchUser(id: number, patch: { role?: string; is_active?: boolean }) {
    setBusy(true);
    setNotice(null);
    try {
      const data = await authedFetch(`users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? data.user : u)));
      setNotice("User updated.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function patchProduct(sku: string, patch: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const data = await authedFetch(`products/${encodeURIComponent(sku)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setProducts((prev) => prev.map((p) => (p.sku === sku ? data.product : p)));
      setNotice("Product updated.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(form: HTMLFormElement) {
    setBusy(true);
    setNotice(null);
    try {
      const fd = new FormData(form);
      const data = await authedFetch("products", {
        method: "POST",
        body: JSON.stringify({
          sku: String(fd.get("sku") || "").trim(),
          name: String(fd.get("name") || "").trim(),
          description: String(fd.get("description") || "").trim(),
          price: Number(fd.get("price")),
          stock_quantity: Number(fd.get("stock_quantity")),
        }),
      });
      setProducts((prev) => [...prev, data.product]);
      setNotice(`Product ${data.product.sku} created.`);
      form.reset();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  // ---------- render ----------

  if (authError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-200/60">
          <p className="mb-2 text-xs font-semibold tracking-[0.2em] text-blue-600">OPSMATE ADMIN</p>
          <h1 className="mb-3 text-xl font-bold text-slate-900">{authError}</h1>
          <Link
            href="/login?next=/admin"
            className="mt-4 inline-block rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Go to sign in
          </Link>
          <Link href="/" className="mt-3 block text-sm text-slate-500 hover:text-slate-700">
            ← Back to chat
          </Link>
        </div>
      </main>
    );
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "dashboard", label: "📊 Dashboard" },
    { id: "orders", label: "🧾 Orders" },
    { id: "users", label: "👥 Users" },
    { id: "products", label: "📦 Products" },
  ];

  const inputCls =
    "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto w-full max-w-6xl">
        {/* header */}
        <header
          className="animate-[fadeInUp_.5s_ease-out_both] mb-6 flex flex-wrap items-center justify-between gap-3"
          style={{ animation: "fadeInUp .5s cubic-bezier(.22,1,.36,1) both" }}
        >
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-blue-600">OPSMATE</p>
            <h1 className="text-2xl font-bold text-slate-900">Admin Panel</h1>
            {me && (
              <p className="text-sm text-slate-500">
                {me.name} · {me.email} ·{" "}
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                  admin
                </span>
              </p>
            )}
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-blue-500 hover:-translate-y-px"
          >
            ← Back to chat
          </Link>
        </header>

        {/* tabs */}
        <nav className="animate-[fadeInUp_.55s_ease-out_both] mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all duration-200 ${
                tab === t.id
                  ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
                  : "border border-slate-200 bg-white text-slate-600 hover:border-blue-400 hover:-translate-y-px"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {notice && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
            {notice}
          </div>
        )}

        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <section className="animate-[fadeInUp_.6s_ease-out_both] space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                {
                  label: "Users",
                  value: stats ? `${stats.users.n}` : "…",
                  sub: stats ? `+${stats.users.new_7d} this week` : "",
                  icon: "👥",
                },
                {
                  label: "Orders",
                  value: stats ? `${stats.orders.n}` : "…",
                  sub: stats ? `${stats.orders.processing} processing · +${stats.orders.new_7d} this week` : "",
                  icon: "🧾",
                },
                {
                  label: "Products",
                  value: stats ? `${stats.products.active}/${stats.products.n}` : "…",
                  sub: stats ? `${stats.products.stock} units in stock` : "",
                  icon: "📦",
                },
                {
                  label: "Revenue",
                  value: stats ? `₹${stats.revenue_total}` : "…",
                  sub: "all non-cancelled orders",
                  icon: "💰",
                },
              ].map((c) => (
                <div
                  key={c.label}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg"
                >
                  <div className="mb-1 flex items-center gap-2 text-sm text-slate-500">
                    <span className="text-lg">{c.icon}</span> {c.label}
                  </div>
                  <p className="text-3xl font-bold text-slate-900">{c.value}</p>
                  {c.sub && <p className="mt-1 text-xs text-slate-500">{c.sub}</p>}
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
              <h2 className="mb-3 text-lg font-bold text-slate-900">Recent Orders</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-2 pr-3">Order</th>
                      <th className="py-2 pr-3">Customer</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Total</th>
                      <th className="py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stats?.recent_orders ?? []).map((o) => (
                      <tr key={o.order_id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-semibold text-slate-800">{o.order_id}</td>
                        <td className="py-2 pr-3 text-slate-600">{o.customer_name}</td>
                        <td className="py-2 pr-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass(o.status)}`}>
                            {o.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-slate-700">₹{o.total_amount}</td>
                        <td className="py-2 text-xs text-slate-500">{fmtDate(o.created_at)}</td>
                      </tr>
                    ))}
                    {!stats && <tr><td colSpan={5} className="py-4 text-slate-400">Loading…</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ORDERS */}
        {tab === "orders" && (
          <section className="animate-[fadeInUp_.5s_ease-out_both] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
            <h2 className="mb-3 text-lg font-bold text-slate-900">All Orders ({orders.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">Order</th>
                    <th className="py-2 pr-3">Customer</th>
                    <th className="py-2 pr-3">Owner (account)</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Total</th>
                    <th className="py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.order_id}
                      className="border-b border-slate-100 last:border-0 transition-colors hover:bg-blue-50/40"
                    >
                      <td className="py-2 pr-3 font-semibold text-slate-800">{o.order_id}</td>
                      <td className="py-2 pr-3 text-slate-600">{o.customer_name}</td>
                      <td className="py-2 pr-3 text-slate-600">
                        {o.owner_email ? `${o.owner_name} (${o.owner_email})` : <span className="text-slate-400">legacy — no owner</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass(o.status)}`}>
                          {o.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700">₹{o.total_amount}</td>
                      <td className="py-2 text-xs text-slate-500">{fmtDate(o.created_at)}</td>
                    </tr>
                  ))}
                  {!orders.length && <tr><td colSpan={6} className="py-4 text-slate-400">Loading…</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* USERS */}
        {tab === "users" && (
          <section className="animate-[fadeInUp_.5s_ease-out_both] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
            <h2 className="mb-3 text-lg font-bold text-slate-900">Users ({users.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Role</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-slate-100 last:border-0 transition-colors hover:bg-blue-50/40">
                      <td className="py-2 pr-3 font-semibold text-slate-800">{u.name}</td>
                      <td className="py-2 pr-3 text-slate-600">{u.email}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            u.role === "admin" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            u.is_active ? "bg-teal-100 text-teal-700" : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {u.is_active ? "active" : "disabled"}
                        </span>
                      </td>
                      <td className="py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void patchUser(u.id, { role: u.role === "admin" ? "user" : "admin" })}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 transition hover:border-blue-500 disabled:opacity-40"
                          >
                            {u.role === "admin" ? "Demote to user" : "Make admin"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void patchUser(u.id, { is_active: !u.is_active })}
                            className={`rounded-md border px-2 py-1 text-xs font-semibold transition disabled:opacity-40 ${
                              u.is_active
                                ? "border-rose-200 text-rose-600 hover:bg-rose-50"
                                : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                            }`}
                          >
                            {u.is_active ? "Disable" : "Enable"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!users.length && <tr><td colSpan={5} className="py-4 text-slate-400">Loading…</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* PRODUCTS */}
        {tab === "products" && (
          <section className="animate-[fadeInUp_.5s_ease-out_both] space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
              <h2 className="mb-3 text-lg font-bold text-slate-900">Catalog ({products.length})</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-2 pr-3">SKU</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Price (₹)</th>
                      <th className="py-2 pr-3">Stock</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.sku} className="border-b border-slate-100 last:border-0 transition-colors hover:bg-blue-50/40">
                        <td className="py-2 pr-3 font-semibold text-slate-800">{p.sku}</td>
                        <td className="py-2 pr-3 text-slate-600">{p.name}</td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={p.price}
                            disabled={busy}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v >= 0 && v !== Number(p.price)) {
                                void patchProduct(p.sku, { price: v });
                              }
                            }}
                            className={inputCls + " w-24"}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            defaultValue={p.stock_quantity}
                            disabled={busy}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isInteger(v) && v >= 0 && v !== p.stock_quantity) {
                                void patchProduct(p.sku, { stock_quantity: v });
                              }
                            }}
                            className={inputCls + " w-20"}
                          />
                        </td>
                        <td className="py-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void patchProduct(p.sku, { is_active: !p.is_active })}
                            className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-40 ${
                              p.is_active ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                            }`}
                          >
                            {p.is_active ? "active" : "inactive"}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!products.length && <tr><td colSpan={5} className="py-4 text-slate-400">Loading…</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* new product */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
              <h2 className="mb-3 text-lg font-bold text-slate-900">Add Product</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void createProduct(e.currentTarget);
                }}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                <input name="sku" required placeholder="SKU-010" className={inputCls} />
                <input name="name" required placeholder="Product name" className={inputCls} />
                <input name="price" type="number" step="0.01" min="0" required placeholder="Price (₹)" className={inputCls} />
                <input name="stock_quantity" type="number" min="0" step="1" required placeholder="Stock" className={inputCls} />
                <input name="description" placeholder="Description (optional)" className={inputCls + " sm:col-span-2"} />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 active:scale-[.98] disabled:opacity-50"
                >
                  + Create product
                </button>
              </form>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
