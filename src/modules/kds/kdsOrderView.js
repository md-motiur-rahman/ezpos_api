/**
 * The KDS-safe projection of an order.
 *
 * WHY THIS EXISTS. Everything the KDS can reach is gated on VIEW_KDS, while
 * order data over REST is gated on ACCESS_TILL - and those two are
 * deliberately different populations. The Chef is the KDS's primary user and
 * is the one role that has never had till access (see permissions.js), so
 * `GET /orders/:id` correctly 403s them. Before this projection existed the
 * kitchen screen was nonetheless sent the FULL order detail on every push,
 * and 10.2's item-status endpoint returned it too - handing a VIEW_KDS-only
 * actor the entire payment ledger (method, amounts, tendered/change, the
 * provider reference), every discount, the VAT breakdown and the running
 * balance. That is data ACCESS_TILL exists to gate, arriving through the
 * wider gate.
 *
 * This is the same separation 8.2 already made when it kept quantityOnHand
 * and lowStockThreshold out of the PERFORM_HEALTH_SAFETY-gated scan response
 * so VIEW_INVENTORY-gated data could not leak through a wider gate. Same
 * principle, applied to money instead of stock.
 *
 * WHAT IS KEPT is exactly what a kitchen screen needs to cook and to know
 * when to stop: what was ordered, how many, which variant and modifiers,
 * where it goes, and the live prep/void/cancel state. `customerName` stays -
 * it is how a takeaway bag gets labelled and an order called out, i.e.
 * operational rather than financial.
 *
 * WHAT IS REMOVED is every monetary field, at all three nesting levels:
 *   order  - subtotal, itemDiscountTotal, discount, discountAmount, total,
 *            vatRate, vatExclusiveAmount, vatAmount, payments, amountPaid,
 *            amountRefunded, netAmountPaid, balanceDue
 *   item   - unitPrice, lineTotal, discount, total
 *   modifier - priceDelta
 *
 * Built by PICKING from the already-assembled detail response rather than by
 * re-querying or re-formatting: there is one definition of how an order is
 * shaped, and this is a strict narrowing of it, so the two can never drift.
 * It is also an allow-list, not a delete-list - a money field added to
 * toDetailResponse in a future submodule is excluded here automatically
 * rather than silently leaking until someone remembers to strip it.
 */
import { ORDER_ITEM_STATUSES } from '../orders/orderConstants.js';

/**
 * The ticket-level prep state, DERIVED from the individual item statuses and
 * never stored - "derive, don't store", the same philosophy as isLowStock
 * (7.3), lineTotal/subtotal (9.1) and discrepancy (7.6). The Chef still
 * updates items one at a time (10.2); this is the roll-up a kitchen screen
 * shows at the top of the ticket.
 *
 * The rule is the LOWEST status across the order's still-active items:
 * a ticket is only 'ready' once every line on it is ready, and it counts as
 * 'in_progress' the moment any single line is being worked. Anything else
 * would tell the kitchen a ticket is finished while food is still on the
 * pass. ORDER_ITEM_STATUSES is already declared in progression order, so
 * "lowest" is simply the smallest index - importing it keeps one definition
 * of that order rather than a second copy here that could drift.
 *
 * NAMED `kitchenStatus`, NOT `status`, and that matters: `order.status`
 * already means the business/payment state ('open', 'paid', 'cancelled').
 * Reusing the word would make one field name mean two entirely different
 * things at two nesting levels of the same payload - exactly the collision
 * 9.8 caught and avoided by renaming its ex-VAT figure to
 * `vatExclusiveAmount` because `netAmount` was already taken.
 *
 * Voided lines are excluded: they are no longer being made, so a voided item
 * left at 'pending' must not hold the whole ticket back. Returns null in the
 * degenerate case where nothing is active - 9.4 blocks voiding the last
 * active item, so a live order always has at least one, but inventing a
 * status for a ticket with nothing on it would be worse than saying so.
 */
function deriveKitchenStatus(items) {
  const active = items.filter((item) => !item.void);
  if (active.length === 0) {
    return null;
  }
  let lowest = ORDER_ITEM_STATUSES.length - 1;
  for (const item of active) {
    const index = ORDER_ITEM_STATUSES.indexOf(item.status);
    // An unrecognised status is treated as the earliest state rather than
    // ignored - failing toward "not ready yet" is the safe direction for a
    // kitchen.
    if (index === -1) {
      return ORDER_ITEM_STATUSES[0];
    }
    if (index < lowest) {
      lowest = index;
    }
  }
  return ORDER_ITEM_STATUSES[lowest];
}

function toKdsModifierView(modifier) {
  return {
    id: modifier.id,
    modifierOptionId: modifier.modifierOptionId,
    name: modifier.name,
  };
}

function toKdsItemView(item) {
  return {
    id: item.id,
    menuItemId: item.menuItemId,
    shopMenuItemId: item.shopMenuItemId,
    variantId: item.variantId,
    itemName: item.itemName,
    variantName: item.variantName,
    quantity: item.quantity,
    modifiers: item.modifiers.map(toKdsModifierView),
    // 10.2 - the live prep state this screen both renders and edits.
    status: item.status,
    statusUpdatedAt: item.statusUpdatedAt,
    statusUpdatedByActorType: item.statusUpdatedByActorType,
    statusUpdatedByActorId: item.statusUpdatedByActorId,
    // 9.4 - a voided line must still be shown so the kitchen knows to STOP
    // making it. Carries no monetary data of its own.
    void: item.void,
    createdAt: item.createdAt,
  };
}

export function toKdsOrderView(order) {
  return {
    id: order.id,
    shopId: order.shopId,
    // What the kitchen actually calls the ticket. The UUID above is useless
    // on a wall-mounted screen; this is the per-shop daily number staff read
    // out. Null only for orders created before order numbering shipped.
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    type: order.type,
    tableNumber: order.tableNumber,
    customerName: order.customerName,
    // The business/payment state ('open', 'paid', 'cancelled') - kept so the
    // kitchen can tell a cancelled ticket to stop. Distinct from
    // kitchenStatus below; see deriveKitchenStatus for why they are two
    // separate fields with two separate names.
    status: order.status,
    kitchenStatus: deriveKitchenStatus(order.items),
    items: order.items.map(toKdsItemView),
    // 9.4 - same reasoning as the per-item void above: the kitchen has to be
    // told the whole ticket is off. No monetary fields on this object.
    cancellation: order.cancellation,
    // 9.7 - null for every normally-created order. Kept because a synced
    // order's occurredAt is the only signal that a ticket is historical.
    occurredAt: order.occurredAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
