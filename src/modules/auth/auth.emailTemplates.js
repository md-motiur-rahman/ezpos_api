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