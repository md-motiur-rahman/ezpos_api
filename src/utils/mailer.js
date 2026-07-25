import { Resend } from 'resend';
import config from '../config/index.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

const resend = config.env.isTest ? null : new Resend(config.env.resendApiKey);

/**
 * Send a transactional email. Every module that needs to email someone
 * (auth now, staff invites later, etc.) goes through this one function.
 *
 * In the test environment, this deliberately does NOT call the real Resend
 * API - automated tests shouldn't depend on (or be slowed down by) a real
 * external network call. The send is logged instead so tests can still
 * assert that a send was attempted, without touching the network.
 */
export async function sendEmail({ to, subject, html }) {
  if (config.env.isTest) {
    logger.debug({ to, subject }, 'Test env: email send skipped (not actually sent)');
    return { id: 'test-email-skipped' };
  }

  const { data, error } = await resend.emails.send({
    from: config.env.emailFrom,
    to,
    subject,
    html,
  });

  if (error) {
    logger.error({ error, to, subject }, 'Failed to send email via Resend');
    throw new AppError('Failed to send email', 502);
  }

  return data;
}