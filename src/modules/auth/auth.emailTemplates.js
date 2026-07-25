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