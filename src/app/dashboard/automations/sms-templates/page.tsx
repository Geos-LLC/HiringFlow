import { redirect } from 'next/navigation'

// Legacy URL — the SMS-only page and the automations/templates page were
// both consolidated into /dashboard/content. Anyone with a bookmark lands
// there. Remove after a release cycle on the redirect.
export default function SmsTemplatesRedirect() {
  redirect('/dashboard/content')
}
