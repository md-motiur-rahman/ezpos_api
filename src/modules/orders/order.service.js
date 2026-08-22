import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopMenuService from '../menu/shopMenu.service.js';
import * as orderRepository from './order.repository.js';
import * as shopRepository from '../shop/shop.repository.js';
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
 * The VAT rate to SNAPSHOT onto a brand-new order (9.8) - called once, at
 * creation time only (createOrder, and 9.7's syncOfflineOrder), never at
 * read time. See orders.vat_rate's migration comment for why this is a
 * snapshot rather than a live lookup: a sale's VAT rate is a historical/
 * compliance fact about that sale, not something that should silently
 * change if the shop's settings change later.
 *
 * Always returns a definite number for a shop that exists - never null -
 * because every NEW order gets an explicit rate recorded, even 0. Two
 * cases collapse to 0, deliberately, per the confirmed design: a shop
 * that isn't VAT-registered charges no VAT regardless of any leftover
 * `default_vat_rate` value; a shop that IS registered but has never
 * configured a rate is treated as 0% rather than blocking order creation
 * over the OWNER's own misconfiguration (till staff have no way to fix
 * that mid-sale). This does not touch shop.validation.js - the ambiguous
 * state (registered, no rate) is still allowed to exist there, exactly as
 * it does today.
 *
 * `shop` is allowed to be null/undefined defensively, same style as
 * usesPlatformCardProcessing's fallback below - in practice requireAccessTill
 * having already succeeded means the shop necessarily exists.
 */
function resolveVatRate(shop) {
  if (!shop?.vat_registered) {
    return 0;
  }
  return toMoney(shop.default_vat_rate);
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
    // New in 9.7 - both null for every order created through the normal
    // online flow, so this list's existing shape is unchanged for them.
    // Present here (and not only on the detail response) so a till coming
    // back online can reconcile its local queue against what actually
    // landed, without fetching each order individually.
    clientOrderId: order.client_order_id ?? null,
    occurredAt: order.occurred_at ?? null,
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

/**
 * Decomposes an already-rounded `total` into its VAT components (9.8),
 * using the rate SNAPSHOTTED on the order at creation time
 * (order.vat_rate) - never a live lookup of the shop's current settings,
 * see orders.vat_rate's migration comment.
 *
 * `total` is treated as VAT-INCLUSIVE (confirmed directly): the amount the
 * customer is charged does not change - this only decomposes it into
 * vatExclusiveAmount + vatAmount for reporting/receipt purposes.
 *
 * vatAmount is deliberately the REMAINDER (total - vatExclusiveAmount), not
 * an independently-computed `total * rate / 100` - so the two always
 * reconcile to `total` EXACTLY, by construction, never by coincidence
 * (same "one definition of a total" discipline as 9.5's amountPaid / 9.6's
 * sumRefundAmounts). Division-by-zero is not possible: the denominator is
 * `1 + vatRate/100`, which is 1 at the lowest (0%), never 0.
 *
 * order.vat_rate is NULL for any order created before 9.8 shipped - an
 * honest "VAT was never calculated for this historical order" rather than
 * a fabricated 0%, so all three fields come back null together in that
 * case rather than silently reporting no VAT.
 */
function toVatResponse(order, total) {
  if (order.vat_rate === null) {
    return { vatRate: null, vatExclusiveAmount: null, vatAmount: null };
  }
  const vatRate = toMoney(order.vat_rate);
  const vatExclusiveAmount = roundMoney(total / (1 + vatRate / 100));
  const vatAmount = roundMoney(total - vatExclusiveAmount);
  return { vatRate, vatExclusiveAmount, vatAmount };
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
  // The single rounded value used for BOTH the `total` field below and the
  // VAT decomposition (9.8) - so the two can never disagree by a penny of
  // floating-point noise from being rounded independently in two places.
  const roundedTotal = Number(total.toFixed(2));
  const vat = toVatResponse(order, roundedTotal);
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
    // Pre-discount, active-items-only - deliberately unchanged in meaning.
    // Still VAT-INCLUSIVE (9.8 decomposes `total` into net+VAT below, it
    // never adds to it - see `vatAmount`). Cancelling the whole order does
    // NOT zero this out - `status`/`cancellation` are the authoritative
    // "not charged" signal, this stays a record of what the order
    // contained. Refunding (9.6) likewise does not alter it: what was
    // ordered is unchanged by money coming back out.
    subtotal: Number(subtotal.toFixed(2)),
    // New in 9.3 - all zero/null for an order with no discounts anywhere.
    itemDiscountTotal: Number(itemDiscountTotal.toFixed(2)),
    discount,
    discountAmount,
    total: roundedTotal,
    // New in 9.8 - null/null/null for any order created before 9.8 shipped
    // (order.vat_rate was never snapshotted for it); 0/total/0 for an order
    // from a non-VAT-registered shop. `total` above is UNCHANGED by this -
    // it was always "pre-VAT-decomposition", never "VAT-free" (see the 9.1
    // comment this replaces) - vatAmount/vatExclusiveAmount merely decompose
    // it, they never add to what the customer is charged.
    //
    // Named `vatExclusiveAmount`, NOT `netAmount` - 9.6 already uses
    // `netAmount` inside each payment object to mean "still refundable
    // against this payment" (net of REFUNDS). Reusing the word here for
    // "net of VAT" would make the same field name mean two different
    // things at two nesting levels of the same response.
    vatRate: vat.vatRate,
    vatExclusiveAmount: vat.vatExclusiveAmount,
    vatAmount: vat.vatAmount,
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
    // New in 9.7 - both null for every order created through the normal
    // online flow (9.1's POST /orders), which is every order 9.1-9.6's
    // tests produce, so no previously-approved response value changes.
    // occurredAt is a timestamptz (a real instant), NOT a `date`, so the
    // 8.2 local-midnight trap does not apply and it serializes correctly.
    clientOrderId: order.client_order_id ?? null,
    occurredAt: order.occurred_at ?? null,
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
 *
 * 9.7's offline sync is the THIRD caller, reusing it completely unchanged:
 * once a queued line has been structurally validated it is in exactly the
 * same shape an online resolved line is, so it writes through the identical
 * path.
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

  // 9.8 - the VAT rate is SNAPSHOTTED here, once, at creation time - see
  // resolveVatRate and orders.vat_rate's migration comment for why this is
  // never re-derived later from the shop's current settings.
  const shop = await shopRepository.findActiveShopById(shopId);

  const order = await orderRepository.createOrder(shopId, {
    type: data.type,
    tableNumber: data.tableNumber,
    customerName: data.customerName,
    createdByActorType: actor.type,
    createdByActorId: actor.id,
    vatRate: resolveVatRate(shop),
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

// --- Offline sync (9.7) ---

/**
 * Structurally validates ONE queued offline line.
 *
 * DELIBERATELY NOT resolveOrderLine, and the differences are the substance
 * of 9.7 rather than an oversight. This checks only that the references are
 * real and belong to this shop; it takes every PRICE from the client.
 *
 *  - The price is NOT re-derived from the live menu (confirmed directly).
 *    The sale already completed on the device at the price the customer was
 *    charged and, for cash, the money is already in the drawer. Re-pricing
 *    it here against a menu that may have changed since would make the
 *    stored record disagree with the receipt the customer holds, and would
 *    make the drawer fail to reconcile.
 *  - `isEnabled` is NOT checked, for items, variants or modifier options.
 *    An item disabled or 86'd AFTER the offline sale must still sync -
 *    rejecting it would discard a real sale that really happened, which is
 *    strictly worse than recording a sale of something now unavailable.
 *  - 6.4's modifier group min/max is NOT enforced (unlike resolveOrderLine,
 *    which enforces it for the first time in 9.1). The offline till already
 *    enforced it at sale time against its cached menu; re-enforcing against
 *    a group whose configuration has since changed would reject a
 *    legitimately-completed sale for a rule that did not exist when it was
 *    made.
 *
 * What IS still enforced is the part that protects tenancy and referential
 * integrity: the item must exist in THIS shop's resolved menu, and any
 * variant/modifier option must genuinely belong to that item. Without this
 * an offline payload could name another company's menu item, or a modifier
 * from an unrelated item, and the FK constraints alone would not catch it.
 *
 * KNOWN LIMITATION, flagged rather than hidden: getResolvedMenu excludes
 * SOFT-DELETED items, so an item deleted between the offline sale and the
 * sync produces a 404 here. Deleting a menu item mid-service is rare and
 * the offline window is expected to be short, but a sale of a since-deleted
 * item cannot currently be synced.
 */
function resolveOfflineOrderLine(resolvedMenu, line) {
  const item = findResolvedItem(resolvedMenu, line);
  if (!item) {
    throw new AppError('Menu item not found', 404);
  }

  if (line.variantId) {
    const variant = item.variants.find((v) => v.id === line.variantId);
    if (!variant) {
      throw new AppError('Variant not found for this item', 404);
    }
  }

  const modifiers = [];
  for (const requested of line.modifiers ?? []) {
    let found = null;
    for (const group of item.modifierGroups) {
      found = group.options.find((option) => option.id === requested.modifierOptionId);
      if (found) break;
    }
    if (!found) {
      throw new AppError('Modifier option not found for this item', 404);
    }
    // The option's IDENTITY is validated against the live menu; its PRICE
    // comes from the client, for the same reason unitPrice does.
    modifiers.push({ modifierOptionId: found.id, priceDelta: roundMoney(requested.priceDelta) });
  }

  return {
    menuItemId: line.menuItemId ?? null,
    shopMenuItemId: line.shopMenuItemId ?? null,
    variantId: line.variantId ?? null,
    quantity: line.quantity,
    unitPrice: roundMoney(line.unitPrice),
    modifiers,
  };
}

/**
 * Builds the canonical string whose hash decides replay-vs-collision.
 *
 * Constructed field by field in a FIXED order from the already-validated
 * payload, deliberately rather than hashing the raw request body:
 * JSON.stringify preserves insertion order for string keys, so building the
 * object explicitly here makes the output independent of whatever key order
 * the client happened to serialize, and independent of any extra keys zod
 * stripped. Money is normalized through roundMoney first so that 10, 10.0
 * and 10.00 all hash identically, and occurredAt through toISOString() so
 * that '...T10:00:00Z' and '...T10:00:00.000Z' do too - otherwise a client
 * that reformats its own queue entry between retries would get a spurious
 * 409 on what is genuinely the same sale.
 *
 * shopId is included so the hash is meaningless outside its shop, even
 * though the lookup is already shop-scoped - defence in depth, at no cost.
 *
 * Item and modifier ORDER is significant: a payload with the same lines in a
 * different sequence hashes differently and is treated as a collision. That
 * is the deliberate, safer direction - a device replaying its own queue
 * entry re-sends the identical serialization, so a reorder is far more
 * likely to indicate a genuinely different payload than a benign reshuffle.
 */
function canonicalizeSyncPayload(shopId, data) {
  return JSON.stringify({
    shopId,
    clientOrderId: data.clientOrderId,
    occurredAt: new Date(data.occurredAt).toISOString(),
    type: data.type,
    tableNumber: data.tableNumber ?? null,
    customerName: data.customerName ?? null,
    items: data.items.map((item) => ({
      menuItemId: item.menuItemId ?? null,
      shopMenuItemId: item.shopMenuItemId ?? null,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      unitPrice: roundMoney(item.unitPrice),
      modifiers: (item.modifiers ?? []).map((modifier) => ({
        modifierOptionId: modifier.modifierOptionId,
        priceDelta: roundMoney(modifier.priceDelta),
      })),
    })),
    payment:
      data.payment.method === 'cash'
        ? { method: 'cash', amountTendered: roundMoney(data.payment.amountTendered) }
        : { method: 'card', amount: roundMoney(data.payment.amount) },
  });
}

function hashSyncPayload(shopId, data) {
  return crypto.createHash('sha256').update(canonicalizeSyncPayload(shopId, data)).digest('hex');
}

/**
 * The order total, derived from the resolved lines BEFORE anything is
 * written.
 *
 * This exists so that every validation 9.7 performs can happen ahead of the
 * first INSERT - see syncOfflineOrder for why that ordering is critical
 * (a throw after the header lands would permanently burn the
 * clientOrderId). It cannot wait for fetchOrderDetail, which by definition
 * can only run after the rows exist.
 *
 * The arithmetic MIRRORS toItemResponse/toDetailResponse exactly, including
 * where it rounds: each line is settled to 2dp individually first, then the
 * lines are summed, then the sum is settled again. Rounding only at the end
 * would disagree with the stored order by a penny on some inputs. A synced
 * order has no discounts and no voided items, so total === subtotal here
 * and the two paths are the same calculation on the same numbers - asserted
 * by a test that syncs an order and checks this credit against the total
 * that comes back from the database, rather than assumed.
 */
function computeResolvedLinesTotal(resolvedLines) {
  const subtotal = resolvedLines.reduce((sum, line) => {
    const modifierTotal = line.modifiers.reduce((acc, modifier) => acc + modifier.priceDelta, 0);
    const lineTotal = Number(((line.unitPrice + modifierTotal) * line.quantity).toFixed(2));
    return sum + lineTotal;
  }, 0);
  return Number(subtotal.toFixed(2));
}

/**
 * Syncs one order that was rung up and PAID while the till had no
 * connectivity (9.7).
 *
 * Returns `{ order, created }` rather than the order alone - the only
 * service function here that does - because the caller needs to distinguish
 * a first sync (201) from an idempotent replay (200), and that fact isn't
 * recoverable from the order body itself.
 *
 * IDEMPOTENCY is the whole point. The till generates its own
 * `clientOrderId` at the moment of sale and re-sends the queued entry until
 * it gets an acknowledgement, so the same sale WILL arrive more than once
 * whenever a response is lost in flight. A partial unique index on
 * (shop_id, client_order_id) plus ON CONFLICT DO NOTHING makes the database
 * itself the arbiter - the identical mechanism Module 3 already uses for
 * Stripe's retried webhook deliveries, rather than a new invention.
 *
 * CONFLICT RESOLUTION (confirmed directly) distinguishes two cases the
 * unique index alone cannot tell apart:
 *   - Same key, same payload  -> a genuine replay. Returns the ORIGINAL
 *     order with created:false. Nothing is written; no second order, no
 *     second payment.
 *   - Same key, DIFFERENT payload -> a reused key, i.e. a real client bug.
 *     Rejected 409 rather than silently returning an order that doesn't
 *     match what was sent, which would leave a real sale silently unsynced.
 *
 * PAYMENT SCOPE: cash, and card ONLY for companies on their own terminal
 * ('own' card_payment_mode). A 'platform' card sale is rejected 400,
 * because it could not have happened offline in the first place - our
 * provider has to be reached live to authorise a card, so there is no
 * legitimate way for a queued 'platform' card sale to exist. Accepting one
 * would mean recording money as taken that nothing ever charged. 'own' mode
 * is genuinely offline-capable: the money was taken on the shop's own
 * terminal, out of band, exactly as it is in the online path, so no
 * provider is called and provider_reference stays null - identical to how
 * recordPayment already treats that mode.
 *
 * INVENTORY is deliberately NOT touched, exactly as in 9.5 - 10.3 owns the
 * deduction trigger, so a synced sale moves stock on the same KDS event any
 * other sale does, not here.
 *
 * KNOWN LIMITATION, deliberately accepted and the same shape as 9.5's and
 * 9.6's: the header insert, the item writes and the payment write are
 * separate statements, not one transaction (this project has no transaction
 * wrapper anywhere, and 9.7 does not introduce one). Two genuinely
 * simultaneous syncs of the same clientOrderId cannot produce two orders -
 * the unique index prevents that outright, which is the important
 * guarantee - but the loser of that race could read the winner's order back
 * in the brief instant before its items are written, and so return an
 * order whose items array is still filling in. A retry returns it complete.
 */
export async function syncOfflineOrder(actor, shopId, data) {
  await requireAccessTill(actor, shopId);

  // EVERYTHING is validated before a single row is written - same
  // discipline as createOrder, and it matters more here: a rejection after
  // the header landed would burn this clientOrderId forever, since the
  // unique index would then treat every honest retry as a duplicate of a
  // half-written order.
  const resolvedMenu = await shopMenuService.getResolvedMenu(actor, shopId);
  const resolvedLines = data.items.map((line) => resolveOfflineOrderLine(resolvedMenu, line));

  // 9.8 - fetched unconditionally (not just for card payments, unlike the
  // company lookup below): the VAT rate is snapshotted on every synced
  // order regardless of payment method. A read, not a write, so it's safe
  // here alongside the rest of this function's pre-write validation.
  //
  // KNOWN LIMITATION, same shape as 9.7's own: this reads the shop's
  // CURRENT vat_registered/default_vat_rate at SYNC time, not at the time
  // the sale actually happened (occurredAt) - there is no history of a
  // shop's past VAT settings to recover the rate that truly applied then.
  // Accepted for the same reason 9.7 accepts not knowing a soft-deleted
  // menu item's old state: no versioned settings table exists to do better.
  const shop = await shopRepository.findActiveShopById(shopId);

  if (data.payment.method === 'card') {
    const company = await companyRepository.findCompanyByShopId(shopId);
    if (usesPlatformCardProcessing(company)) {
      throw new AppError(
        'Card payments processed by the platform cannot be taken offline - only cash, or card on your own terminal',
        400
      );
    }
  }

  // The total, and the payment settled against it, are both computed BEFORE
  // the first write - deliberately, and this ordering is load-bearing. An
  // over-total card amount rejected AFTER the header had already been
  // inserted would leave an order with no payment behind AND permanently
  // burn this clientOrderId: the unique index would then match every honest
  // retry against that half-written row, so the till could never
  // successfully sync the sale.
  //
  // The invariant to preserve when editing this function: every throw must
  // sit ABOVE the createSyncedOrder call below. Nothing after the first
  // write may reject. A test proves this rather than trusting the comment -
  // it asserts that a rejected over-total card sync leaves zero orders
  // behind AND that retrying the same clientOrderId then succeeds; moving
  // this validation below the insert makes it fail.
  const total = computeResolvedLinesTotal(resolvedLines);

  // Cash may be over-tendered and only what is owed is credited, with the
  // difference derived back as change - the same rule the live till applies
  // in recordPayment. Card (necessarily 'own' mode by the check above) has
  // nothing to give change from, so an amount over the total is rejected.
  //
  // Written out here rather than shared with recordPayment deliberately:
  // that function is previously-approved and covered by 36 money tests, and
  // the overlap is three lines of arithmetic. Same judgement 8.4 made in
  // writing its own todayUtcDateString rather than refactoring 8.2's
  // calculateExpiresOn - a little duplication is the safer trade against
  // touching tested money-handling code for a small saving.
  let amountToCredit;
  let amountTendered = null;

  if (data.payment.method === 'cash') {
    amountTendered = roundMoney(data.payment.amountTendered);
    amountToCredit = Math.min(amountTendered, total);
  } else {
    amountToCredit = roundMoney(data.payment.amount);
    if (amountToCredit > total) {
      throw new AppError(
        `Payment amount cannot exceed the order total (${total.toFixed(2)})`,
        400
      );
    }
  }

  amountToCredit = roundMoney(amountToCredit);

  const syncPayloadHash = hashSyncPayload(shopId, data);

  const order = await orderRepository.createSyncedOrder(shopId, {
    type: data.type,
    tableNumber: data.tableNumber,
    customerName: data.customerName,
    createdByActorType: actor.type,
    createdByActorId: actor.id,
    clientOrderId: data.clientOrderId,
    occurredAt: data.occurredAt,
    syncPayloadHash,
    vatRate: resolveVatRate(shop),
  });

  // No row came back: this clientOrderId is already synced for this shop.
  if (!order) {
    const existing = await orderRepository.findOrderByClientOrderId(shopId, data.clientOrderId);
    // Defensive: the row must exist, since only the unique index could have
    // suppressed the insert. Treated as a 409 rather than crashing on a
    // null, because the one thing we must never do here is fall through and
    // write a second order.
    if (!existing) {
      throw new AppError('This order could not be synced - please retry', 409);
    }
    if (existing.sync_payload_hash !== syncPayloadHash) {
      throw new AppError(
        'This clientOrderId has already been used for a different order',
        409
      );
    }
    return { order: await fetchOrderDetail(shopId, existing.id), created: false };
  }

  await writeResolvedItems(order.id, resolvedLines);

  await orderRepository.createOrderPayment(order.id, {
    method: data.payment.method,
    amount: amountToCredit,
    amountTendered,
    // Always null: cash never has one, and a card payment that reaches here
    // was taken on the shop's OWN terminal, so our provider never saw it.
    // 9.6's refund path keys off exactly this being null to know not to
    // call the provider to reverse a charge it never made.
    providerReference: null,
    actorType: actor.type,
    actorId: actor.id,
  });

  const nextStatus = amountToCredit >= total ? 'paid' : 'partially_paid';
  await orderRepository.setOrderStatus(order.id, nextStatus);

  return { order: await fetchOrderDetail(shopId, order.id), created: true };
}
