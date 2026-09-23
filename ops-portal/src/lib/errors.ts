/**
 * Turns any error (Supabase database, auth, edge function, network) into
 * one clear sentence for the user. Workflow errors raised by our database
 * functions (code P0001) are already written for people, so we show them as-is.
 */

import { STATUS } from "./status";

/** Database messages quote internal status names ("hub_issue"); show the labels people see instead. */
function humanizeStatuses(msg: string): string {
  return msg.replace(/"([a-z_]+)"/g, (whole, key: string) =>
    key in STATUS ? `"${STATUS[key as keyof typeof STATUS].label}"` : whole);
}

type Maybe = { code?: string; message?: string; status?: number; name?: string; details?: string; context?: unknown };

const AUTH_MESSAGES: Record<string, string> = {
  "Invalid login credentials": "Email or password is incorrect.",
  "Email not confirmed": "Please confirm your email address first. Check your inbox for the link.",
  "User not found": "No account found with that email.",
  "New password should be different from the old password.": "Choose a password you haven't used before.",
};

export function isNetworkError(err: unknown): boolean {
  const m = (err as Maybe)?.message ?? "";
  return err instanceof TypeError || /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(m);
}

export function isSessionExpired(err: unknown): boolean {
  const e = err as Maybe;
  return e?.code === "PGRST301" || e?.code === "PGRST303" || /JWT expired|invalid JWT|refresh token/i.test(e?.message ?? "");
}

/** Errors that will fail the same way if retried. */
export function isPermanent(err: unknown): boolean {
  const code = (err as Maybe)?.code ?? "";
  return code === "P0001" || code === "42501" || code.startsWith("PGRST1") || code.startsWith("22") || code.startsWith("23") || isSessionExpired(err);
}

export function describeError(err: unknown): string {
  if (!err) return "Something went wrong. Please try again.";
  if (typeof err === "string") return err;
  if (!navigator.onLine || isNetworkError(err)) return "Can't reach the server. Check your internet connection and try again.";
  if (isSessionExpired(err)) return "Your session has expired. Please sign in again.";

  const e = err as Maybe;
  const msg = e.message ?? "";

  if (AUTH_MESSAGES[msg]) return AUTH_MESSAGES[msg];
  if (/rate limit|too many requests/i.test(msg) || e.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (/Password should be at least/i.test(msg)) return "Password must be at least 8 characters.";

  switch (e.code) {
    case "email_address_invalid": return "This email address can't be used. Check it for typos, or try a different address.";
    case "email_address_not_authorized": return "Emails can't be sent to this address yet. Please contact support.";
    case "over_email_send_rate_limit": return "Too many emails were sent recently. Please wait a few minutes and try again.";
    case "user_already_exists":
    case "email_exists": return "An account with this email already exists. Sign in instead.";
    case "weak_password": return "Choose a stronger password: at least 8 characters, mixing letters and numbers.";
    case "P0001": return humanizeStatuses(msg);                 // our workflow rules
    case "42501": return "You don't have permission to do that.";
    case "23505": return "That already exists.";
    case "23503": return "This refers to something that no longer exists. Refresh and try again.";
    case "22P02": return "Some of the information entered isn't in the right format.";
    case "PGRST116": return "We couldn't find that record. It may have been removed, or you may not have access.";
  }

  if (msg && msg.length < 200 && !/^\w+Error$/.test(msg)) return msg;
  return "Something went wrong. Please try again.";
}

/** Edge Functions return { error } JSON with a non-2xx status; dig it out. */
export async function describeFunctionError(err: unknown): Promise<string> {
  const ctx = (err as Maybe)?.context;
  if (ctx instanceof Response) {
    try {
      const body = await ctx.clone().json();
      if (body?.error) return String(body.error);
    } catch { /* not JSON */ }
    if (ctx.status === 401) return "Your session has expired. Please sign in again.";
  }
  return describeError(err);
}
