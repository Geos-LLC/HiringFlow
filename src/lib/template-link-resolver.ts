import { prisma } from './prisma'
import { resolveSchedulingUrl, buildScheduleRedirectUrl } from './scheduling'
import { createAccessToken, buildTrainingLink } from './training-access'

// Sub-token form: {{schedule_link:<configId>}} and
// {{training_link:<trainingId>}}. Inserted into templates by the editor's
// "Insert button" tool so authors can wire a clickable button to any
// scheduling config or training in the workspace — not just the one
// configured on the parent automation step.
const SUB_TOKEN_RE = /\{\{\s*(schedule_link|training_link):([A-Za-z0-9_-]+)\s*\}\}/g

export interface ResolveLinksOpts {
  // Anything that may contain a sub-token (subject + bodyHtml + bodyText
  // + smsBody). The resolver does its own regex scan; pass them
  // concatenated.
  text: string
  sessionId: string
  workspaceId: string
  // Used as TrainingAccessToken.sourceRefId for audit. Pass the rule id
  // for automation sends; 'bulk_email:<userId>' or similar for one-off
  // sends.
  sourceRefId?: string
}

// Scan a template body for {{schedule_link:<id>}} / {{training_link:<id>}}
// sub-tokens and resolve each unique id to its candidate-specific URL.
// Returns a map keyed `schedule_link:<id>` / `training_link:<id>` ready
// to merge into the variables map renderTemplate consumes. Unknown ids
// (cross-workspace, deleted, typo) silently produce no entry — the
// renderer will then substitute an empty string, which is the same
// behaviour as any other unknown token.
export async function resolveDynamicLinks(opts: ResolveLinksOpts): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const scheduleIds = new Set<string>()
  const trainingIds = new Set<string>()
  SUB_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SUB_TOKEN_RE.exec(opts.text)) !== null) {
    if (m[1] === 'schedule_link') scheduleIds.add(m[2])
    else if (m[1] === 'training_link') trainingIds.add(m[2])
  }
  for (const id of Array.from(scheduleIds)) {
    try {
      const resolved = await resolveSchedulingUrl(id, opts.workspaceId)
      if (resolved) {
        out[`schedule_link:${id}`] = buildScheduleRedirectUrl(opts.sessionId, resolved.configId)
      }
    } catch (err) {
      console.error('[template-link] schedule_link resolution failed for id', id, err)
    }
  }
  for (const id of Array.from(trainingIds)) {
    try {
      const training = await prisma.training.findFirst({
        where: { id, workspaceId: opts.workspaceId },
        select: { slug: true },
      })
      if (!training) continue
      const { token } = await createAccessToken({
        sessionId: opts.sessionId,
        trainingId: id,
        sourceRefId: opts.sourceRefId,
      })
      out[`training_link:${id}`] = buildTrainingLink(training.slug, token)
    } catch (err) {
      console.error('[template-link] training_link resolution failed for id', id, err)
    }
  }
  return out
}
