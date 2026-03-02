/**
 * Insurance Newsletter Generation — LIFEINSUR (Anchor Point Insurance Co.)
 *
 * Thin wrapper around the shared generateNewsletter() orchestrator in generate.ts.
 * All pipeline logic (NewsAPI fetch, Groq AI, HTML build, Strapi push) lives there;
 * BRAND_CONFIGS['LIFEINSUR'] already wires up the correct news query, sender email,
 * brand colors (charcoal #44403E / terracotta #AD7C59 / beige #FCF9F6), and
 * hasProperties=false so no Excel step runs.
 *
 * Ported from: ~/projects/newsletter-automation/generate-newsletter-lifeinsur.py
 */

import { generateNewsletter, type GenerateResult } from './generate.js'

// ── Types ─────────────────────────────────────────────────────────────

/** Options accepted by generateInsuranceNewsletter() */
export interface InsuranceNewsletterOptions {
  /** ISO date string (YYYY-MM-DD) for the edition date; defaults to today */
  date?: string
  /** When true, skips the Strapi push and returns the generated payload only */
  dryRun?: boolean
}

/**
 * Result returned by generateInsuranceNewsletter().
 * Aliased from GenerateResult for a consistent public API surface;
 * all fields are identical — import GenerateResult from generate.ts if you
 * need the underlying type directly.
 */
export type NewsletterResult = GenerateResult

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * Generate a LIFEINSUR newsletter for Anchor Point Insurance Co.
 *
 * Pipeline steps (delegated to generateNewsletter):
 *   1. Skip property extraction (LIFEINSUR has no listings)
 *   2. Fetch life insurance news via NewsAPI
 *      (query: "life insurance coverage policy florida texas alabama")
 *   3. Generate market overview + news summaries via Groq (Llama 3.3 70B)
 *   4. Build branded HTML email with LIFEINSUR color scheme
 *   5. Push draft to Strapi as brand=LIFEINSUR (unless dryRun=true)
 *
 * @example
 *   const result = await generateInsuranceNewsletter({ dryRun: false })
 *   console.log(result.strapiDocumentId)
 */
export async function generateInsuranceNewsletter(
  options: InsuranceNewsletterOptions = {},
): Promise<NewsletterResult> {
  return generateNewsletter({
    brand: 'LIFEINSUR',
    date: options.date,
    dryRun: options.dryRun,
    // No excelPath — LIFEINSUR has no property listings
  })
}
