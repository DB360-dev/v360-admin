import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { describeError } from "@/lib/errors";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/Field";

/** Signed-in user changes their own password. The current one is checked first. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [v, setV] = useState({ current: "", pw: "", pw2: "" });
  const [errs, setErrs] = useState<{ current?: string; pw?: string; pw2?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e: typeof errs = {};
    if (!v.current) e.current = "Enter your current password";
    if (v.pw.length < 8) e.pw = "Use at least 8 characters";
    else if (v.pw === v.current) e.pw = "Choose a different password from your current one";
    if (v.pw !== v.pw2) e.pw2 = "Passwords don't match";
    setErrs(e); setFormError(null);
    if (Object.keys(e).length || !user?.email) return;
    setBusy(true);
    const check = await supabase.auth.signInWithPassword({ email: user.email, password: v.current });
    if (check.error) { setBusy(false); setErrs({ current: "That's not your current password" }); return; }
    const { error } = await supabase.auth.updateUser({ password: v.pw });
    setBusy(false);
    if (error) { setFormError(describeError(error)); return; }
    toast.success("Password changed");
    onClose();
  };

  return (
    <Dialog open onClose={onClose} onSubmit={() => void submit()} busy={busy} error={formError} width="sm"
      title="Change your password" description={user?.email}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Change password</Button></>}>
      <div className="space-y-4">
        <TextField label="Current password" type="password" autoComplete="current-password" value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} error={errs.current} autoFocus />
        <TextField label="New password" type="password" autoComplete="new-password" value={v.pw} onChange={(e) => setV({ ...v, pw: e.target.value })} error={errs.pw} hint="At least 8 characters" />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" value={v.pw2} onChange={(e) => setV({ ...v, pw2: e.target.value })} error={errs.pw2} />
      </div>
    </Dialog>
  );
}
