import { useAuth } from "@/context/AuthContext";
import { useOps } from "@/context/OpsContext";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/States";
import { AuthShell } from "./AuthShell";

export function NoAccess() {
  const { user, signOut } = useAuth();
  const { brandOnly, error, refetch } = useOps();
  if (error) return <AuthShell title="We couldn't load your account"><ErrorState error={error} onRetry={refetch} /></AuthShell>;
  return (
    <AuthShell
      title={brandOnly ? "This panel is for operations staff" : "No access yet"}
      subtitle={brandOnly
        ? "Your account belongs to a brand. Sign in to the brand portal instead."
        : `${user?.email} isn't part of V360 or KBB yet. Ask a V360 admin to add you under Team & access.`}>
      <div className="flex gap-2">
        <Button onClick={refetch}>Check again</Button>
        <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </AuthShell>
  );
}
