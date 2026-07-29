import { redirect } from 'next/navigation'

// Consolidated into /dashboard/content, which is the canonical Templates
// page reached via the top nav (Content → Templates). This page pre-dates
// that consolidation; redirect keeps existing bookmarks / deep-links
// working. Delete this file after we've been on the redirect for a
// release cycle without incident.
//
// If you're looking for the old page's source (email/SMS tabs, usage
// pill, inline template editor) it lived here until this change and can
// be recovered from git history.
export default function AutomationsTemplatesRedirect() {
  redirect('/dashboard/content')
}
