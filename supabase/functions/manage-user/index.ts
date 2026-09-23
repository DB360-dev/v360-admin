// Creates a user and gives them access to an organization (V360, KBB or a brand).
// Only V360 admins can call it. Called from the Admin panel's Team page.
//
// Body: { email, full_name?, organization_id, role, password? }
//   - With password:    the account is created and confirmed immediately (no email needed).
//   - Without password: Supabase emails an invite link (needs working email / custom SMTP).
//   - If the email already has an account, it just adds the new membership.
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
  partner: ["partner_agent"],
  brand: ["brand_owner", "brand_staff"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: { email?: string; full_name?: string; organization_id?: string; role?: string; password?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request" }, 400); }

  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.full_name ?? "").trim();
  const password = body.password ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return json(req, { error: "Enter a valid email address" }, 400);
  if (!body.organization_id || !body.role) return json(req, { error: "Choose an organization and a role" }, 400);
  if (password && password.length < 8) return json(req, { error: "Password must be at least 8 characters" }, 400);

  // 1. Caller must be a V360 admin
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: me, error: meErr } = await asUser.auth.getUser();
  if (meErr || !me.user) return json(req, { error: "Your session has expired. Please sign in again." }, 401);
  const { data: isAdmin } = await asUser.rpc("is_v360_admin");
  if (!isAdmin) return json(req, { error: "Only V360 admins can add users" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 2. Role must fit the organization
  const { data: org } = await admin.from("organizations").select("id, name, type").eq("id", body.organization_id).maybeSingle();
  if (!org) return json(req, { error: "Organization not found" }, 404);
  if (!ROLES_BY_TYPE[org.type]?.includes(body.role)) {
    return json(req, { error: `Role "${body.role}" isn't valid for ${org.name}` }, 400);
  }

  // 3. Find or create the user
  let userId: string | null = null;
  let created = false;
  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();

  if (existing) {
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
    user_id: userId, organization_id: org.id, role: body.role,
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
