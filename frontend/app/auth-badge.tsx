"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function AuthBadge() {
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");
  const [user, setUser] = useState<{ name: string; email: string; role: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    async function check() {
      const token = typeof window !== "undefined" ? sessionStorage.getItem("opsmate_auth_token") : null;
      if (!token) {
        setStatus("unauthenticated");
        return;
      }
      setStatus("loading");
      try {
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("unauthorized");
        const data = await res.json();
        if (!alive) return;
        setUser(data.user);
        setStatus("authenticated");
      } catch {
        sessionStorage.removeItem("opsmate_auth_token");
        setStatus("unauthenticated");
      }
    }
    check();
    return () => {
      alive = false;
    };
  }, []);

  async function signOut() {
    const token = sessionStorage.getItem("opsmate_auth_token");
    if (token) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    sessionStorage.removeItem("opsmate_auth_token");
    setStatus("unauthenticated");
    setUser(null);
    router.push("/login?next=/" );
  }

  return (
    <div className="signed-in">
      {status === "loading" && "Checking identity..."}
      {status === "authenticated" && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className={`pill ${user!.role === "admin" ? "admin" : "user"}`}>
                {user!.role === "admin" ? "Admin" : "User"}
              </span>
              <span className="text-sm text-muted">{user!.email}</span>
            </div>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        </>
      )}
      {status === "unauthenticated" && (
        <Link href="/login" className="pill">
          Sign in / create account
        </Link>
      )}
    </div>
  );
}

export default AuthBadge;
