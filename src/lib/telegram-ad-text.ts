/**
 * Render an Ad row into the plain-text body we post to Telegram.
 *
 * Server-side mirror of the campaigns page `copyAdText` composer (src/app/
 * dashboard/campaigns/page.tsx) so what the recruiter sees in the copy-text
 * preview matches what actually gets sent. Kept narrow on purpose — template
 * fallback and source defaults live in the client copy because they read
 * from React state; the server-side render uses only what's persisted on
 * the Ad row.
 *
 * The recruiter can override the body per-publish via the API's optional
 * `text` field, so this function only sets the default.
 */

interface AdInput {
  headline?: string | null
  bodyText?: string | null
  requirements?: string | null
  benefits?: string | null
  callToAction?: string | null
  placementUrl?: string | null
  slug?: string | null
}

export function renderAdForTelegram(ad: AdInput, appBaseUrl?: string): string {
  const parts: string[] = []
  if (ad.headline?.trim()) parts.push(ad.headline.trim())
  if (ad.bodyText?.trim()) parts.push(ad.bodyText.trim())
  if (ad.requirements?.trim()) parts.push(`Requirements:\n${ad.requirements.trim()}`)
  if (ad.benefits?.trim()) parts.push(`What we offer:\n${ad.benefits.trim()}`)
  if (ad.callToAction?.trim()) parts.push(ad.callToAction.trim())
  // The application link is the recruiter's funnel entrypoint — same shape
  // as the copy-ad-text button uses. `appBaseUrl` is passed by the caller
  // (request origin) rather than resolved from process.env so the server
  // and client produce identical strings in local dev.
  const base = (appBaseUrl || '').replace(/\/+$/, '')
  if (ad.slug && base) {
    parts.push(`Apply: ${base}/a/${ad.slug}`)
  } else if (ad.placementUrl?.trim()) {
    parts.push(`Apply: ${ad.placementUrl.trim()}`)
  }
  return parts.join('\n\n')
}
