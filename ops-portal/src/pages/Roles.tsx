import { useEffect, useMemo, useState } from "react";
import { Copy, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useOps } from "@/context/OpsContext";
import { useDeleteRole, useOrganizations, usePermissionCatalog, useRoles, useSaveRole } from "@/hooks/useData";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import type { PermissionDef, RoleRow } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { TextArea, TextField } from "@/components/ui/Field";
import { ActionDialog } from "@/components/ActionDialog";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";

type Side = "v360" | "partner" | "brand";
const SIDE_LABEL: Record<Side, string> = { v360: "V360", partner: "KBB", brand: "Brands" };

/** The built-in admin of each kind of organization: every permission, not editable. */
const BUILT_IN: Record<Side, { name: string; text: string }> = {
  v360: { name: "V360 admin", text: "Every permission, plus every company's Team & access and Roles, and Shopify app credentials." },
  partner: { name: "KBB admin", text: "Every KBB permission, plus KBB's Team & access and Roles. V360 admins choose who is a KBB admin." },
  brand: { name: "Brand owner", text: "Every brand permission, plus the brand's staff and roles (managed in the brand portal)." },
};

/** Catalog entries for one side, grouped by area in catalog order. */
function groupByArea(catalog: PermissionDef[], side: Side): { area: string; perms: PermissionDef[] }[] {
  const groups: { area: string; perms: PermissionDef[] }[] = [];
  for (const p of catalog) {
    if (!p.applies_to.includes(side)) continue;
    const g = groups.find((x) => x.area === p.area);
    if (g) g.perms.push(p); else groups.push({ area: p.area, perms: [p] });
  }
  return groups;
}

type Draft = { id: string | null; orgId: string; side: Side; name: string; description: string; perms: Set<string> };

function RoleDialog({ draft, catalog, onClose }: { draft: Draft; catalog: PermissionDef[]; onClose: () => void }) {
  const save = useSaveRole({ inlineErrors: true });
  const [v, setV] = useState(draft);
  const [nameErr, setNameErr] = useState<string | null>(null);
  useEffect(() => { save.reset(); setV(draft); setNameErr(null); }, [draft]); // eslint-disable-line

  const groups = useMemo(() => groupByArea(catalog, v.side), [catalog, v.side]);
  const toggle = (keys: string[], on: boolean) => setV((s) => {
    const perms = new Set(s.perms);
    keys.forEach((k) => (on ? perms.add(k) : perms.delete(k)));
    return { ...s, perms };
  });
  const allowed = new Set(groups.flatMap((g) => g.perms.map((p) => p.key)));
  const selected = [...v.perms].filter((k) => allowed.has(k));

  const submit = () => {
    if (!v.name.trim()) { setNameErr("Give the role a name"); return; }
    save.mutate({ id: v.id, orgId: v.orgId, name: v.name, description: v.description, permissions: selected }, { onSuccess: onClose });
  };

  return (
    <Dialog open onClose={onClose} onSubmit={submit} width="lg" busy={save.isPending} error={save.error ? describeError(save.error) : null}
      title={v.id ? `Edit ${draft.name}` : "New role"}
      description="Tick everything people with this role may see and do. Changes apply the next time they load the portal."
      footer={<>
        <span className="mr-auto text-[13px] text-muted">{plural(selected.length, "permission")} of {allowed.size}</span>
        <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>{v.id ? "Save role" : "Create role"}</Button>
      </>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><TextField label="Role name" value={v.name} maxLength={60} autoFocus error={nameErr}
          onChange={(e) => { setV({ ...v, name: e.target.value }); setNameErr(null); }} placeholder="e.g. Warehouse" /></div>
        <div className="sm:col-span-2">
          <TextArea label="Description" optional rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })}
            placeholder="Who this role is for" />
        </div>
      </div>

      <div className="mt-5 max-h-[50vh] space-y-4 overflow-y-auto pr-1">
        {groups.map((g) => {
          const keys = g.perms.map((p) => p.key);
          const on = keys.filter((k) => v.perms.has(k)).length;
          return (
            <section key={g.area} className="rounded border border-line">
              <label className="flex cursor-pointer items-center gap-2.5 border-b border-line bg-sunken/50 px-3 py-2">
                <Checkbox checked={on === keys.length} indeterminate={on > 0 && on < keys.length}
                  onChange={() => toggle(keys, on < keys.length)} aria-label={`All ${g.area} permissions`} />
                <span className="flex-1 text-[13.5px] font-semibold">{g.area}</span>
                <span className="text-[12px] text-faint">{on} of {keys.length}</span>
              </label>
              <ul className="divide-y divide-line">
                {g.perms.map((p) => (
                  <li key={p.key}>
                    <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-sunken/40">
                      <Checkbox className="mt-0.5" checked={v.perms.has(p.key)} onChange={(e) => toggle([p.key], e.target.checked)} />
                      <span className="min-w-0">
                        <span className="block text-[13.5px]">{p.label}</span>
                        {p.description && <span className="block text-[12.5px] text-muted">{p.description}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

function RoleCard({ role, catalog, onEdit, onCopy, onDelete }: {
  role: RoleRow; catalog: PermissionDef[]; onEdit: () => void; onCopy: () => void; onDelete: () => void;
}) {
  const granted = new Set(role.role_permissions.map((p) => p.permission));
  const groups = groupByArea(catalog, role.org_type);
  const total = groups.reduce((n, g) => n + g.perms.length, 0);
  return (
    <li className="panel p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">{role.name}</h3>
            {role.is_preset && <span className="rounded border border-line bg-sunken px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Starter</span>}
          </div>
          {role.description && <p className="mt-0.5 text-[13px] text-muted">{role.description}</p>}
          <p className="mt-1 text-[12.5px] text-faint">{plural(role.member_count, "user")} · {granted.size} of {total} permissions</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
          <Button size="sm" variant="ghost" onClick={onCopy} title="Duplicate" aria-label={`Duplicate ${role.name}`}><Copy className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="danger-ghost" onClick={onDelete} title="Delete" aria-label={`Delete ${role.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {groups.map((g) => {
          const on = g.perms.filter((p) => granted.has(p.key)).length;
          if (on === 0) return null;
          return (
            <span key={g.area} title={g.perms.filter((p) => granted.has(p.key)).map((p) => p.label).join("\n")}
              className={`rounded-full border px-2 py-0.5 text-[12px] ${on === g.perms.length ? "border-primary/30 bg-primary-soft text-primary" : "border-line text-muted"}`}>
              {g.area}{on < g.perms.length ? ` ${on}/${g.perms.length}` : ""}
            </span>
          );
        })}
        {granted.size === 0 && <span className="text-[12.5px] text-g-problem">No permissions: users with this role can only see the dashboard.</span>}
      </div>
    </li>
  );
}

export function Roles() {
  const { isAdmin, orgId } = useOps();
  const orgsQ = useOrganizations();
  const catalog = usePermissionCatalog();
  const roles = useRoles();
  const del = useDeleteRole({ inlineErrors: true });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);

  // V360 admins manage every company; KBB admins only their own.
  const orgs = (orgsQ.data ?? []).filter((o) => isAdmin || o.id === orgId);
  const [picked, setPicked] = useState<string>("");
  const org = orgs.find((o) => o.id === picked) ?? orgs.find((o) => o.type === "v360") ?? orgs[0];

  const cat = catalog.data ?? [];
  const list = (roles.data ?? []).filter((r) => r.organization_id === org?.id);
  const edit = (r: RoleRow) => setDraft({ id: r.id, orgId: r.organization_id, side: r.org_type, name: r.name, description: r.description ?? "", perms: new Set(r.role_permissions.map((p) => p.permission)) });
  const copy = (r: RoleRow) => setDraft({ id: null, orgId: r.organization_id, side: r.org_type, name: `${r.name} (copy)`, description: r.description ?? "", perms: new Set(r.role_permissions.map((p) => p.permission)) });

  if (catalog.isLoading || roles.isLoading || orgsQ.isLoading) return <Spinner label="Loading roles" />;
  if (catalog.isError || roles.isError || orgsQ.isError) {
    return <ErrorState error={catalog.error ?? roles.error ?? orgsQ.error} onRetry={() => { void catalog.refetch(); void roles.refetch(); void orgsQ.refetch(); }} />;
  }
  if (!org) return <EmptyState title="No organization to manage" />;
  const side = org.type as Side;

  return (
    <>
      <PageHeader title="Roles & permissions" description="Build a role for each kind of job, then give people a role on the Team & access page."
        actions={<Button variant="primary" onClick={() => setDraft({ id: null, orgId: org.id, side, name: "", description: "", perms: new Set() })}><Plus className="h-4 w-4" /> New role</Button>} />

      {isAdmin && (
        <label className="mb-5 flex max-w-sm flex-col">
          <span className="field-label">Organization</span>
          <select className="input" value={org.id} onChange={(e) => setPicked(e.target.value)}>
            {(["v360", "partner", "brand"] as const).map((t) => (
              <optgroup key={t} label={SIDE_LABEL[t]}>
                {orgs.filter((o) => o.type === t).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      <section className="mb-8">
        <h2 className="mb-3">{org.name}</h2>
        <ul className="space-y-3">
          <li className="panel flex items-start gap-3 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
            <div>
              <h3 className="text-[15px] font-semibold">{BUILT_IN[side].name} <span className="ml-1 text-[12px] font-normal text-faint">built-in</span></h3>
              <p className="mt-0.5 text-[13px] text-muted">{BUILT_IN[side].text} Can't be edited, so nobody can be locked out.</p>
            </div>
          </li>
          {list.map((r) => (
            <RoleCard key={r.id} role={r} catalog={cat} onEdit={() => edit(r)} onCopy={() => copy(r)} onDelete={() => { del.reset(); setDeleting(r); }} />
          ))}
          {list.length === 0 && <EmptyState title="No roles yet">Staff need a role before they can see anything.</EmptyState>}
        </ul>
      </section>

      {draft && <RoleDialog draft={draft} catalog={cat} onClose={() => setDraft(null)} />}
      {deleting && (
        <ActionDialog open onClose={() => setDeleting(null)} busy={del.isPending} error={del.error ? describeError(del.error) : null} danger
          title={`Delete ${deleting.name}?`}
          description={deleting.member_count > 0
            ? `${plural(deleting.member_count, "user")} still ${deleting.member_count === 1 ? "has" : "have"} this role. Give them another role on the Team page first.`
            : "This can't be undone."}
          confirmLabel="Delete role" onConfirm={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })} />
      )}
    </>
  );
}
