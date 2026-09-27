import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';
import config from '../../config/index.js';
import { requireManageInventory } from './inventory.service.js';
import * as receiptScanRepository from './receiptScan.repository.js';
import { readReceiptWithGemini } from './geminiReceiptClient.js';

// Re-validated here even though the request to Gemini asked for exactly
// this shape (`geminiReceiptClient.js`'s `RESPONSE_SCHEMA`) — a schema is a
// strong hint to the model, never a guarantee, and this is the boundary
// where untrusted model output either becomes this app's own typed data or
// gets rejected, the same "never trust it just because it looked right"
// rule this app applies to any other external input.
const parsedReceiptSchema = z.object({
  supplierNameGuess: z.string().trim().min(1).nullable().optional(),
  lines: z.array(
    z.object({
      rawText: z.string(),
      quantity: z.number().finite().nullable().optional(),
      unit: z.enum(['pcs', 'g', 'kg', 'ml', 'L']).nullable().optional(),
      unitCost: z.number().finite().nullable().optional(),
    })
  ),
});

function toParsedReceipt(raw) {
  return {
    supplierNameGuess: raw.supplierNameGuess ?? null,
    lines: raw.lines
      .map((line) => ({
        rawText: line.rawText.trim(),
        quantity: line.quantity ?? null,
        unit: line.unit ?? null,
        unitCost: line.unitCost ?? null,
      }))
      // A blank name is never useful on the review screen and isn't
      // something the owner could even match against anything.
      .filter((line) => line.rawText.length > 0),
  };
}

/**
 * Reads a receipt photo with the cloud AI reader (Module 10.5) and returns
 * it in exactly the shape the on-device reader always has
 * (`ParsedReceipt`/`ParsedReceiptLine` on the frontend) — everything past
 * this point (matching against inventory items, remembered wording, the
 * review screen) already existed and needed no change to use it.
 *
 * Gated behind MANAGE_INVENTORY, same as creating the purchase order this
 * scan feeds into — there is no point being able to read a receipt without
 * also being allowed to log what it says arrived. Also gated behind this
 * shop's own daily/monthly scan limit (`config.env.receiptScan*Limit`): this
 * calls a paid, external service, so an unbounded shop (or a bug looping
 * this call) could otherwise run up a real bill with nothing else in this
 * app noticing.
 *
 * The limit check and the slot it reserves happen together, inside one
 * locked transaction (`reserveScanSlot`), so two scans fired at once can't
 * both read "under the limit" and both go ahead — see the long comment on
 * that function for why. And the count that check runs against isn't
 * "successful scans" but "billable attempts": a timeout or a blocked answer
 * can cost money without this app ever getting a usable result back, so
 * those count too, or the limit would just be a limit on the scans that
 * happen to work.
 */
export async function scanReceipt(actor, shopId, { imageBase64, mimeType }) {
  await requireManageInventory(actor, shopId);

  const reservation = await receiptScanRepository.reserveScanSlot(shopId, actor, {
    dailyLimit: config.env.receiptScanDailyLimit,
    monthlyLimit: config.env.receiptScanMonthlyLimit,
    model: config.env.geminiModel,
  });
  if (!reservation.ok) {
    throw new AppError(
      reservation.reason === 'daily'
        ? "Today's receipt-scanning limit has been reached for this shop. Try again tomorrow, or enter this one manually."
        : "This month's receipt-scanning limit has been reached for this shop. Enter this one manually.",
      429
    );
  }
  const { scanId } = reservation;

  let result;
  try {
    result = await readReceiptWithGemini(imageBase64, mimeType);
  } catch (error) {
    if (error instanceof AppError) {
      // `billable`/`usage` come from geminiReceiptClient.js's own read of
      // what actually happened on the wire (timed out after sending vs.
      // never reaching Google at all) — absent only for an error this
      // service raised itself, which isn't one of those.
      await receiptScanRepository.finalizeScan(scanId, {
        status: 'error',
        billable: error.billable ?? false,
        model: config.env.geminiModel,
        errorMessage: error.message,
        promptTokens: error.usage?.promptTokens,
        outputTokens: error.usage?.outputTokens,
        estimatedCostHundredthPence: error.usage?.estimatedCostHundredthPence,
      });
    }
    throw error;
  }

  const validated = parsedReceiptSchema.safeParse(result.parsed);
  if (!validated.success) {
    // Google answered and was billed for it; this app just didn't like the
    // shape of the answer, so it's billable the same as a normal success.
    await receiptScanRepository.finalizeScan(scanId, {
      status: 'error',
      billable: true,
      model: result.model,
      errorMessage: 'Response did not match the expected shape',
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      estimatedCostHundredthPence: result.estimatedCostHundredthPence,
    });
    throw new AppError('Receipt reading service returned an unexpected answer', 502);
  }

  await receiptScanRepository.finalizeScan(scanId, {
    status: 'ok',
    billable: true,
    model: result.model,
    promptTokens: result.promptTokens,
    outputTokens: result.outputTokens,
    estimatedCostHundredthPence: result.estimatedCostHundredthPence,
  });

  return toParsedReceipt(validated.data);
}
