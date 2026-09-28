/**
 * Per-order amounts, computed in the database (migration 055) so every screen,
 * invoice and ledger uses the same numbers:
 *   cod  = cash KBB collects (0 when paid online, the unpaid part when partly paid)
 *   full = the whole order value, used for commissions
 * each in PKR and BDT (FX rate of the order date).
 */
export const MONEY_COLUMNS = "money_cod_pkr, money_cod_bdt, money_full_pkr, money_full_bdt";

export interface OrderMoneyColumns {
  money_cod_pkr?: number | null;
  money_cod_bdt?: number | null;
  money_full_pkr?: number | null;
  money_full_bdt?: number | null;
}

/** An amount in both currencies. */
export interface Amt { pkr: number; bdt: number }

export const ZERO: Amt = { pkr: 0, bdt: 0 };
export const addAmt = (a: Amt, b: Amt): Amt => ({ pkr: a.pkr + b.pkr, bdt: a.bdt + b.bdt });
export const subAmt = (a: Amt, b: Amt): Amt => ({ pkr: a.pkr - b.pkr, bdt: a.bdt - b.bdt });
export const scaleAmt = (a: Amt, k: number): Amt => ({ pkr: a.pkr * k, bdt: a.bdt * k });
export const sumAmt = (xs: Amt[]): Amt => xs.reduce(addAmt, ZERO);

export function orderMoney(o: OrderMoneyColumns): { cod: Amt; full: Amt; paidOnline: boolean } {
  const cod = { pkr: Number(o.money_cod_pkr ?? 0), bdt: Number(o.money_cod_bdt ?? 0) };
  const full = { pkr: Number(o.money_full_pkr ?? 0), bdt: Number(o.money_full_bdt ?? 0) };
  return { cod, full, paidOnline: cod.pkr < full.pkr - 0.005 };
}
