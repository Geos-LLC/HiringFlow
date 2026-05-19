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
  | 'internal'

interface MessageOpts {
  /** Workspace's business email — usually `Workspace.senderEmail`. */
  contactEmail?: string | null
}

function contactLine(contactEmail?: string | null, prefix = 'If this keeps happening, please email '): string {
  if (!contactEmail) return ''
  return ` ${prefix}${contactEmail}.`
}

export function bookingErrorMessage(code: BookingErrorCode | string, opts: MessageOpts = {}): string {
  const c = opts.contactEmail || null
  switch (code) {
    case 'config_not_found':
    case 'built_in_disabled':
    case 'not_built_in':
      return `This scheduling link is no longer available.${contactLine(c, 'Please email ')}`
    case 'invalid_token':
    case 'wrong_purpose':
    case 'config_mismatch':
      return `This scheduling link has expired or is invalid. Please request a new one${contactLine(c, 'by emailing ').trimEnd() || '.'}`
    case 'rate_limited':
      return 'Too many requests. Please wait a moment and try again.'
    case 'invalid_window':
      return `Something went wrong loading availability. Please refresh the page.${contactLine(c)}`
    case 'slot_unavailable':
      return 'That time was just taken. Please pick another time.'
    case 'free_busy_failed':
      return `We couldn't reach the scheduling calendar to confirm this time. Please try again in a few minutes.${contactLine(c)}`
    case 'name_required':
      return 'Please enter your name.'
    case 'invalid_email':
      return 'Please enter a valid email address.'
    case 'no_flow_available':
      return `This scheduling link is not yet ready.${contactLine(c, 'Please email ')}`
    case 'slotStartUtc_required':
    case 'invalid_slot':
      return 'Please pick a valid time slot and try again.'
    case 'no_meeting_to_cancel':
      return `No meeting was found to cancel.${contactLine(c)}`
    case 'no_meeting_to_reschedule':
      return `No meeting was found to reschedule.${contactLine(c)}`
    case 'no_calendar_event':
      return `We couldn't find the original calendar event to reschedule.${contactLine(c)}`
    case 'google_not_connected':
    case 'reconnect_required':
      return `Scheduling is temporarily unavailable on our end.${contactLine(c)}`
    case 'calendar_patch_failed':
      return `We couldn't update the calendar event. Please try again in a few minutes.${contactLine(c)}`
    case 'internal':
      return `Something went wrong on our end. Please try again.${contactLine(c)}`
    default:
      return `Something went wrong.${contactLine(c)}`
  }
}
