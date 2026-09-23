import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { describeError } from "@/lib/errors";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { AuthShell } from "./AuthShell";

export function Login() {
  const { session } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  if (session) return <Navigate to={from} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f: typeof fe = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) f.email = "Enter your email address";
    if (!password) f.password = "Enter your password";
    setFe(f); setError(null);
    if (Object.keys(f).length) return;
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(describeError(err));
  };

  return (
    <AuthShell title="Sign in" subtitle="Operations panel for V360 and KBB.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {error && <div role="alert" className="rounded bg-danger-soft px-3 py-2 text-[13.5px] text-danger">{error}</div>}
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fe.email} autoFocus />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={fe.password} />
        <Button type="submit" variant="primary" loading={busy} className="w-full">Sign in</Button>
        <p className="text-center text-[13.5px]"><Link to="/forgot-password" className="link">Forgot your password?</Link></p>
      </form>
    </AuthShell>
  );
}
