import { describe, it, expect } from 'vitest'
import { deriveStaleReason, type StaleReasonContext } from '../candidate-status'

function ctx(over: Partial<StaleReasonContext> = {}): StaleReasonContext {
  return {
    finishedAt: new Date('2026-05-01'),
    schedulingInviteSentAt: null,
    latestMeetingScheduledStart: null,
    hasAttendedAnyMeeting: false,
    hasTrainingInvite: false,
    hasTrainingProgress: false,
    hasTrainingCompleted: false,
    hasPendingBackgroundCheck: false,
    ...over,
  }
}

describe('deriveStaleReason', () => {
  it('returns flow_not_completed when the flow never finished', () => {
    expect(deriveStaleReason(ctx({ finishedAt: null }))).toBe('flow_not_completed')
  })

  it('returns training_not_started when training was invited but never started', () => {
    expect(
      deriveStaleReason(
        ctx({ hasTrainingInvite: true, hasTrainingProgress: false, hasTrainingCompleted: false }),
      ),
    ).toBe('training_not_started')
  })

  it('returns training_not_completed when training is in-progress but never completed', () => {
    expect(
      deriveStaleReason(
        ctx({ hasTrainingInvite: true, hasTrainingProgress: true, hasTrainingCompleted: false }),
      ),
    ).toBe('training_not_completed')
  })

  it('returns scheduling_not_booked when the scheduling invite was sent but no meeting was ever scheduled', () => {
    expect(
      deriveStaleReason(
        ctx({
          hasTrainingCompleted: true,
          hasTrainingInvite: true,
          schedulingInviteSentAt: new Date('2026-05-10'),
          latestMeetingScheduledStart: null,
        }),
      ),
    ).toBe('scheduling_not_booked')
  })

  it('returns interview_no_show when a meeting was scheduled but no attendance was recorded', () => {
    expect(
      deriveStaleReason(
        ctx({
          schedulingInviteSentAt: new Date('2026-05-10'),
          latestMeetingScheduledStart: new Date('2026-05-12'),
          hasAttendedAnyMeeting: false,
        }),
      ),
    ).toBe('interview_no_show')
  })

  it('returns background_check_not_completed when only a pending BG check is outstanding', () => {
    expect(
      deriveStaleReason(
        ctx({
          finishedAt: new Date('2026-05-01'),
          hasPendingBackgroundCheck: true,
        }),
      ),
    ).toBe('background_check_not_completed')
  })

  it('falls back to no_progress_generic when no specific checkpoint is stuck', () => {
    expect(deriveStaleReason(ctx())).toBe('no_progress_generic')
  })

  it('prefers the earliest stuck checkpoint over later ones', () => {
    // Both training_not_completed AND scheduling_not_booked are technically true,
    // but training is earlier in the funnel — that's the right reason.
    expect(
      deriveStaleReason(
        ctx({
          hasTrainingInvite: true,
          hasTrainingProgress: true,
          hasTrainingCompleted: false,
          schedulingInviteSentAt: new Date('2026-05-10'),
          latestMeetingScheduledStart: null,
        }),
      ),
    ).toBe('training_not_completed')
  })
})
