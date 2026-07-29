/**
 * /dashboard/positions — Positions view.
 *
 * "Position" is the ATS term for what the app has historically called a
 * Campaign. Same underlying object (Ad grouped by targetPosition); different
 * label so recruiters see the vocabulary they already use ("Cleaner —
 * Jacksonville"). Vision doc §4: Position is a first-class object; this
 * route is the entry point.
 *
 * The existing Campaigns page implements the full grid + editor + filters.
 * We re-export it here so /dashboard/positions and /dashboard/campaigns
 * render the same UI — both URLs work during the rename transition.
 * Bookmarks to /dashboard/campaigns continue to work indefinitely.
 */

export { default } from '../campaigns/page'
