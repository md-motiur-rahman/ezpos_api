import { query } from '../../db/pool.js';

/**
 * One shop's day-by-day money, over the trailing `days` calendar days
 * (including today). Same definitions as the company dashboard
 * (companyRepository.getDashboardSummary), narrowed to one shop:
 *   revenue = payments taken minus refunds, by the day each was recorded;
 *   expense = purchase-order cost (quantity * unit_cost, unpriced lines
 *             contribute nothing);
 *   orders  = orders created that day.
 * Each side is aggregated to one row per day in its own CTE before joining,
 * so an order with several payments/refunds can't fan out and double count.
 */
export async function getSeries(shopId, days) {
  const { rows } = await query(
    `WITH bounds AS (
       SELECT (current_date - ($2::int - 1)) AS start_day, current_date AS end_day
     ),
     days AS (
       SELECT generate_series(start_day, end_day, interval '1 day')::date AS day FROM bounds
     ),
     payments AS (
       SELECT op.created_at::date AS day, SUM(op.amount) AS amount
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       WHERE o.shop_id = $1 AND op.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     refunds AS (
       SELECT orf.created_at::date AS day, SUM(orf.amount) AS amount
       FROM order_refunds orf
       JOIN order_payments op ON op.id = orf.payment_id
       JOIN orders o ON o.id = op.order_id
       WHERE o.shop_id = $1 AND orf.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     expenses AS (
       SELECT po.ordered_at::date AS day, COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS amount
       FROM purchase_orders po
       JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.shop_id = $1 AND po.deleted_at IS NULL
         AND po.ordered_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     order_counts AS (
       SELECT o.created_at::date AS day, count(*) AS count
       FROM orders o
       WHERE o.shop_id = $1 AND o.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            COALESCE(payments.amount, 0) - COALESCE(refunds.amount, 0) AS revenue,
            COALESCE(expenses.amount, 0) AS expense,
            COALESCE(order_counts.count, 0)::int AS order_count
     FROM days
     LEFT JOIN payments ON payments.day = days.day
     LEFT JOIN refunds ON refunds.day = days.day
     LEFT JOIN expenses ON expenses.day = days.day
     LEFT JOIN order_counts ON order_counts.day = days.day
     ORDER BY days.day`,
    [shopId, days]
  );
  return rows;
}

/** Best sellers by number sold, leaving out cancelled orders and voided lines. */
export async function getTopItems(shopId, days, limit) {
  const { rows } = await query(
    `SELECT COALESCE(mi.name, smi.name) AS name, SUM(oi.quantity)::int AS quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     LEFT JOIN shop_menu_items smi ON smi.id = oi.shop_menu_item_id
     WHERE o.shop_id = $1
       AND o.created_at::date >= (current_date - ($2::int - 1))
       AND o.cancelled_at IS NULL
       AND oi.voided_at IS NULL
     GROUP BY 1
     ORDER BY quantity DESC, name
     LIMIT $3`,
    [shopId, days, limit]
  );
  return rows;
}
