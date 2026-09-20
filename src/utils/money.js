/**
 * Every monetary value out of `pg` arrives as a STRING, not a number
 * (numeric columns always do) - verified empirically before 9.5's payment
 * submodule was built, because the failure mode is silent and expensive:
 * "10.00" + "5.55" evaluates to the string "10.005.55" rather than 15.55,
 * with no error anywhere. Every amount is funnelled through here before any
 * arithmetic touches it.
 *
 * Relocated here from order.service.js (originally local to that file) once
 * company.service.js's dashboard summary (Module 15.1) needed the exact
 * same mechanism for a second module - same "relocate and rename once a
 * second caller needs it" precedent as inventory's adjustInventoryQuantities.
 * Neither function has any DB or order-specific dependency, so src/utils/ is
 * the right home rather than picking one owning module - the same reasoning
 * that already put sql.js's buildUpdateSet here.
 */
export function toMoney(value) {
  return Number(value ?? 0);
}

/** Money is always settled to 2dp - kills IEEE-754 noise (0.1 + 0.2 = 0.30000000000000004) before it reaches a response or the DB. */
export function roundMoney(value) {
  return Number(value.toFixed(2));
}
