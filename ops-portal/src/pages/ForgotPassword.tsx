import { useState } from "react";
import { Link } from "react-router-dom";
import { MailCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { describeError } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { AuthShell } from "./AuthShell";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter the email you sign in with"); return; }
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (err) setError(describeError(err)); else setSent(true);
  };

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <div className="flex gap-3 rounded bg-primary-soft p-4 text-[14px]">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <p>If an account exists for <strong>{email.trim()}</strong>, we've sent a link to set a new password. It expires in one hour.</p>
        </div>
        <p className="mt-6 text-[13.5px]"><Link to="/login" className="link">Back to sign in</Link></p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={error} autoFocus />
        <Button type="submit" variant="primary" loading={busy} className="w-full">Send reset link</Button>
        <p className="text-center text-[13.5px]"><Link to="/login" className="link">Back to sign in</Link></p>
      </form>
    </AuthShell>
  );
}
