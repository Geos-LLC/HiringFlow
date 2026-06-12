// In-memory, per-tab cache of just-recorded video blobs keyed by the
// server videoId returned from upload. Lets the step preview play back
// the recording the user just took without waiting for the Lambda HLS
// transcode pipeline (10-30s on a fresh upload). Once HLS is ready,
// CaptionedVideo flips over to it automatically.
//
// Survives in-app navigation (SPA) but not a hard refresh — that's fine:
// after refresh the transcode is almost always done, so HLS is available.

const cache = new Map<string, Blob>()

export const videoBlobCache = {
  set(id: string, blob: Blob) {
    cache.set(id, blob)
  },
  get(id: string): Blob | undefined {
    return cache.get(id)
  },
  delete(id: string) {
    cache.delete(id)
  },
}
