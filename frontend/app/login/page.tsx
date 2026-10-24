"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// ============================================================
// Login / Register Page — Tailwind CSS
// ============================================================
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSuccess(null);
  }, [mode]);

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError(null);
    setSuccess(null);
  };

  async function submit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    const params = new URLSearchParams(window.location.search);
    const next = params.get("next") || "/";

    try {
      const form = ev.currentTarget;
      const body: Record<string, string> = {
        email: (form.elements.namedItem("email") as HTMLInputElement).value,
        password: (form.elements.namedItem("password") as HTMLInputElement).value,
      };

      let res: Response;

      if (mode === "register") {
        body.name = (
          form.elements.namedItem("name") as HTMLInputElement
        ).value;

        res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "This action failed. Please try again.");
        return;
      }

      // Login issues a session token; register deliberately does NOT sign the
      // user in, so after signup the user stays here to log in explicitly.
      if (data.token) {
        sessionStorage.setItem("opsmate_auth_token", data.token);
      } else if (mode === "register" && res.ok) {
        setSuccess(
          `Account created for ${data.user?.name}. You are not signed in yet —
           switch to Login and enter the same email and password.`
        );
        setMode("login");
        return;
      }

      setSuccess(
        data.ok === false
          ? data.error
          : `Signed in as ${data.user?.name} (${
              data.user?.role === "admin" ? "admin" : "user"
            }). You can now use the app.`
      );

      // Only an actual login (token issued) navigates away from this page.
      if (data.token) {
        setTimeout(() => {
          window.location.href = next !== "/" ? next : "/";
        }, 600);
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClasses =
    "w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";

  const labelClasses = "mb-2 block text-sm font-medium text-slate-700";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
          <div className="px-6 py-8 sm:px-9 sm:py-10">
            {/* Header */}
            <div className="mb-7 text-center">
              <p className="mb-3 text-sm font-bold uppercase tracking-[0.25em] text-blue-600">
                OpsMate
              </p>

              <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
                {mode === "login"
                  ? "Sign in to OpsMate"
                  : "Create your OpsMate account"}
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {mode === "login"
                  ? "Access your orders and stock with a verified session."
                  : "Public registration always creates a normal user. Admins are created only by a trusted administrator."}
              </p>
            </div>

            {/* Login / Register Toggle */}
            <div className="mb-7 grid grid-cols-2 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => switchMode("login")}
                className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
                  mode === "login"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                Sign in
              </button>

              <button
                type="button"
                onClick={() => switchMode("register")}
                className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
                  mode === "register"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                Create account
              </button>
            </div>

            {/* Form */}
            <form
              className="space-y-5"
              noValidate
              onSubmit={submit}
            >
              {mode === "register" && (
                <div>
                  <label htmlFor="name" className={labelClasses}>
                    Full name
                  </label>

                  <input
                    id="name"
                    name="name"
                    type="text"
                    placeholder="Aakash Raval"
                    autoComplete="name"
                    required
                    className={inputClasses}
                  />
                </div>
              )}

              <div>
                <label htmlFor="email" className={labelClasses}>
                  Email address
                </label>

                <input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  className={inputClasses}
                />

                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Used for login and for verified identity.
                </p>
              </div>

              <div>
                <label htmlFor="password" className={labelClasses}>
                  Password
                </label>

                <input
                  id="password"
                  name="password"
                  type="password"
                  placeholder={
                    mode === "login"
                      ? "Enter your password"
                      : "At least 8 characters"
                  }
                  autoComplete={
                    mode === "login"
                      ? "current-password"
                      : "new-password"
                  }
                  required
                  minLength={mode === "register" ? 8 : undefined}
                  className={inputClasses}
                />

                {mode === "register" && (
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    At least 8 characters, one letter and one digit.
                  </p>
                )}
              </div>

              {/* Error Message */}
              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              {/* Success Message */}
              {success && (
                <div
                  role="status"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
                >
                  {success}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Please wait...
                  </>
                ) : mode === "login" ? (
                  "Sign in"
                ) : (
                  "Create account"
                )}
              </button>

              {/* Footer */}
              <div className="border-t border-slate-100 pt-5 text-center text-sm leading-6 text-slate-500">
                {mode === "login" ? (
                  <>
                    <p>
                      Trouble signing in? Ask your administrator to create an
                      account.
                    </p>

                    <Link
                      href="/"
                      className="mt-2 inline-block font-medium text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      Back to OpsMate
                    </Link>
                  </>
                ) : (
                  <>
                    <p>
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => switchMode("login")}
                        className="font-semibold text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        Sign in
                      </button>
                    </p>

                    <Link
                      href="/"
                      className="mt-2 inline-block font-medium text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      Back to OpsMate
                    </Link>
                  </>
                )}
              </div>
            </form>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-slate-400">
          OpsMate · Order & Inventory Management
        </p>
      </div>
    </main>
  );
}
