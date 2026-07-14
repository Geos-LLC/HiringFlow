/**
 * Candidate-facing error messages for the booking endpoints.
 *
 * Every public booking endpoint returns `{error: <machine_key>, message:
 * <human readable>}` so the picker can display something useful without
 * leaking implementation strings. `BookingClient.tsx` prefers `message` over
 * `error` when surfacing failures.
 *
 * Each message ends with an optional "If this keeps happening, contact
 * <email>" suffix when the workspace has a sender email configured. The
 * suffix gives candidates a recovery path when something is wrong with the
 * recruiter's integration (e.g. Google OAuth disconnected) that they
 * cannot self-serve.
 */

export type BookingErrorCode =
  | 'config_not_found'
  | 'built_in_disabled'
  | 'not_built_in'
  | 'invalid_token'
  | 'wrong_purpose'
  | 'config_mismatch'
  | 'rate_limited'
  | 'invalid_window'
  | 'slot_unavailable'
  | 'free_busy_failed'
  | 'name_required'
  | 'invalid_email'
  | 'no_flow_available'
  | 'slotStartUtc_required'
  | 'invalid_slot'
  | 'no_meeting_to_cancel'
  | 'no_meeting_to_reschedule'
  | 'no_calendar_event'
  | 'google_not_connected'
  | 'reconnect_required'
  | 'calendar_patch_failed'
  // ── bookInterview error codes (previously fell through to the generic
  //    "Something went wrong" default and gave candidates no useful hint) ──
  | 'meet_disabled'
  | 'session_not_found'
  | 'invalid_time'
  | 'meet_space_failed'
  | 'calendar_event_failed'
  | 'internal'

interface MessageOpts {
  /** Workspace's business email — usually `Workspace.senderEmail`. */
  contactEmail?: string | null
}

/**
 * Append a contact line to a message. Two phrasings:
 *  - `'persistent'` (default): "If this keeps happening, please email X." —
 *    use for transient failures the candidate may want to retry.
 *  - `'direct'`: "Please email X for help." — use for terminal failures the
 *    candidate cannot self-recover from (expired link, missing meeting,
 *    integration broken).
 */
function contactLine(contactEmail: string | null | undefined, kind: 'persistent' | 'direct' = 'persistent'): string {
  if (!contactEmail) return ''
  if (kind === 'direct') return ` Please email ${contactEmail} for help.`
  return ` If this keeps happening, please email ${contactEmail}.`
}

export function bookingErrorMessage(code: BookingErrorCode | string, opts: MessageOpts = {}): string {
  const c = opts.contactEmail || null
  switch (code) {
    // ── Terminal: nothing to retry, candidate must reach out ──
    case 'config_not_found':
    case 'built_in_disabled':
    case 'not_built_in':
    case 'no_flow_available':
      return `This scheduling link is no longer available.${contactLine(c, 'direct')}`
    case 'invalid_token':
    case 'wrong_purpose':
    case 'config_mismatch':
      return c
        ? `This scheduling link has expired. Please email ${c} to request a new one.`
        : 'This scheduling link has expired. Please request a new one.'
    case 'no_meeting_to_cancel':
      return `We couldn't find a meeting to cancel.${contactLine(c, 'direct')}`
    case 'no_meeting_to_reschedule':
      return `We couldn't find a meeting to reschedule.${contactLine(c, 'direct')}`
    case 'no_calendar_event':
      return `We couldn't find the booking details for this meeting.${contactLine(c, 'direct')}`
    case 'google_not_connected':
    case 'reconnect_required':
      return c
        ? `Scheduling is temporarily unavailable. Please email ${c} to book directly.`
        : 'Scheduling is temporarily unavailable. Please contact your hiring team.'

    // ── Transient: candidate can retry; offer fallback contact ──
    case 'rate_limited':
      return 'Too many requests. Please wait a moment and try again.'
    case 'invalid_window':
      return `Something went wrong loading available times. Please refresh the page.${contactLine(c, 'persistent')}`
    case 'free_busy_failed':
      return `We're having trouble confirming this time right now. Please try again in a few minutes.${contactLine(c, 'persistent')}`
    case 'calendar_patch_failed':
      return `We couldn't save your change. Please try again in a few minutes.${contactLine(c, 'persistent')}`
    case 'internal':
      return `Something went wrong on our end. Please try again.${contactLine(c, 'persistent')}`

    // ── bookInterview server errors — terminal for the candidate, they
    //    need to reach out because the recruiter's Meet/Calendar
    //    integration is misconfigured or Google's API is down. ──
    case 'meet_disabled':
      return c
        ? `Meeting scheduling isn't set up for this workspace. Please email ${c} to book directly.`
        : 'Meeting scheduling isn\'t set up for this workspace. Please contact your hiring team.'
    case 'session_not_found':
      return `We couldn't find your session. Please refresh the page and try again.${contactLine(c, 'persistent')}`
    case 'invalid_time':
      return 'Please pick a valid time and try again.'
    case 'meet_space_failed':
      return `We couldn't create the Google Meet room right now. Please try again in a few minutes.${contactLine(c, 'persistent')}`
    case 'calendar_event_failed':
      return `We couldn't add this to the calendar right now. Please try again in a few minutes.${contactLine(c, 'persistent')}`

    // ── Self-fixable: don't pollute with contact info ──
    case 'slot_unavailable':
      return 'That time was just taken by someone else. Please pick another time.'
    case 'name_required':
      return 'Please enter your name.'
    case 'invalid_email':
      return 'Please enter a valid email address.'
    case 'slotStartUtc_required':
    case 'invalid_slot':
      return 'Please pick a valid time and try again.'

    // ── Catch-all ──
    default:
      return `Something went wrong.${contactLine(c, 'persistent')}`
  }
}
