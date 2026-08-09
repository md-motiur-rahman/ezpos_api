import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopMenuService from '../menu/shopMenu.service.js';
import * as orderRepository from './order.repository.js';

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

function toDetailResponse(order, items) {
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
    // signal, this stays a record of what the order contained.
    subtotal: Number(subtotal.toFixed(2)),
    // New in 9.3 - all zero/null for an order with no discounts anywhere.
    itemDiscountTotal: Number(itemDiscountTotal.toFixed(2)),
    discount,
    discountAmount,
    total: Number(total.toFixed(2)),
    // New in 9.4 - null unless this order has been cancelled.
    cancellation: toCancellationResponse(order),
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

  const modifiersByOrderItemId = new Map();
  for (const row of modifierRows) {
    const list = modifiersByOrderItemId.get(row.order_item_id) ?? [];
    list.push(toModifierResponse(row));
    modifiersByOrderItemId.set(row.order_item_id, list);
  }

  const items = itemRows.map((row) => toItemResponse(row, modifiersByOrderItemId.get(row.id) ?? []));
  return toDetailResponse(order, items);
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
