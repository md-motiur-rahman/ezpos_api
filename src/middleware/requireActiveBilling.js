import { AppError } from '../utils/AppError.js';
import * as companyRepository from '../modules/company/company.repository.js';
import { isBillingLocked } from '../modules/billing/billing.access.js';

/**
 * Blocks actions that shouldn't be available while a company's billing is in a
 * failed state past its grace period. Runs after requireAuth.
 *
 * Deliberately narrow in scope: reading, editing and CLOSING shops/add-ons stay
 * available while locked, because an owner in this state still needs to see what
 * they're paying for and needs to be able to reduce their bill. Only actions
 * that add new billable things are blocked.
 *
 * 402 Payment Required is the semantically correct status, and the message is
 * written to be shown to the owner directly - it has to tell them what to do,
 * not just that they were refused.
 *
 * NOTE (Modules 4 and 9): this resolves the company from req.user.id, i.e. the
 * OWNER's account. Once till/staff PIN auth exists, staff-authenticated requests
 * will need the company resolved via staff -> shop -> company instead, so this
 * will need a second path rather than being reused as-is.
 */
export async function requireActiveBilling(req, res, next) {
  try {
    const company = await companyRepository.findActiveCompanyByOwner(req.user.id);

    // No company yet means nothing is billable yet. Handlers that genuinely
    // require a company already 404 on their own.
    if (company && isBillingLocked(company)) {
      return next(
        new AppError(
          'Shop access is paused because a subscription payment failed. ' +
            'Settle the outstanding balance to restore access - you can still ' +
            'sign in and manage your company details.',
          402
        )
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}