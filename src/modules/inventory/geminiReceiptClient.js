import { AppError } from '../../utils/AppError.js';
import config from '../../config/index.js';

/**
 * The cloud half of receipt scanning (Module 10.5) — sends a photo straight
 * to Google's Gemini API and asks for the same shape the old on-device
 * reader produced (`lib/ocr/parse-receipt-text.ts`'s `ParsedReceipt` on the
 * frontend), so nothing downstream of this — matching against inventory
 * items, remembered wording, the review screen — needed to change to use
 * it. `responseSchema` below is Gemini's own structured-output feature: it
 * constrains the model to return exactly this JSON shape rather than prose
 * that has to be parsed and hoped for, which is both more reliable and
 * removes an entire class of "the model chatted instead of answering"
 * failures this app would otherwise have to guard against.
 *
 * **Never assumed to be configured** — `config.env.geminiApiKey` is
 * deliberately absent from `config/env.js`'s required list (Module 10.5's
 * own doc there): a shop this hasn't been switched on for, or an
 * environment with no key at all, gets a clean `AppError` the frontend
 * already treats as "fall back to the on-device reader" rather than the app
 * failing to boot.
 *
 * **Pricing is an estimate, not an invoice** — `PRICING` below is this
 * app's own best reading of Google's published per-token rates at the time
 * it was written, kept purely so `receipt_scans` (10.5's own usage log) has
 * a rough running cost rather than nothing at all. It will drift the
 * moment Google changes a price; nothing here re-fetches it, and nothing
 * downstream should ever treat `estimatedCostHundredthPence` as exact.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** A cloud call has no business hanging as long as the on-device reader's
 * own worst case — if Google hasn't answered by then, something is wrong
 * on their end, and the frontend's fallback is a better use of the time. */
const REQUEST_TIMEOUT_MS = 25_000;

// USD per 1,000,000 tokens, and an approximate USD→GBP rate — all four
// numbers are the only things to touch when a price actually changes.
const USD_TO_GBP = 0.78;
const PRICING = {
  'gemini-flash-lite-latest': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'gemini-2.5-flash-lite': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'gemini-2.5-flash': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
};

const PROMPT = `You are reading a photo of a paper purchase receipt or delivery note for a small takeaway/restaurant, to log what stock arrived.

Return the supplier's business name if the receipt shows one (or null if you can't tell), and one line per item bought — skip totals, tax, tender/change, addresses, phone numbers and anything else that isn't an item.

For each item line:
- "rawText": the item's name exactly as printed (fix obvious OCR-style misreads, but do not translate or invent detail).
- "quantity": the number bought, as a plain number. Null if you can't tell.
- "unit": the unit the quantity is measured in, normalised to exactly one of "pcs", "g", "kg", "ml", "L" (litres). Use "pcs" for a bare count (e.g. "12 wings" -> quantity 12, unit "pcs"). Null if no unit or count is given at all.
- "unitCost": the total price printed for that line (quantity × price, i.e. the line total, not a per-unit price), as a plain number with no currency symbol. Null if no price is on that line.

Respond with JSON only, matching the schema.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    supplierNameGuess: { type: 'STRING', nullable: true },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          rawText: { type: 'STRING' },
          quantity: { type: 'NUMBER', nullable: true },
          unit: { type: 'STRING', enum: ['pcs', 'g', 'kg', 'ml', 'L'], nullable: true },
          unitCost: { type: 'NUMBER', nullable: true },
        },
        required: ['rawText'],
      },
    },
  },
  required: ['lines'],
};

function estimateCostHundredthPence(model, usage) {
  const pricing = PRICING[model];
  if (!pricing || !usage) return null;
  const inputUsd = ((usage.promptTokenCount ?? 0) / 1_000_000) * pricing.inputPerMillionUsd;
  const outputUsd = ((usage.candidatesTokenCount ?? 0) / 1_000_000) * pricing.outputPerMillionUsd;
  // Pence has 100 to the pound and this stores hundredths of a penny, so
  // GBP * 100 * 100 = GBP * 10,000.
  return Math.round((inputUsd + outputUsd) * USD_TO_GBP * 10_000);
}

/**
 * Same shape an AppError normally has, plus two extra properties
 * `receiptScan.service.js` reads to decide how to log the attempt:
 * `billable` (did this call stand a chance of costing money) and
 * `usage` (the token counts to log, when we actually have them). A call
 * that never reached Google, or was rejected before it generated anything,
 * is not billable; one that reached Google and either produced an answer,
 * got blocked, or simply took too long to answer is treated as billable
 * even when the failure means this app never sees a usable result.
 */
function billedError(message, status, { billable, usageMetadata, model }) {
  const error = new AppError(message, status);
  error.billable = billable;
  error.usage = usageMetadata
    ? {
        promptTokens: usageMetadata.promptTokenCount ?? null,
        outputTokens: usageMetadata.candidatesTokenCount ?? null,
        estimatedCostHundredthPence: estimateCostHundredthPence(model, usageMetadata),
      }
    : null;
  return error;
}

/** One line as Gemini returned it — loosely typed on purpose, since this is
 * untrusted model output re-validated by `receiptScan.service.js` before it
 * reaches anything else, the same "never trust it just because the schema
 * asked nicely" discipline this app applies to any external input. */
export async function readReceiptWithGemini(imageBase64, mimeType) {
  if (!config.env.geminiApiKey) {
    throw billedError('Receipt scanning is not configured for this server', 503, { billable: false });
  }
  const model = config.env.geminiModel;

  // The same controller/timer guards fetch() AND the response.json() body
  // read below, deliberately — clearing it as soon as fetch() resolves
  // would only be timing out receipt of the HEADERS. Google can send
  // headers immediately and then stall streaming the body, and a request
  // stuck at that point would otherwise hang with nothing bounding it, the
  // same class of "hangs instead of erroring" trap this app already learnt
  // to guard against elsewhere (`src/db/pool.js`'s connectionTimeoutMillis).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let body;
  try {
    response = await fetch(`${API_BASE}/${model}:generateContent?key=${config.env.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: PROMPT }, { inlineData: { mimeType, data: imageBase64 } }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      }),
    });
    body = await response.json().catch((error) => {
      // A malformed/truncated body that ISN'T our own abort is handled the
      // same way it always was — fall through as null and let the
      // response.ok / candidate checks below produce the right message —
      // re-thrown only so the one AbortError branch below can still catch
      // it when it's our timeout firing mid-body-read.
      if (error.name === 'AbortError') throw error;
      return null;
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      // Fires whether the timeout hit before fetch() ever got a response
      // or while the body was still streaming in - Google may well have
      // kept processing either way, so both map to the same billable
      // timeout rather than only the first.
      throw billedError('Receipt reading timed out', 504, { billable: true });
    }
    // A connection that never opened (DNS, refused, offline) never reached
    // Google at all, so nothing was generated for them to charge for.
    throw billedError('Could not reach the receipt reading service', 502, { billable: false });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const message = body?.error?.message || `Receipt reading service returned ${response.status}`;
    // 4xx from Google (bad key, bad request) is this app's own bug to fix,
    // not the shop's — still surfaced as a clean 502 rather than leaking
    // Google's own status code and message shape to the frontend. This is
    // a request Google rejected before generating anything, so it's not
    // billed.
    throw billedError(message, 502, { billable: false });
  }

  const candidate = body?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    // SAFETY / RECITATION / MAX_TOKENS etc — the model refused or was cut
    // off rather than genuinely answering, but it still ran and Google's
    // own usageMetadata on this response reflects that.
    throw billedError(`Receipt reading was blocked (${finishReason})`, 502, {
      billable: true,
      usageMetadata: body?.usageMetadata,
      model,
    });
  }

  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A real answer came back with real usage attached to it, it just
    // wasn't valid JSON — still billable, same as the blocked case above.
    throw billedError('Receipt reading service returned an unreadable answer', 502, {
      billable: true,
      usageMetadata: body?.usageMetadata,
      model,
    });
  }

  return {
    parsed,
    model,
    promptTokens: body?.usageMetadata?.promptTokenCount ?? null,
    outputTokens: body?.usageMetadata?.candidatesTokenCount ?? null,
    estimatedCostHundredthPence: estimateCostHundredthPence(model, body?.usageMetadata),
  };
}
