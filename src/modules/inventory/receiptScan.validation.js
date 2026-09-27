import { z } from 'zod';

// A photo, shrunk client-side before it ever reaches here (Module 10.5's
// own frontend doc) — real-world size is a few hundred KB. This cap is a
// backstop against a client sending something unshrunk, not the normal
// case: base64 runs ~4/3 the size of the bytes it encodes, so 10,000,000
// characters is roughly a 7.5 MB photo.
//
// Kept comfortably BELOW app.js's `express.json({ limit: '10mb' })'
// (10,485,760 bytes) on purpose, with room for the rest of the JSON body
// (the mimeType field, quotes, braces) on top of imageBase64 itself. A
// larger cap here would just be dead code past that point - anything over
// ~10.48 MB never reaches this validation at all, and the client sees a
// generic 413 instead of the "Photo is too large" message below. If that
// body limit ever changes, this needs to move with it.
const MAX_BASE64_LENGTH = 10_000_000;

export const scanReceiptSchema = z.object({
  imageBase64: z
    .string()
    .min(1, 'imageBase64 is required')
    .max(MAX_BASE64_LENGTH, 'Photo is too large'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
