// Creates a user and gives them access to an organization (V360, KBB or a brand).
// Callers: V360 admins (any organization), KBB admins (their KBB org) and brand
// owners (their brand) — i.e. whoever can_manage_org() allows. Called from the
// ops portal's Team page and the brand portal's Team page.
//
// Body: { email, full_name?, organization_id, role, role_id?, password? }
//   - V360:  role "admin" (built-in, full access) or "operator" + role_id.
//   - KBB:   role "admin" (built-in KBB admin) or "partner_agent" + role_id.
//   - Brand: role "brand_owner" (built-in) or "brand_staff" + role_id.
//   role_id must be one of that organization's own roles.
//   - With password:    the account is created and confirmed immediately (no email needed).
//   - Without password: Supabase emails an invite link (needs working email / custom SMTP).
//   - If the email already has an account, it just adds the new membership.
//
// Set another user's password: { action: "set_password", user_id, password }
//   Allowed only if the caller manages EVERY organization that user belongs to, so a
//   brand owner or KBB admin can't take over an account that also has other access.
//   People change their own password in the portal (supabase.auth.updateUser).
//
// Secrets: OPS_PORTAL_URL, BRAND_PORTAL_URL (where invite links land), ALLOWED_ORIGINS.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPS_URL = (Deno.env.get("OPS_PORTAL_URL") ?? "http://localhost:5174").replace(/\/$/, "");
const BRAND_URL = (Deno.env.get("BRAND_PORTAL_URL") ?? "http://localhost:5173").replace(/\/$/, "");

const ROLES_BY_TYPE: Record<string, string[]> = {
  v360: ["admin", "operator"],
  partner: ["admin", "partner_agent"],
  brand: ["brand_owner", "brand_staff"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: { action?: string; user_id?: string; email?: string; full_name?: string; organization_id?: string; role?: string; role_id?: string; password?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request" }, 400); }

  if (body.action === "set_password") return setPassword(req, body.user_id ?? "", body.password ?? "");

  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.full_name ?? "").trim();
  const password = body.password ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return json(req, { error: "Enter a valid email address" }, 400);
  if (!body.organization_id || !body.role) return json(req, { error: "Choose an organization and a role" }, 400);
  if (password && password.length < 8) return json(req, { error: "Password must be at least 8 characters" }, 400);

  // 1. Caller must manage this organization
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: me, error: meErr } = await asUser.auth.getUser();
  if (meErr || !me.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);
  const { data: canManage } = await asUser.rpc("can_manage_org", { p_org_id: body.organization_id });
  if (!canManage) return json(req, { error: "You can't add people to this organization" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 2. Role must fit the organization
  const { data: org } = await admin.from("organizations").select("id, name, type").eq("id", body.organization_id).maybeSingle();
  if (!org) return json(req, { error: "Organization not found" }, 404);
  if (!ROLES_BY_TYPE[org.type]?.includes(body.role)) {
    return json(req, { error: `Role "${body.role}" isn't valid for ${org.name}` }, 400);
  }
  // Everyone except the built-in admins needs one of this organization's own roles.
  const needsCustomRole = body.role !== "admin" && body.role !== "brand_owner";
  let roleId: string | null = null;
  if (needsCustomRole) {
    if (!body.role_id) return json(req, { error: "Choose a role" }, 400);
    const { data: customRole } = await admin.from("roles").select("id, organization_id").eq("id", body.role_id).maybeSingle();
    if (!customRole || customRole.organization_id !== org.id) {
      return json(req, { error: `That role can't be used for ${org.name}` }, 400);
    }
    roleId = customRole.id;
  }

  // 3. Find or create the user
  let userId: string | null = null;
  let created = false;
  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();

  if (existing) {
    // Existing accounts: brand owners and KBB admins can set a password when they
    // create someone, so an account made outside V360/KBB may have a password
    // another company knows. Never hand such an account V360/KBB access, and
    // never let a brand or KBB pull in V360/KBB staff.
    const { data: mems } = await admin.from("memberships").select("organizations(type)").eq("user_id", existing.id);
    const types = (mems ?? []).flatMap((m) => {
      const o = (m as unknown as { organizations: { type: string } | { type: string }[] | null }).organizations;
      return (Array.isArray(o) ? o : o ? [o] : []).map((x) => x.type);
    });
    const hasOpsAccess = types.some((t) => t === "v360" || t === "partner");
    if ((org.type === "v360" || org.type === "partner") && !hasOpsAccess) {
      return json(req, {
        error: `${email} already has an account that wasn't created by V360 or KBB. Use a different email for this person.`,
      }, 409);
    }
    if (org.type === "brand" || org.type === "partner") {
      const { data: isV360Admin } = await asUser.rpc("is_v360_admin");
      const othersOps = types.some((t) => t === "v360" || (t === "partner" && org.type !== "partner"));
      if (!isV360Admin && othersOps) {
        return json(req, { error: `${email} belongs to another company and can't be added here.` }, 409);
      }
    }
    userId = existing.id;
  } else if (password) {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (error) return json(req, { error: error.message }, 400);
    userId = data.user.id;
    created = true;
  } else {
    const redirectTo = `${org.type === "brand" ? BRAND_URL : OPS_URL}/reset-password`;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo, data: { full_name: fullName } });
    if (error) {
      const msg = /invalid|not authorized|rate limit|smtp|sending/i.test(error.message)
        ? `The invite email couldn't be sent (${error.message}). Set a password instead, or set up custom SMTP in Supabase.`
        : error.message;
      return json(req, { error: msg }, 400);
    }
    userId = data.user.id;
    created = true;
  }

  // 4. Add the membership
  const { error: memErr } = await admin.from("memberships").insert({
    user_id: userId, organization_id: org.id, role: body.role, role_id: roleId,
  });
  if (memErr) {
    if (memErr.code === "23505") return json(req, { error: `${email} already has access to ${org.name}` }, 409);
    console.error(memErr);
    return json(req, { error: "The user was created but access couldn't be added. Try again." }, 500);
  }

  return json(req, {
    ok: true,
    created,
    invited: created && !password,
    message: existing
      ? `${email} now has access to ${org.name}`
      : password
        ? `${email} can sign in now with the password you set`
        : `Invite sent to ${email}`,
  });
});

async function setPassword(req: Request, userId: string, password: string) {
  if (!userId) return json(req, { error: "Choose a user" }, 400);
  if (password.length < 8) return json(req, { error: "Password must be at least 8 characters" }, 400);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: me, error: meErr } = await asUser.auth.getUser();
  if (meErr || !me.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);
  if (me.user.id === userId) return json(req, { error: "Change your own password from the menu instead" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: mems } = await admin.from("memberships").select("organization_id").eq("user_id", userId);
  const orgIds = [...new Set((mems ?? []).map((m) => m.organization_id as string))];
  if (orgIds.length === 0) return json(req, { error: "You can't change this person's password" }, 403);
  for (const orgId of orgIds) {
    const { data: canManage } = await asUser.rpc("can_manage_org", { p_org_id: orgId });
    if (!canManage) {
      return json(req, { error: "This person also has access somewhere you don't manage, so only a V360 admin can change their password" }, 403);
    }
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return json(req, { error: error.message }, 400);
  return json(req, { ok: true, message: "Password changed. Share it with them privately." });
}
