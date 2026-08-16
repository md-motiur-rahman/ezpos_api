import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopMenuService from '../menu/shopMenu.service.js';
import * as orderRepository from './order.repository.js';
import * as companyRepository from '../company/company.repository.js';
import * as paymentProvider from './paymentProvider.js';
import { PAYABLE_ORDER_STATUSES, REFUNDABLE_ORDER_STATUSES } from './orderConstants.js';

/**
 * Every monetary value out of `pg` arrives as a STRING, not a number
 * (numeric columns always do) - verified empirically before this submodule
 * was built, because the failure mode is silent and expensive: "10.00" +
 * "5.55" evaluates to the string "10.005.55" rather than 15.55, with no
 * error anywhere. Every amount is funnelled through here before any
 * arithmetic touches it.
 */
function toMoney(value) {
  return Number(value ?? 0);
}

/** Money is always settled to 2dp - kills IEEE-754 noise (0.1 + 0.2 = 0.30000000000000004) before it reaches a response or the DB. */
function roundMoney(value) {
  return Number(value.toFixed(2));
}

/**
 * Confirmed directly: order creation/reading is a till operation, gated on
 * ACCESS_TILL - already exists (Manager, Shift Manager, Server have it by
 * default; Chef doesn't, which matches reality - kitchen staff don't run
 * the till).
 */
async function requireAccessTill(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.ACCESS_TILL, 'You do not have permission to access the till');
  return authority;
}

/**
 * Separate gate from ACCESS_TILL (9.3, confirmed directly) - Manager/Shift
 * Manager get it by default, Server/Chef don't but can be granted it via
 * 4.4's override system like any other permission, with zero extra code.
 *
 * 9.6 REUSES this same gate for refunds (confirmed directly) rather than
 * introducing a PROCESS_REFUND permission: giving money back is the same
 * class of till discretion as marking an order down, and the staff who can
 * do one are the staff trusted to do the other. Nothing about this function
 * changed for 9.6 - only a second set of callers.
 */
async function requireApplyDiscount(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.APPLY_DISCOUNT,
    'You do not have permission to apply discounts'
  );
  return authority;
}

function toListResponse(order) {
  return {
    id: order.id,
    shopId: order.shop_id,
    type: order.type,
    tableNumber: order.table_number,
    customerName: order.customer_name,
    status: order.status,
    createdByActorType: order.created_by_actor_type,
    createdByActorId: order.created_by_actor_id,
    itemCount: order.item_count,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function toModifierResponse(row) {
  return {
    id: row.id,
    modifierOptionId: row.modifier_option_id,
    name: row.option_name,
    priceDelta: Number(row.price_delta),
  };
}

/**
 * Shared by order rows and order_item rows (9.3) - both carry the identical
 * six discount_* columns. Returns null when no discount is set, so the
 * response contract for an undiscounted order/item is unchanged from
 * before 9.3 ever existed.
 */
function toDiscountResponse(row) {
  if (!row.discount_type) {
    return null;
  }
  return {
    type: row.discount_type,
    value: Number(row.discount_value),
    reason: row.discount_reason,
    appliedByActorType: row.discounted_by_actor_type,
    appliedByActorId: row.discounted_by_actor_id,
    appliedAt: row.discounted_at,
  };
}

/** percentage is 0-100 OF baseAmount; fixed is a currency amount already validated <= baseAmount at apply time. */
function computeDiscountAmount(baseAmount, discount) {
  if (!discount) {
    return 0;
  }
  const amount = discount.type === 'percentage' ? (baseAmount * discount.value) / 100 : discount.value;
  return Number(amount.toFixed(2));
}

/** order_items only (9.4) - null when this line has never been voided. */
function toVoidResponse(row) {
  if (!row.voided_at) {
    return null;
  }
  return {
    voidedAt: row.voided_at,
    voidedByActorType: row.voided_by_actor_type,
    voidedByActorId: row.voided_by_actor_id,
    reason: row.void_reason,
    wasPrepped: row.was_prepped,
  };
}

/** orders only (9.4) - null when this order has never been cancelled. */
function toCancellationResponse(order) {
  if (!order.cancelled_at) {
    return null;
  }
  return {
    cancelledAt: order.cancelled_at,
    cancelledByActorType: order.cancelled_by_actor_type,
    cancelledByActorId: order.cancelled_by_actor_id,
    reason: order.cancellation_reason,
    wasPrepped: order.was_prepped,
  };
}

function toItemResponse(row, modifiers) {
  const unitPrice = Number(row.unit_price);
  const modifierTotal = modifiers.reduce((sum, m) => sum + m.priceDelta, 0);
  // Computed, not stored - "derive, don't store", same philosophy as
  // isLowStock/discrepancy/totalCost elsewhere in this project. Unchanged
  // by 9.3/9.4: still the PRE-discount line amount, exactly as before.
  const lineTotal = Number(((unitPrice + modifierTotal) * row.quantity).toFixed(2));
  const discount = toDiscountResponse(row);
  const discountAmount = computeDiscountAmount(lineTotal, discount);
  return {
    id: row.id,
    menuItemId: row.menu_item_id,
    shopMenuItemId: row.shop_menu_item_id,
    variantId: row.variant_id,
    itemName: row.item_name,
    variantName: row.variant_name,
    quantity: row.quantity,
    unitPrice,
    modifiers,
    lineTotal,
    // New in 9.3 - null/0 for any item with no discount applied, so an
    // undiscounted response is unaffected in every field that existed
    // before this submodule.
    discount,
    total: Number((lineTotal - discountAmount).toFixed(2)),
    // New in 9.4 - null unless this line has been voided.
    void: toVoidResponse(row),
    createdAt: row.created_at,
  };
}

/** One refund row (9.6). `providerReference` is the REFUND's own reference (card only), not the original charge's. */
function toRefundResponse(row) {
  return {
    id: row.id,
    amount: toMoney(row.amount),
    reason: row.reason,
    providerReference: row.provider_reference,
    refundedByActorType: row.refunded_by_actor_type,
    refundedByActorId: row.refunded_by_actor_id,
    createdAt: row.created_at,
  };
}

/**
 * The ONE definition of "how much has been refunded" (9.6) - used both by
 * toPaymentResponse below (for the response) and by refundPayment (for the
 * refundable-balance check), so the number the till is shown and the number
 * the validation enforces can never disagree. Same reasoning as 9.5 summing
 * amountPaid in JS from the payment rows rather than via a second SQL
 * aggregate that could drift from the itemized list.
 */
function sumRefundAmounts(refunds) {
  return refunds.reduce((sum, refund) => sum + refund.amount, 0);
}

/**
 * One payment row (9.5). `change` is DERIVED here, never stored - what the
 * customer handed over minus what was actually credited to the order. Card
 * payments have no tendered/change concept at all, so both are null.
 *
 * `refunds` (9.6) is DEFAULTED to [], exactly as toDetailResponse defaults
 * `payments`, so this signature change cannot alter the behaviour of any
 * pre-9.6 caller. With no refunds, amountRefunded is 0 and netAmount equals
 * amount - i.e. every field 9.5 returned keeps its exact prior value.
 */
function toPaymentResponse(row, refunds = []) {
  const amount = toMoney(row.amount);
  const amountTendered = row.amount_tendered === null ? null : toMoney(row.amount_tendered);
  const amountRefunded = sumRefundAmounts(refunds);
  return {
    id: row.id,
    method: row.method,
    amount,
    amountTendered,
    change: amountTendered === null ? null : roundMoney(amountTendered - amount),
    providerReference: row.provider_reference,
    paidByActorType: row.paid_by_actor_type,
    paidByActorId: row.paid_by_actor_id,
    // New in 9.6 - empty/0/full-amount for a payment that has never been
    // refunded. netAmount is also exactly the amount still refundable
    // against this payment, which is what refundPayment validates against.
    refunds,
    amountRefunded: roundMoney(amountRefunded),
    netAmount: roundMoney(amount - amountRefunded),
    createdAt: row.created_at,
  };
}

function toDetailResponse(order, items, payments = []) {
  // Voided items (9.4) are kept in the response for audit but excluded from
  // every total below - they're no longer being charged. 9.1/9.2/9.3 never
  // produced a voided item, so this filter is a no-op for their tests and
  // changes nothing about previously-approved totals.
  const activeItems = items.filter((item) => !item.void);
  // Unchanged by 9.3/9.4: still the sum of pre-discount lineTotals, over
  // whichever items are actually still active.
  const subtotal = activeItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const itemDiscountTotal = activeItems.reduce((sum, item) => sum + (item.lineTotal - item.total), 0);
  const subtotalAfterItemDiscounts = subtotal - itemDiscountTotal;
  const discount = toDiscountResponse(order);
  const discountAmount = computeDiscountAmount(subtotalAfterItemDiscounts, discount);
  // Floored at 0 as a display-time safety net only - the real defense is
  // apply-time validation (see validateDiscountAgainstBase below); this
  // just guards the edge case where a valid-at-the-time line discount and a
  // valid-at-the-time order discount are applied at different moments and
  // would otherwise compound into a negative number.
  const total = Math.max(0, subtotalAfterItemDiscounts - discountAmount);
  // 9.5 - summed from the payment rows themselves rather than a SQL
  // SUM(), so there's exactly one definition of "amount paid" and no risk
  // of the aggregate and the itemized list disagreeing. (A SQL SUM() over
  // zero rows also returns NULL rather than 0 - verified empirically - so
  // this avoids that trap entirely.)
  //
  // amountPaid deliberately keeps its exact 9.5 meaning: GROSS, every
  // payment ever taken, ignoring refunds. 9.6 adds the refunded and net
  // figures as NEW fields alongside it rather than redefining it, so no
  // pre-9.6 consumer sees a changed number.
  const amountPaid = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const amountRefunded = payments.reduce((sum, payment) => sum + (payment.amountRefunded ?? 0), 0);
  const netAmountPaid = amountPaid - amountRefunded;
  return {
    id: order.id,
    shopId: order.shop_id,
    type: order.type,
    tableNumber: order.table_number,
    customerName: order.customer_name,
    status: order.status,
    createdByActorType: order.created_by_actor_type,
    createdByActorId: order.created_by_actor_id,
    // Full list, including any voided lines (audit trail) - only the
    // totals below exclude them.
    items,
    // Pre-tax, pre-discount, active-items-only - deliberately unchanged in
    // meaning. VAT (9.8) is still a separate, not-yet-built submodule; this
    // is not a final total. Cancelling the whole order does NOT zero this
    // out - `status`/`cancellation` are the authoritative "not charged"
    // signal, this stays a record of what the order contained. Refunding
    // (9.6) likewise does not alter it: what was ordered is unchanged by
    // money coming back out.
    subtotal: Number(subtotal.toFixed(2)),
    // New in 9.3 - all zero/null for an order with no discounts anywhere.
    itemDiscountTotal: Number(itemDiscountTotal.toFixed(2)),
    discount,
    discountAmount,
    total: Number(total.toFixed(2)),
    // New in 9.4 - null unless this order has been cancelled.
    cancellation: toCancellationResponse(order),
    // New in 9.5 - empty/0/full-total for an order with no payments, so
    // every field 9.1-9.4 already returned is unaffected.
    payments,
    amountPaid: roundMoney(amountPaid),
    // New in 9.6 - both 0/equal-to-amountPaid for an order with no refunds.
    amountRefunded: roundMoney(amountRefunded),
    netAmountPaid: roundMoney(netAmountPaid),
    // The ONE field 9.6 changes the formula of: was `total - amountPaid`,
    // now `total - netAmountPaid`. Provably identical for every order that
    // has never been refunded (amountRefunded is 0, so netAmountPaid ===
    // amountPaid), which is every order 9.1-9.5's tests produce - and
    // correctly REOPENS the balance once money is given back.
    balanceDue: roundMoney(Math.max(0, total - netAmountPaid)),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function getOrderOrThrow(shopId, orderId) {
  const order = await orderRepository.findOrderByIdForShop(orderId, shopId);
  if (!order) {
    throw new AppError('Order not found', 404);
  }
  return order;
}

/**
 * Fetch-and-format only, no permission check - shared by createOrder's
 * response and the public getOrder, same deliberate separation as
 * wastageLog.service.js's fetchWastageLogDetail (7.7): a future permission
 * change to either read or write shouldn't risk one silently re-checking
 * the other's requirement.
 */
async function fetchOrderDetail(shopId, orderId) {
  const order = await getOrderOrThrow(shopId, orderId);
  const itemRows = await orderRepository.listItemsForOrder(order.id);
  const modifierRows = await orderRepository.listModifiersForOrderItems(
    itemRows.map((row) => row.id)
  );
  const paymentRows = await orderRepository.listPaymentsForOrder(order.id);
  // 9.6 - one bulk query across every payment, not one per payment (same
  // N+1 avoidance as listModifiersForOrderItems above). Safe no-op returning
  // [] when the order has no payments at all.
  const refundRows = await orderRepository.listRefundsForPayments(
    paymentRows.map((row) => row.id)
  );

  const modifiersByOrderItemId = new Map();
  for (const row of modifierRows) {
    const list = modifiersByOrderItemId.get(row.order_item_id) ?? [];
    list.push(toModifierResponse(row));
    modifiersByOrderItemId.set(row.order_item_id, list);
  }

  const refundsByPaymentId = new Map();
  for (const row of refundRows) {
    const list = refundsByPaymentId.get(row.payment_id) ?? [];
    list.push(toRefundResponse(row));
    refundsByPaymentId.set(row.payment_id, list);
  }

  const items = itemRows.map((row) => toItemResponse(row, modifiersByOrderItemId.get(row.id) ?? []));
  const payments = paymentRows.map((row) =>
    toPaymentResponse(row, refundsByPaymentId.get(row.id) ?? [])
  );
  return toDetailResponse(order, items, payments);
}

/** Locates a resolved menu entry (master or local) for the requested item reference. */
function findResolvedItem(resolvedMenu, { menuItemId, shopMenuItemId }) {
  const id = menuItemId ?? shopMenuItemId;
  const source = menuItemId ? 'master' : 'local';
  return resolvedMenu.find((item) => item.id === id && item.source === source) ?? null;
}

/**
 * Resolves ONE requested order line against the shop's resolved menu
 * (shopMenuService.getResolvedMenu - already override-aware pricing and
 * enablement, built in Module 6 explicitly for this use rather than
 * re-derived here). Throws on the first problem found; nothing is written
 * to the DB until every line in the request has resolved successfully
 * (see createOrder below) - this project has no transaction wrapper to
 * roll back a partial write with, so validating everything up front is
 * the best available substitute.
 */
function resolveOrderLine(resolvedMenu, line) {
  const item = findResolvedItem(resolvedMenu, line);
  if (!item) {
    throw new AppError('Menu item not found', 404);
  }
  if (!item.isEnabled) {
    throw new AppError(`'${item.name}' is not currently available`, 400);
  }

  // Variant price is ABSOLUTE, replacing the item's own price - confirmed
  // directly in 7.9, deliberately NOT additive the way modifiers are below.
  let unitPrice = item.price;
  if (line.variantId) {
    const variant = item.variants.find((v) => v.id === line.variantId);
    if (!variant) {
      throw new AppError('Variant not found for this item', 404);
    }
    if (!variant.isEnabled) {
      throw new AppError(`'${variant.name}' is not currently available`, 400);
    }
    unitPrice = variant.price;
  }

  const requestedOptionIds = line.modifierOptionIds ?? [];
  const modifiers = [];

  for (const optionId of requestedOptionIds) {
    let found = null;
    for (const group of item.modifierGroups) {
      found = group.options.find((option) => option.id === optionId);
      if (found) break;
    }
    if (!found) {
      throw new AppError('Modifier option not found for this item', 404);
    }
    if (!found.isEnabled) {
      throw new AppError(`'${found.name}' is not currently available`, 400);
    }
    modifiers.push({ modifierOptionId: found.id, priceDelta: found.price });
  }

  // Every modifier group ATTACHED to this item (6.4) is checked against
  // its own min/max, whether the customer touched it or not - a group
  // with minSelections > 0 is required, one they never engaged with still
  // has 0 selections and correctly fails that check. Never enforced
  // anywhere until now, since no order flow existed to enforce it against.
  for (const group of item.modifierGroups) {
    const selectedInGroup = requestedOptionIds.filter((id) =>
      group.options.some((option) => option.id === id)
    ).length;
    if (selectedInGroup < group.minSelections || selectedInGroup > group.maxSelections) {
      throw new AppError(
        `'${group.name}' requires between ${group.minSelections} and ${group.maxSelections} selection(s)`,
        400
      );
    }
  }

  return {
    menuItemId: line.menuItemId ?? null,
    shopMenuItemId: line.shopMenuItemId ?? null,
    variantId: line.variantId ?? null,
    quantity: line.quantity,
    unitPrice,
    modifiers,
  };
}

/**
 * Writes already-resolved lines (+ their modifiers) for an order that
 * already exists - shared by createOrder and 9.2's addItemsToOrder, since
 * both need the identical "pre-generate ids, bulk-insert items, flatten
 * and bulk-insert modifiers" sequence. Extracted here (rather than
 * duplicated in addItemsToOrder) once a second caller needed it, same
 * "shared cross-module helpers... relocate once a second module needs the
 * same mechanism" precedent as inventory's adjustInventoryQuantities.
 * createOrder's own behavior is unchanged by this - same calls, same
 * order, still verified by its existing tests.
 */
async function writeResolvedItems(orderId, resolvedLines) {
  // Pre-generated, not left to the DB default - verified empirically that
  // explicit client-generated ids land correctly in a bulk unnest()
  // insert. Needed BEFORE order_item_modifiers can be inserted, since each
  // modifier row references its own line's id.
  const itemsToInsert = resolvedLines.map((line) => ({ id: crypto.randomUUID(), ...line }));
  await orderRepository.createOrderItems(orderId, itemsToInsert);

  const modifiersToInsert = itemsToInsert.flatMap((item) =>
    item.modifiers.map((modifier) => ({ orderItemId: item.id, ...modifier }))
  );
  await orderRepository.createOrderItemModifiers(modifiersToInsert);
}

export async function createOrder(actor, shopId, data) {
  await requireAccessTill(actor, shopId);

  const resolvedMenu = await shopMenuService.getResolvedMenu(actor, shopId);
  const resolvedLines = data.items.map((line) => resolveOrderLine(resolvedMenu, line));

  const order = await orderRepository.createOrder(shopId, {
    type: data.type,
    tableNumber: data.tableNumber,
    customerName: data.customerName,
    createdByActorType: actor.type,
    createdByActorId: actor.id,
  });

  await writeResolvedItems(order.id, resolvedLines);

  return fetchOrderDetail(shopId, order.id);
}

export async function listOrders(actor, shopId) {
  await requireAccessTill(actor, shopId);
  const orders = await orderRepository.listOrdersForShop(shopId);
  return orders.map(toListResponse);
}

export async function getOrder(actor, shopId, orderId) {
  await requireAccessTill(actor, shopId);
  return fetchOrderDetail(shopId, orderId);
}

/**
 * Appends items to an order that's already open (9.2) - a real gap 9.1
 * left, since order creation only accepted items up front with no way to
 * add more afterward. Only valid while status === 'open': ORDER_STATUSES
 * has just that one value today (confirmed minimal-for-now in 9.1), so
 * this check can't actually fail yet, but it's written now because 9.4
 * (cancellation) will introduce a status where adding items must be
 * rejected, and this is the natural place for that check to already exist.
 */
export async function addItemsToOrder(actor, shopId, orderId, data) {
  await requireAccessTill(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);

  if (order.status !== 'open') {
    throw new AppError(`Cannot add items to an order with status '${order.status}'`, 400);
  }

  const resolvedMenu = await shopMenuService.getResolvedMenu(actor, shopId);
  const resolvedLines = data.items.map((line) => resolveOrderLine(resolvedMenu, line));

  await writeResolvedItems(order.id, resolvedLines);

  return fetchOrderDetail(shopId, order.id);
}

/** A fixed discount can't exceed the amount it's being applied against - a percentage is already capped at 100 by the validation schema, so can never do this on its own. */
function validateDiscountAgainstBase(data, baseAmount) {
  if (data.discountType === 'fixed' && data.discountValue > baseAmount) {
    throw new AppError(
      `Discount amount cannot exceed the current amount (${baseAmount.toFixed(2)})`,
      400
    );
  }
}

const CLEARED_DISCOUNT = { discountType: null, discountValue: null, reason: null, actorType: null, actorId: null };

/**
 * Sets or clears the order-level discount (9.3), applied to the subtotal
 * AFTER any per-line discounts below. Same open-order guard as 9.2's
 * addItemsToOrder - can't discount an order that's no longer open.
 */
export async function setOrderDiscount(actor, shopId, orderId, data) {
  await requireApplyDiscount(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);

  if (order.status !== 'open') {
    throw new AppError(`Cannot modify discounts on an order with status '${order.status}'`, 400);
  }

  if (data.discountType === null) {
    await orderRepository.setOrderDiscount(order.id, CLEARED_DISCOUNT);
    return fetchOrderDetail(shopId, order.id);
  }

  // Validated against the CURRENT subtotal-after-item-discounts at the
  // moment of applying - a point-in-time check, not a permanent guarantee,
  // since 9.2 allows items to be added later (see toDetailResponse's
  // Math.max(0, ...) for the corresponding read-time safety net).
  const currentDetail = await fetchOrderDetail(shopId, order.id);
  const baseAmount = currentDetail.subtotal - currentDetail.itemDiscountTotal;
  validateDiscountAgainstBase(data, baseAmount);

  await orderRepository.setOrderDiscount(order.id, {
    discountType: data.discountType,
    discountValue: data.discountValue,
    reason: data.reason ?? null,
    actorType: actor.type,
    actorId: actor.id,
  });

  return fetchOrderDetail(shopId, order.id);
}

/**
 * Sets or clears one line's own discount (9.3), independent of any
 * order-level discount applied on top of it.
 */
export async function setOrderItemDiscount(actor, shopId, orderId, orderItemId, data) {
  await requireApplyDiscount(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);

  if (order.status !== 'open') {
    throw new AppError(`Cannot modify discounts on an order with status '${order.status}'`, 400);
  }

  const item = await orderRepository.findOrderItemForOrder(orderItemId, order.id);
  if (!item) {
    throw new AppError('Order item not found', 404);
  }
  // 9.4 - a voided item is no longer part of the order's charge, so
  // discounting it is meaningless. The only touch 9.4 makes to 9.3's code.
  if (item.voided_at) {
    throw new AppError('Cannot modify the discount on a voided item', 400);
  }

  if (data.discountType === null) {
    await orderRepository.setOrderItemDiscount(item.id, CLEARED_DISCOUNT);
    return fetchOrderDetail(shopId, order.id);
  }

  const modifierRows = await orderRepository.listModifiersForOrderItems([item.id]);
  const modifierTotal = modifierRows.reduce((sum, m) => sum + Number(m.price_delta), 0);
  const lineTotal = Number(((Number(item.unit_price) + modifierTotal) * item.quantity).toFixed(2));
  validateDiscountAgainstBase(data, lineTotal);

  await orderRepository.setOrderItemDiscount(item.id, {
    discountType: data.discountType,
    discountValue: data.discountValue,
    reason: data.reason ?? null,
    actorType: actor.type,
    actorId: actor.id,
  });

  return fetchOrderDetail(shopId, order.id);
}

/** Shared by cancelOrder and voidOrderItem below (9.4) - both are one-directional actions only valid while the order is still open. */
function requireOpenOrder(order) {
  if (order.status !== 'open') {
    throw new AppError(`Cannot modify an order with status '${order.status}'`, 400);
  }
}

/**
 * Cancels the whole order (9.4). `wasPrepped` is a required staff
 * declaration, not auto-detected - no KDS exists yet to know whether any
 * item had started prep (confirmed directly). One-directional: there's no
 * un-cancel, matching this project's "no reversal mechanism" philosophy for
 * an already-applied state change.
 */
export async function cancelOrder(actor, shopId, orderId, data) {
  await requireAccessTill(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);
  requireOpenOrder(order);

  await orderRepository.cancelOrder(order.id, {
    reason: data.reason ?? null,
    wasPrepped: data.wasPrepped,
    actorType: actor.type,
    actorId: actor.id,
  });

  return fetchOrderDetail(shopId, order.id);
}

/**
 * Voids one line item (9.4), independent of the rest of the order. Blocks
 * voiding the LAST remaining active item - confirmed directly as the
 * natural counterpart to createOrderSchema requiring at least one item at
 * creation; cancelling the whole order is the correct action once nothing
 * would be left.
 */
export async function voidOrderItem(actor, shopId, orderId, orderItemId, data) {
  await requireAccessTill(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);
  requireOpenOrder(order);

  const item = await orderRepository.findOrderItemForOrder(orderItemId, order.id);
  if (!item) {
    throw new AppError('Order item not found', 404);
  }
  if (item.voided_at) {
    throw new AppError('This item has already been voided', 400);
  }

  const allItems = await orderRepository.listItemsForOrder(order.id);
  const activeCount = allItems.filter((row) => !row.voided_at).length;
  if (activeCount <= 1) {
    throw new AppError(
      'Cannot void the last remaining item on an order - cancel the order instead',
      400
    );
  }

  await orderRepository.voidOrderItem(item.id, {
    reason: data.reason ?? null,
    wasPrepped: data.wasPrepped,
    actorType: actor.type,
    actorId: actor.id,
  });

  return fetchOrderDetail(shopId, order.id);
}

/**
 * Whether this company's card payments route through OUR payment provider.
 *
 * 'own' means the shop takes card on its own bank-supplied terminal: the
 * till still offers cash/card and still records the transaction as 'card',
 * but no provider is called, because the money was already taken out of band
 * on their machine. There is nothing for us to charge, and pretending to
 * charge it would produce a provider reference for a transaction we never
 * made.
 *
 * Falls back to 'platform' if the company row or the column is somehow
 * absent - that is the behaviour that has always existed, and defaulting the
 * other way could silently skip a real charge. The column is NOT NULL
 * DEFAULT 'platform', so this fallback should be unreachable in practice.
 */
function usesPlatformCardProcessing(company) {
  return (company?.card_payment_mode ?? 'platform') === 'platform';
}

/**
 * Records one payment against an order (9.5). Split/partial payment is
 * simply calling this more than once - same "multiple receipts per PO"
 * precedent as 7.6, rather than one row that gets topped up.
 *
 * The FIRST payment moves the order out of 'open' (to 'partially_paid' or
 * straight to 'paid'), which - confirmed directly - LOCKS it: 9.2's
 * addItemsToOrder, 9.3's discount setters and 9.4's cancel/void all guard
 * on `status === 'open'` and simply stop matching. Not one line in those
 * three submodules had to change for that to take effect.
 *
 * KNOWN LIMITATION, deliberately accepted: the balance is read immediately
 * before the insert, not inside a transaction - this project has no
 * transaction wrapper anywhere (see CLAUDE.md section 2), and 9.5 does not
 * introduce one. Two genuinely simultaneous payments against the same order
 * could therefore both pass the balance check. Flagged rather than hidden;
 * the single-till reality this is built for makes it a narrow window.
 *
 * Inventory is deliberately NOT touched here - 10.3 owns the deduction
 * trigger (confirmed directly), so stock moves on a KDS event, not on
 * payment.
 */
export async function recordPayment(actor, shopId, orderId, data) {
  await requireAccessTill(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);

  if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(`Cannot take payment on an order with status '${order.status}'`, 400);
  }

  // Reuses 9.3/9.4's already-correct derived total - discounts applied and
  // voided items excluded - rather than recomputing any of that here.
  const currentDetail = await fetchOrderDetail(shopId, order.id);
  const balanceDue = currentDetail.balanceDue;

  if (balanceDue <= 0) {
    throw new AppError('This order has no outstanding balance to pay', 400);
  }

  // Cash may be over-tendered (confirmed directly); only what's actually
  // owed is ever credited, and the difference comes back as change. Card
  // has nothing to give change from, so overpaying is simply rejected.
  let amountToCredit;
  let amountTendered = null;
  let providerReference = null;

  if (data.method === 'cash') {
    amountTendered = roundMoney(data.amountTendered);
    amountToCredit = Math.min(amountTendered, balanceDue);
  } else {
    amountToCredit = roundMoney(data.amount);
    if (amountToCredit > balanceDue) {
      throw new AppError(
        `Payment amount cannot exceed the outstanding balance (${balanceDue.toFixed(2)})`,
        400
      );
    }

    // Companies using their OWN card terminal skip the provider entirely -
    // the transaction is still recorded as 'card', it just has no provider
    // reference, exactly like cash has none. Resolved from the SHOP, since a
    // staff-authenticated till request never carries the owner's user id.
    const company = await companyRepository.findCompanyByShopId(shopId);
    if (usesPlatformCardProcessing(company)) {
      // The provider is charged BEFORE anything is written - a failed charge
      // must leave no payment row behind. (The reverse order would need a
      // compensating delete, which is exactly the kind of partial-write
      // cleanup this project has no transaction wrapper to make safe.)
      const result = await paymentProvider.chargeCard({
        amount: amountToCredit,
        orderId: order.id,
      });
      if (!result.success) {
        throw new AppError(result.failureReason ?? 'Card payment was declined', 402);
      }
      providerReference = result.providerReference;
    }
  }

  amountToCredit = roundMoney(amountToCredit);

  await orderRepository.createOrderPayment(order.id, {
    method: data.method,
    amount: amountToCredit,
    amountTendered,
    providerReference,
    actorType: actor.type,
    actorId: actor.id,
  });

  // netAmountPaid rather than amountPaid (9.6): provably the SAME number
  // here, because this function can only run on a 'open'/'partially_paid'
  // order and any refund immediately moves the status to
  // 'partially_refunded'/'refunded' - so amountRefunded is necessarily 0 on
  // every order that reaches this line. Using the net figure keeps this
  // correct by construction rather than by coincidence, should a later
  // submodule ever make a refunded order payable again.
  const newAmountPaid = roundMoney(currentDetail.netAmountPaid + amountToCredit);
  const nextStatus = newAmountPaid >= currentDetail.total ? 'paid' : 'partially_paid';
  await orderRepository.setOrderStatus(order.id, nextStatus);

  return fetchOrderDetail(shopId, order.id);
}

/**
 * Refunds part or all of ONE payment (9.6).
 *
 * Targets a specific payment rather than an order-level pool (confirmed
 * directly): a card refund has to reverse against that charge's own
 * provider reference, which an order-wide pool could not identify on a
 * split cash+card order. Partial refunds are simply calling this more than
 * once against the same payment - same "multiple payments per order" /
 * "multiple receipts per PO" precedent, rather than one row topped up.
 *
 * Gated on APPLY_DISCOUNT (confirmed directly), reusing 9.3's existing
 * permission rather than introducing a new one - Manager and Shift Manager
 * hold it by default, Server and Chef don't but can be granted it through
 * 4.4's override system like any other permission.
 *
 * order_payments is NEVER mutated - the correction is a new order_refunds
 * row, exactly as that table's own 9.5 migration comment anticipated.
 *
 * KNOWN LIMITATION, deliberately accepted and identical in shape to 9.5's:
 * the refundable balance is read immediately before the insert, not inside
 * a transaction (this project has no transaction wrapper anywhere, and 9.6
 * does not introduce one). Two genuinely simultaneous refunds against the
 * same payment could therefore both pass the check. Narrow window given the
 * single-till reality; flagged rather than hidden.
 */
export async function refundPayment(actor, shopId, orderId, paymentId, data) {
  await requireApplyDiscount(actor, shopId);
  const order = await getOrderOrThrow(shopId, orderId);

  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(`Cannot refund an order with status '${order.status}'`, 400);
  }

  // Scoped to this order in SQL, so a paymentId belonging to a different
  // order is a 404 rather than a cross-order refund - same precedent as
  // findOrderItemForOrder for 9.3/9.4's line-item routes.
  const payment = await orderRepository.findOrderPaymentForOrder(paymentId, order.id);
  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  const existingRefunds = await orderRepository.listRefundsForPayments([payment.id]);
  const alreadyRefunded = sumRefundAmounts(existingRefunds.map(toRefundResponse));
  // Exactly the `netAmount` the response exposes for this payment - same
  // helper, same rows, so the figure validated against and the figure the
  // till displays cannot diverge.
  const refundable = roundMoney(toMoney(payment.amount) - alreadyRefunded);

  if (refundable <= 0) {
    throw new AppError('This payment has already been fully refunded', 400);
  }

  const amount = roundMoney(data.amount);
  if (amount > refundable) {
    throw new AppError(
      `Refund amount cannot exceed the refundable balance of this payment (${refundable.toFixed(2)})`,
      400
    );
  }

  // The method is taken from the PAYMENT, never from the caller - a card
  // charge can only be refunded to that card, and cash only as cash.
  //
  // Whether to call the provider keys off THIS PAYMENT's own
  // provider_reference, deliberately NOT off the company's current
  // card_payment_mode. An owner may switch card terminals between taking a
  // payment and refunding it, and reading the live setting would then be
  // wrong in both directions: it could skip reversing a charge our provider
  // really did take (money left sitting on a customer's card), or call the
  // provider to reverse a charge it never made. A payment that has a
  // reference was processed by us and must be reversed by us; one without
  // was taken on the shop's own terminal and is refunded on that same
  // terminal, out of band - so we only record it. Correct by construction,
  // whatever the setting says today.
  let providerReference = null;
  if (payment.method === 'card' && payment.provider_reference) {
    // The provider is called BEFORE anything is written, same ordering and
    // same reason as recordPayment's charge above: a failed refund must
    // leave no order_refunds row behind, and this project has no
    // transaction wrapper to make a compensating delete safe.
    const result = await paymentProvider.refundCard({
      amount,
      providerReference: payment.provider_reference,
      orderId: order.id,
    });
    if (!result.success) {
      throw new AppError(result.failureReason ?? 'Card refund was declined', 402);
    }
    providerReference = result.providerReference;
  }

  await orderRepository.createOrderRefund(payment.id, {
    amount,
    reason: data.reason ?? null,
    providerReference,
    actorType: actor.type,
    actorId: actor.id,
  });

  // Recomputed across EVERY payment on the order, not just the one just
  // refunded - on a split cash+card order, fully refunding the cash leg
  // alone must still leave the order 'partially_refunded'. Read back
  // through fetchOrderDetail so there is one definition of netAmountPaid
  // rather than a second sum computed here that could drift from it.
  const detailAfterRefund = await fetchOrderDetail(shopId, order.id);
  const nextStatus = detailAfterRefund.netAmountPaid <= 0 ? 'refunded' : 'partially_refunded';
  await orderRepository.setOrderStatus(order.id, nextStatus);

  return fetchOrderDetail(shopId, order.id);
}
