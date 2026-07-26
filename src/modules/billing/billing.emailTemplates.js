/**
 * Sent once, when a payment failure first starts the grace period. Deliberately
 * a single email rather than a reminder series - a multi-day campaign would need
 * a scheduled job, which this project doesn't have yet.
 */
export function paymentFailedWarningEmail({ companyName, gracePeriodEndsAt, billingUrl }) {
  const deadline = new Date(gracePeriodEndsAt).toUTCString();

  return {
    subject: 'Action needed: your payment failed',
    html: `
      <p>We couldn't take payment for <strong>${companyName}</strong>.</p>
      <p>Your shops keep working as normal until <strong>${deadline}</strong>.
         After that, shop access is paused until the outstanding balance is settled -
         you'll still be able to sign in and manage your company details.</p>
      <p><a href="${billingUrl}">Update your payment details</a></p>
      <p>If you've already fixed this, you can ignore this email - payment may
         still be going through.</p>
    `,
  };
}