const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY

export async function transcribeFromUrl(url: string): Promise<{
  transcript: string
  segments: Array<{ start: number; end: number; text: string }>
}> {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY not configured')
  }

  const res = await fetch(// `detect_language=true` makes nova-2 transcribe whatever language the
// audio is actually in (verified: Russian self-intro for Tetiana returns
// 1k+ chars of cyrillic; without detect, the default English model
// returned empty). HF candidates are commonly EN/RU/UK/ES so auto-detect
// is the safer default than hardcoding `language=en`.
'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&punctuate=true&detect_language=true', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Deepgram error ${res.status}: ${err}`)
  }

  const data = await res.json()
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''

  // Extract utterances as segments (better than word-level for captions)
  const utterances = data.results?.utterances || []
  const segments = utterances.map((u: any) => ({
    start: u.start,
    end: u.end,
    text: u.transcript.trim(),
  }))

  // Fallback: if no utterances, use paragraphs
  if (segments.length === 0) {
    const paragraphs = data.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || []
    for (const para of paragraphs) {
      for (const sentence of para.sentences || []) {
        segments.push({
          start: sentence.start,
          end: sentence.end,
          text: sentence.text.trim(),
        })
      }
    }
  }

  return { transcript, segments }
}

/**
 * Same as transcribeFromUrl but uploads the raw audio bytes directly to
 * Deepgram. Used when we have the file in memory (e.g. after ffmpeg
 * transcoding) and don't want to make a second presigned-URL roundtrip.
 */
export async function transcribeFromBuffer(
  data: Buffer,
  contentType: string,
): Promise<{
  transcript: string
  segments: Array<{ start: number; end: number; text: string }>
}> {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY not configured')
  }

  const res = await fetch(// `detect_language=true` makes nova-2 transcribe whatever language the
// audio is actually in (verified: Russian self-intro for Tetiana returns
// 1k+ chars of cyrillic; without detect, the default English model
// returned empty). HF candidates are commonly EN/RU/UK/ES so auto-detect
// is the safer default than hardcoding `language=en`.
'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&punctuate=true&detect_language=true', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': contentType,
    },
    // Cast through Uint8Array — node Buffer typing doesn't always line up
    // with the DOM lib's BodyInit union, even though runtime accepts it.
    body: new Uint8Array(data),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Deepgram error ${res.status}: ${err}`)
  }

  const data2 = await res.json()
  const transcript = data2.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  const utterances = data2.results?.utterances || []
  const segments = utterances.map((u: any) => ({
    start: u.start,
    end: u.end,
    text: u.transcript.trim(),
  }))
  if (segments.length === 0) {
    const paragraphs = data2.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || []
    for (const para of paragraphs) {
      for (const sentence of para.sentences || []) {
        segments.push({
          start: sentence.start,
          end: sentence.end,
          text: sentence.text.trim(),
        })
      }
    }
  }
  return { transcript, segments }
}
