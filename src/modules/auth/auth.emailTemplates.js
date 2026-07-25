export function verificationEmail(verifyUrl) {
  return {
    subject: 'Verify your email address',
    html: `
      <p>Welcome! Please confirm your email address to activate your account.</p>
      <p><a href="${verifyUrl}">Verify my email</a></p>
      <p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>
    `,
  };
}

export function passwordResetEmail(resetUrl) {
  return {
    subject: 'Reset your password',
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}">Reset my password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can ignore this email - your password won't change.</p>
    `,
  };
}

export function emailChangeConfirmation(confirmUrl) {
  return {
    subject: 'Confirm your new email address',
    html: `
      <p>Please confirm this is your new email address.</p>
      <p><a href="${confirmUrl}">Confirm new email</a></p>
      <p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
    `,
  };
}

export function emailChangeRequestedNotice(newEmail) {
  return {
    subject: 'Email change requested on your account',
    html: `
      <p>A request was made to change your account email to <strong>${newEmail}</strong>.</p>
      <p>If this was you, no action is needed - the change takes effect once the new address is confirmed.</p>
      <p>If this wasn't you, please change your password immediately and contact support.</p>
    `,
  };
}