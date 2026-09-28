import { useEffect, useMemo, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useOps } from "@/context/OpsContext";
import { membershipRoleFields, useAddUser, useOrganizations, useRemoveMembership, useRoles, useTeam, useUpdateMembership } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { fmtDate } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/status";
import type { RoleRow, TeamMember } from "@/lib/types";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/Field";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/States";

const TYPE_LABEL: Record<string, string> = { v360: "V360", partner: "KBB", brand: "Brands" };

/** Built-in admin role of each kind of organization (full access, no custom role). */
const BUILT_IN: Record<string, { value: string; label: string }> = {
  v360: { value: "admin", label: "V360 admin (full access)" },
  partner: { value: "admin", label: "KBB admin (full access)" },
  brand: { value: "brand_owner", label: "Brand owner (full access)" },
};

/** Role picker options for one organization. Values as in membershipRoleFields(). */
function roleOptions(org: { id: string; type: string }, roles: RoleRow[]): { value: string; label: string }[] {
  const custom = roles.filter((r) => r.organization_id === org.id).map((r) => ({ value: `role:${r.id}`, label: r.name }));
  return [BUILT_IN[org.type], ...custom].filter(Boolean);
}

/** Current picker value for a member. */
function choiceOf(m: TeamMember): string {
  if (m.role === "admin" || m.role === "brand_owner") return m.role;
  return m.role_id ? `role:${m.role_id}` : "";
}

/** Readable role of a member. */
function roleLabel(m: TeamMember, roles: RoleRow[]): string {
  if (m.role === "admin" || m.role === "brand_owner") return BUILT_IN[m.organization_type]?.label.replace(" (full access)", "") ?? m.role;
  return roles.find((r) => r.id === m.role_id)?.name ?? (m.organization_type === "brand" ? ROLE_LABEL[m.role] ?? m.role : "No role (no access)");
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isAdmin, orgId } = useOps();
  // V360 admins add people anywhere; KBB admins only to KBB.
  const orgs = (useOrganizations().data ?? []).filter((o) => isAdmin || o.id === orgId);
  const add = useAddUser({ inlineErrors: true });
  const allRoles = useRoles().data ?? [];
  const [v, setV] = useState({ email: "", full_name: "", organization_id: "", role: "", password: "" });
  const [mode, setMode] = useState<"password" | "invite">("password");
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { add.reset(); setV({ email: "", full_name: "", organization_id: "", role: "", password: "" }); setErrs({}); setMode("password"); } }, [open]); // eslint-disable-line
  const org = orgs.find((o) => o.id === v.organization_id);
  const roles = org ? roleOptions(org, allRoles) : [];

  const submit = () => {
    const e: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = "Enter a valid email";
    if (!v.organization_id) e.org = "Choose an organization";
    if (!v.role) e.role = "Choose a role";
    if (mode === "password" && v.password.length < 8) e.password = "At least 8 characters";
    setErrs(e);
    if (Object.keys(e).length) return;
    const fields = membershipRoleFields(v.role, org?.type ?? "");
    add.mutate({ ...v, ...fields, email: v.email.trim(), password: mode === "password" ? v.password : "" }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onClose={onClose} onSubmit={submit} busy={add.isPending} error={add.error ? describeError(add.error) : null}
      title="Add a user" description="Give someone access to V360, KBB or a brand. If the email already has an account, they get the extra access."
      footer={<><Button onClick={onClose} disabled={add.isPending}>Cancel</Button><Button type="submit" variant="primary" loading={add.isPending}>Add user</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} error={errs.email} autoFocus />
        <TextField label="Full name" optional value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} />
        <label className="block">
          <span className="field-label">Organization</span>
          <select className="input" aria-invalid={!!errs.org} value={v.organization_id} onChange={(e) => {
            const o = orgs.find((x) => x.id === e.target.value);
            // Default to the first custom role, never to full access.
            setV({ ...v, organization_id: e.target.value, role: o ? roleOptions(o, allRoles).find((r) => r.value.startsWith("role:"))?.value ?? "" : "" });
          }}>
            <option value="">Choose…</option>
            {(["v360", "partner", "brand"] as const).map((t) => (
              <optgroup key={t} label={TYPE_LABEL[t]}>{orgs.filter((o) => o.type === t).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>
            ))}
          </select>
          {errs.org && <span className="mt-1.5 block text-[13px] text-danger">{errs.org}</span>}
        </label>
        <label className="block">
          <span className="field-label">Role</span>
          <select className="input" aria-invalid={!!errs.role} value={v.role} disabled={!org} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {!org ? <option value="">Choose an organization first</option> : roles.length === 0 && <option value="">No roles yet</option>}
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {errs.role ? <span className="mt-1.5 block text-[13px] text-danger">{errs.role}</span>
            : org && <span className="mt-1.5 block text-[13px] text-muted">Build roles in <Link to="/roles" className="link">Roles & permissions</Link>.</span>}
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="field-label">How they sign in</legend>
          <div className="flex flex-wrap gap-2">
            {([["password", "Set a password now"], ["invite", "Email them an invite"]] as const).map(([k, l]) => (
              <label key={k} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-[13.5px] ${mode === k ? "border-primary bg-primary-soft" : "border-line"}`}>
                <input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} className="accent-[rgb(var(--primary))]" />{l}
              </label>
            ))}
          </div>
        </fieldset>
        {mode === "password" ? (
          <div className="sm:col-span-2"><TextField label="Temporary password" type="text" autoComplete="off" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })}
            error={errs.password} hint="Share it with them privately. They can change it in their settings." /></div>
        ) : <p className="text-[13px] text-muted sm:col-span-2">Needs working email (custom SMTP) in Supabase. The invite link lets them choose a password.</p>}
      </div>
    </Dialog>
  );
}

export function Team() {
  const { isAdmin, canManageTeam, orgId } = useOps();
  const { user } = useAuth();
  // V360 admins manage everyone; KBB admins only KBB's members.
  const manages = (m: TeamMember) => canManageTeam && (isAdmin || m.organization_id === orgId);
  const q = useTeam();
  const roles = useRoles().data ?? [];
  const update = useUpdateMembership();
  const remove = useRemoveMembership({ inlineErrors: true });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [type, setType] = useState<"all" | "v360" | "partner" | "brand">("all");
  const rows = useMemo(() => (q.data ?? []).filter((m) => (isAdmin || m.organization_id === orgId) && (type === "all" || m.organization_type === type)),
    [q.data, type, isAdmin, orgId]);

  return (
    <>
      <PageHeader title="Team & access" description="Who can sign in, and what they can do."
        actions={canManageTeam && <Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" /> Add user</Button>} />
      {isAdmin && <div role="radiogroup" className="mb-4 inline-flex rounded border border-line p-0.5 text-[13px]">
        {([["all", "Everyone"], ["v360", "V360"], ["partner", "KBB"], ["brand", "Brands"]] as const).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={type === k} onClick={() => setType(k)} className={`rounded-[4px] px-3 py-1 ${type === k ? "bg-sunken font-medium" : "text-muted"}`}>{l}</button>
        ))}
      </div>}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="table-head"><tr><th>Name</th><th>Email</th><th>Organization</th><th>Role</th><th>Added</th><th /></tr></thead>
            {q.isLoading ? <SkeletonRows cols={6} rows={5} /> : (
              <tbody className="table-body">
                {rows.map((m) => {
                  const self = m.user_id === user?.id;
                  return (
                    <tr key={m.membership_id}>
                      <td className="font-medium">{m.full_name ?? "—"}{self && <span className="ml-1.5 text-[12px] text-faint">(you)</span>}</td>
                      <td className="text-muted">{m.email}</td>
                      <td>{m.organization_name}</td>
                      <td>
                        {manages(m) && !self && roleOptions({ id: m.organization_id, type: m.organization_type }, roles).length > 1 ? (
                          <select className="input h-8 w-auto" value={choiceOf(m)} aria-label={`Role for ${m.email}`}
                            onChange={(e) => update.mutate({ membershipId: m.membership_id, choice: e.target.value, orgType: m.organization_type })}>
                            {!choiceOf(m) && <option value="">No role (no access)</option>}
                            {roleOptions({ id: m.organization_id, type: m.organization_type }, roles).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        ) : roleLabel(m, roles)}
                      </td>
                      <td className="text-muted">{fmtDate(m.created_at)}</td>
                      <td className="text-right">{manages(m) && !self && <Button size="sm" variant="danger-ghost" onClick={() => { remove.reset(); setRemoving(m); }}>Remove</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && rows.length === 0 && <EmptyState icon={<Users className="h-6 w-6" />} title="Nobody here yet" />}

      </div>
      <AddUserDialog open={adding} onClose={() => setAdding(false)} />
      {removing && (
        <ActionDialog open onClose={() => setRemoving(null)} busy={remove.isPending} error={remove.error ? describeError(remove.error) : null} danger
          title={`Remove ${removing.email} from ${removing.organization_name}?`} description="They lose this access immediately. Their login still exists and can be given access again later."
          confirmLabel="Remove access" onConfirm={() => remove.mutate(removing.membership_id, { onSuccess: () => setRemoving(null) })} />
      )}
    </>
  );
}
