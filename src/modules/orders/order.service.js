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

function toItemResponse(row, modifiers) {
  const unitPrice = Number(row.unit_price);
  const modifierTotal = modifiers.reduce((sum, m) => sum + m.priceDelta, 0);
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
    // Computed, not stored - "derive, don't store", same philosophy as
    // isLowStock/discrepancy/totalCost elsewhere in this project.
    lineTotal: Number(((unitPrice + modifierTotal) * row.quantity).toFixed(2)),
    createdAt: row.created_at,
  };
}

function toDetailResponse(order, items) {
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    id: order.id,
    shopId: order.shop_id,
    type: order.type,
    tableNumber: order.table_number,
    customerName: order.customer_name,
    status: order.status,
    createdByActorType: order.created_by_actor_type,
    createdByActorId: order.created_by_actor_id,
    items,
    // Pre-tax, pre-discount - deliberately. VAT (9.8) and discounts (9.3)
    // are separate, not-yet-built submodules; this is not a final total.
    subtotal: Number(subtotal.toFixed(2)),
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

  // Pre-generated, not left to the DB default - verified empirically that
  // explicit client-generated ids land correctly in a bulk unnest()
  // insert. Needed BEFORE order_item_modifiers can be inserted, since each
  // modifier row references its own line's id.
  const itemsToInsert = resolvedLines.map((line) => ({ id: crypto.randomUUID(), ...line }));
  await orderRepository.createOrderItems(order.id, itemsToInsert);

  const modifiersToInsert = itemsToInsert.flatMap((item) =>
    item.modifiers.map((modifier) => ({ orderItemId: item.id, ...modifier }))
  );
  await orderRepository.createOrderItemModifiers(modifiersToInsert);

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
