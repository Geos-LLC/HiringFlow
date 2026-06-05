import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMeetingTranscript } from '../meeting-transcript'

// Mock the workspace-scoped Google client. The test never hits Google live —
// we just verify that when the Drive helper returns text, fetchMeetingTranscript
// reports it correctly.
vi.mock('@/lib/google', () => ({
  getAuthedClientForWorkspace: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {},
}))

const REAL_FETCH = global.fetch

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  global.fetch = REAL_FETCH
})

describe('fetchMeetingTranscript', () => {
  it('returns null when neither source id is set', async () => {
    const result = await fetchMeetingTranscript({
      id: 'm1',
      workspaceId: 'w1',
      recallRecordingId: null,
      driveTranscriptFileId: null,
    })
    expect(result).toBeNull()
  })

  it('returns null when Recall has no API key and Drive id is missing', async () => {
    delete process.env.RECALL_API_KEY
    const result = await fetchMeetingTranscript({
      id: 'm1',
      workspaceId: 'w1',
      recallRecordingId: 'rec_123',
      driveTranscriptFileId: null,
    })
    expect(result).toBeNull()
  })

  it('falls back to Drive when Recall returns no download URL', async () => {
    process.env.RECALL_API_KEY = 'test-key'
    const { getAuthedClientForWorkspace } = (await import('@/lib/google')) as any

    // Recall: returns a recording shell with no transcript link
    // Drive: returns text via the export endpoint
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/recording/')) {
        return {
          ok: true,
          json: async () => ({ id: 'rec_123', media_shortcuts: {} }),
        } as any
      }
      if (url.includes('drive.googleapis.com/drive/v3') || url.includes('googleapis.com/drive/v3')) {
        return {
          ok: true,
          text: async () => 'Speaker 1: hello world\nSpeaker 2: hi back',
        } as any
      }
      return { ok: false } as any
    }) as unknown as typeof fetch

    getAuthedClientForWorkspace.mockResolvedValue({
      client: { getAccessToken: async () => ({ token: 'tok' }) },
      integration: {},
    })

    const result = await fetchMeetingTranscript({
      id: 'm1',
      workspaceId: 'w1',
      recallRecordingId: 'rec_123',
      driveTranscriptFileId: 'doc_456',
    })
    expect(result).not.toBeNull()
    expect(result!.source).toBe('drive')
    expect(result!.text).toMatch(/hello world/)
  })

  it('parses a Recall JSON transcript into "Speaker: text" lines', async () => {
    process.env.RECALL_API_KEY = 'test-key'

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/recording/')) {
        return {
          ok: true,
          json: async () => ({
            id: 'rec_123',
            media_shortcuts: {
              transcript: { data: { download_url: 'https://recall.example/transcripts/123.json' } },
            },
          }),
        } as any
      }
      if (url.includes('recall.example')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify([
              { speaker: 'Interviewer', words: [{ text: 'Tell' }, { text: 'me' }, { text: 'about' }, { text: 'you.' }] },
              { speaker: 'Candidate', words: [{ text: 'I' }, { text: 'have' }, { text: 'five' }, { text: 'years' }] },
            ]),
        } as any
      }
      return { ok: false } as any
    }) as unknown as typeof fetch

    const result = await fetchMeetingTranscript({
      id: 'm1',
      workspaceId: 'w1',
      recallRecordingId: 'rec_123',
      driveTranscriptFileId: null,
    })
    expect(result).not.toBeNull()
    expect(result!.source).toBe('recall')
    expect(result!.text).toContain('Interviewer:')
    expect(result!.text).toContain('Candidate:')
    expect(result!.text).toContain('Tell me about')
  })
})
