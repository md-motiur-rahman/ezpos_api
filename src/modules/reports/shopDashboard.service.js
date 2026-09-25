import { AppError } from '../../utils/AppError.js';
import { roundMoney } from '../../utils/money.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopDashboardRepository from './shopDashboard.repository.js';

const TOP_ITEMS = 5;

/**
 * One shop's income, expense and best sellers. Needs VIEW_REPORTS, which the
 * owner holds and a Manager gets by default; a staff session can only ever
 * ask about their own shop (resolveActorAuthority 404s any other).
 *
 * Totals are summed here from the already-exact per-day rows and settled to
 * 2dp, the same way the company dashboard does it. Nothing is re-derived
 * from raw order data on the client.
 */
export async function getShopDashboard(actor, shopId, { days }) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.VIEW_REPORTS, 'You do not have permission to view reports');

  const [seriesRows, topItems] = await Promise.all([
    shopDashboardRepository.getSeries(shopId, days),
    shopDashboardRepository.getTopItems(shopId, days, TOP_ITEMS),
  ]);
  if (!seriesRows) {
    throw new AppError('Shop not found', 404);
  }

  const series = seriesRows.map((row) => ({
    date: row.day,
    revenue: Number(row.revenue),
    expense: Number(row.expense),
    orderCount: row.order_count,
  }));

  const sums = series.reduce(
    (acc, row) => {
      acc.revenue += row.revenue;
      acc.expense += row.expense;
      acc.orderCount += row.orderCount;
      return acc;
    },
    { revenue: 0, expense: 0, orderCount: 0 }
  );
  const revenue = roundMoney(sums.revenue);
  const expense = roundMoney(sums.expense);

  return {
    days,
    series,
    totals: {
      revenue,
      expense,
      net: roundMoney(revenue - expense),
      orderCount: sums.orderCount,
      averageOrder: sums.orderCount > 0 ? roundMoney(revenue / sums.orderCount) : 0,
    },
    topItems: topItems.map((row) => ({ name: row.name ?? 'Unknown item', quantity: row.quantity })),
  };
}
