import { AppError } from '../utils/AppError.js';
import * as companyRepository from '../modules/company/company.repository.js';
import { isBillingLocked } from '../modules/billing/billing.access.js';

/**
 * The shop-scoped sibling of requireActiveBilling.js - same
 * isBillingLocked(company) check, same 402, but resolves the company from
 * req.params.shopId via companyRepository.findCompanyByShopId rather than
 * from req.user.id.
 *
 * Deliberately actor-agnostic: every router this runs on is mounted at
 * /api/shops/:shopId/... with mergeParams: true and sits under
 * requireStaffOrOwnerAuth, so req.params.shopId is always populated whether
 * the caller is an owner or a staff PIN session - confirmed directly rather
 * than assumed (order.service.js's own recordPayment already resolves the
 * company this exact way, via findCompanyByShopId, for its card-payment-mode
 * check - "a staff-authenticated payment knows its shopId but never the
 * owner's user id"). No req.actor.type branch is needed here for the same
 * reason: the shopId -> company path works identically for both actor
 * types, unlike resolveActorAuthority's owner-vs-staff split, which this
 * middleware has no need to duplicate.
 *
 * Applied to WRITE routes only (POST/PATCH/DELETE), never GET - same
 * "reading stays available while locked" philosophy requireActiveBilling.js
 * states for shop/add-on creation, now widened in scope to the shop-floor
 * write actions listed on each route file's own mount-point doc comment
 * (orders/till, inventory, purchase orders, wastage, health-safety scans,
 * shop-menu overrides, staff, rota, suppliers). A deliberate product
 * decision, not a default: attendance (clock-in/out) is excluded on
 * purpose (see attendance.routes.js's own doc), and order sync/item-status
 * are excluded too (see order.routes.js's own doc) - this middleware is
 * opted into per-route, never applied at the router level, so each
 * exclusion is a route that simply never got this call added to its chain,
 * not a special case carved out of a broader default.
 *
 * The message is deliberately the same "add a payment method" framing
 * requireActiveBilling.js already uses for shop creation - a company either
 * is or isn't billing-locked; there's one real cause and one real fix
 * regardless of which specific write triggered this 402.
 */
export async function requireActiveBillingForShop(req, res, next) {
  try {
    const company = await companyRepository.findCompanyByShopId(req.params.shopId);

    // No company (a malformed/foreign shopId) is left to the route's own
    // 404 - this middleware's only job is the billing check, not tenancy.
    if (company && isBillingLocked(company)) {
      return next(
        new AppError(
          "This shop's billing needs attention - a payment method must be added to continue. " +
            'You can still view existing data.',
          402
        )
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}
