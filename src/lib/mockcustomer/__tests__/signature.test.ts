import { describe, expect, it } from 'vitest'
import { createHmac } from 'crypto'
import { parseMcSignatureHeader, verifyMcSignature } from '../signature'

const SECRET = 'whsec_' + 'x'.repeat(48)
const BODY =
  '{"eventId":"11111111-1111-1111-1111-111111111111","type":"external_call.queued","data":{}}'
const T = 1_800_000_000

function makeHeader(secret = SECRET, body = BODY, t = T): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('parseMcSignatureHeader', () => {
  it('parses a well-formed header', () => {
    const h = makeHeader()
    expect(parseMcSignatureHeader(h)).not.toBeNull()
  })
  it('rejects header missing t or v1', () => {
    const hex = 'a'.repeat(64)
    expect(parseMcSignatureHeader(`v1=${hex}`)).toBeNull()
    expect(parseMcSignatureHeader('t=1700000000')).toBeNull()
  })
  it('rejects malformed v1 (not 64-char hex)', () => {
    expect(parseMcSignatureHeader('t=1700000000,v1=short')).toBeNull()
    expect(parseMcSignatureHeader('t=1700000000,v1=' + 'z'.repeat(64))).toBeNull()
  })
  it('returns null on null/empty/undefined', () => {
    expect(parseMcSignatureHeader(null)).toBeNull()
    expect(parseMcSignatureHeader(undefined)).toBeNull()
    expect(parseMcSignatureHeader('')).toBeNull()
  })
  it('tolerates unknown v2/v3 alongside v1 (forward-compat)', () => {
    const hex = 'b'.repeat(64)
    expect(parseMcSignatureHeader(`t=1700000000,v2=whatever,v1=${hex}`)).toEqual({
      t: 1_700_000_000,
      v1: hex,
    })
  })
})

describe('verifyMcSignature', () => {
  it('accepts a valid signature (round-trip)', () => {
    const h = makeHeader()
    expect(verifyMcSignature(BODY, h, SECRET, { nowUnix: T })).toEqual({
      valid: true,
      timestamp: T,
    })
  })

  it('acceptance criterion: rejects invalid signature (bad hex)', () => {
    const badHex = 'c'.repeat(64)
    const h = `t=${T},v1=${badHex}`
    expect(verifyMcSignature(BODY, h, SECRET, { nowUnix: T })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('acceptance criterion: rejects stale timestamp (> 300s skew)', () => {
    const h = makeHeader()
    expect(verifyMcSignature(BODY, h, SECRET, { nowUnix: T + 301 })).toEqual({
      valid: false,
      reason: 'timestamp_skew',
    })
  })

  it('accepts timestamp within skew window (≤ 300s)', () => {
    const h = makeHeader()
    expect(verifyMcSignature(BODY, h, SECRET, { nowUnix: T + 299 })).toEqual({
      valid: true,
      timestamp: T,
    })
  })

  it('acceptance criterion: rejects wrong secret', () => {
    const h = makeHeader('whsec_wrong')
    expect(verifyMcSignature(BODY, h, SECRET, { nowUnix: T })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('rejects tampered body after signing', () => {
    const h = makeHeader()
    expect(verifyMcSignature(BODY + ' ', h, SECRET, { nowUnix: T })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('rejects missing header', () => {
    expect(verifyMcSignature(BODY, null, SECRET)).toEqual({
      valid: false,
      reason: 'missing_header',
    })
    expect(verifyMcSignature(BODY, undefined, SECRET)).toEqual({
      valid: false,
      reason: 'missing_header',
    })
  })

  it('rejects malformed header (parse failure)', () => {
    expect(verifyMcSignature(BODY, 'not-a-real-signature', SECRET)).toEqual({
      valid: false,
      reason: 'malformed_header',
    })
  })
})
