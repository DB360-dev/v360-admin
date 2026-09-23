import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { describeError } from "@/lib/errors";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/States";
import { AuthShell } from "./AuthShell";

/** Used for both password-reset links and first-time invite links. */
export function ResetPassword() {
  const { session, loading, clearRecovery } = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [errors, setErrors] = useState<{ pw?: string; pw2?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  if (loading) return <FullPageSpinner />;

  if (!session) {
    return (
      <AuthShell title="This link has expired" subtitle="Password links work once and expire after an hour.">
        <Link to="/forgot-password" className="link text-[14px]">Send a new link</Link>
      </AuthShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const er: typeof errors = {};
    if (pw.length < 8) er.pw = "Use at least 8 characters";
    if (pw !== pw2) er.pw2 = "Passwords don't match";
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErrors({ form: describeError(error) }); return; }
    clearRecovery();
    window.history.replaceState(null, "", window.location.pathname);
    toast.success("Password saved");
    navigate("/", { replace: true });
  };

  return (
    <AuthShell title="Choose a password" subtitle={`For ${session.user.email}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {errors.form && <div role="alert" className="rounded bg-danger-soft px-3 py-2 text-[13.5px] text-danger">{errors.form}</div>}
        <TextField label="New password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} error={errors.pw} hint="At least 8 characters" autoFocus />
        <TextField label="Confirm password" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} error={errors.pw2} />
        <Button type="submit" variant="primary" loading={busy} className="w-full">Save password</Button>
      </form>
    </AuthShell>
  );
}
