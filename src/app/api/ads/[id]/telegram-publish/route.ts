/**
 * POST /api/ads/[id]/telegram-publish
 *
 * Publish (or schedule) an ad to one or more Telegram channels.
 *
 * Body:
 *   {
 *     channelIds: string[],          // TelegramChannel.id list — all must
 *                                    // belong to the same workspace
 *     text?: string,                 // optional override of the rendered ad text
 *     imageUrl?: string,             // optional override of the ad image
 *     parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
 *     scheduledAt?: string           // ISO-8601 UTC; omitted → send now
 *   }
 *
 * For each channel we (a) pre-create a TelegramPlacement row with status
 * 'queued' so Sigcore's callback can find it by externalRef even if the
 * publish response is slow, then (b) call Sigcore /publish with
 * externalRef = placement.id. On dispatch failure the row is flipped to
 * 'failed' with the error captured. This avoids the orphan placement
 * pattern (see project_qstash_orphan_bug memory).
 *
 * The response carries per-channel results so the UI can render a
 * mixed-success outcome rather than 500ing the whole batch on one bad
 * channel.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { publishToChannel, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'
import { renderAdForTelegram } from '@/lib/telegram-ad-text'

const VALID_PARSE_MODES = new Set(['Markdown', 'MarkdownV2', 'HTML'])

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as {
    channelIds?: string[]
    text?: string
    imageUrl?: string
    parseMode?: string
    scheduledAt?: string
  }
  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter((x) => typeof x === 'string') : []
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'channelIds is required' }, { status: 400 })
  }

  const parseMode = body.parseMode && VALID_PARSE_MODES.has(body.parseMode)
    ? (body.parseMode as 'Markdown' | 'MarkdownV2' | 'HTML')
    : undefined

  let scheduledAt: Date | undefined
  if (body.scheduledAt) {
    const d = new Date(body.scheduledAt)
    if (!Number.isFinite(d.getTime())) {
      return NextResponse.json({ error: 'scheduledAt is not a valid ISO-8601 date' }, { status: 400 })
    }
    if (d.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: 'scheduledAt is in the past' }, { status: 400 })
    }
    scheduledAt = d
  }

  const ad = await prisma.ad.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  const subscription = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: { status: true, mode: true },
  })
  if (!subscription || subscription.status !== 'ready') {
    return NextResponse.json(
      { error: 'Telegram publishing not ready', subscriptionStatus: subscription?.status ?? 'not_initialized' },
      { status: 409 },
    )
  }
  // Sigcore dispatches via Bot API or GramJS depending on the workspace's
  // current mode. The actual capability check (admin-of vs member-of) runs
  // on the Sigcore side via the channel's stored verifyVerdict.
  const asAccount = subscription.mode === 'account'

  const channels = await prisma.telegramChannel.findMany({
    where: { id: { in: channelIds }, workspaceId: ws.workspaceId },
  })
  if (channels.length !== channelIds.length) {
    return NextResponse.json(
      { error: 'One or more channels not found in this workspace' },
      { status: 404 },
    )
  }
  const blocked = channels.filter((c) => c.verifyStatus === 'blocked' || c.verifyStatus === 'unverified')
  if (blocked.length > 0) {
    return NextResponse.json(
      {
        error: 'One or more channels are not verified',
        blockedChannelIds: blocked.map((c) => c.id),
      },
      { status: 409 },
    )
  }

  // Pre-render text once unless caller overrode — same shape for every channel.
  const origin = new URL(request.url).origin
  const renderedText = body.text && body.text.trim().length > 0
    ? body.text
    : renderAdForTelegram(
        {
          headline: ad.headline,
          bodyText: ad.bodyText,
          requirements: ad.requirements,
          benefits: ad.benefits,
          callToAction: ad.callToAction,
          placementUrl: ad.placementUrl,
          slug: ad.slug,
        },
        origin,
      )
  if (!renderedText.trim()) {
    return NextResponse.json({ error: 'Ad has no body to send (fill text or ad fields)' }, { status: 400 })
  }
  const imageUrl = body.imageUrl?.trim() || ad.imageUrl || undefined

  const results: Array<{
    channelId: string
    chatRef: string
    placementId: string
    status: string
    error?: string
  }> = []

  for (const channel of channels) {
    // Pre-create the row so Sigcore's callback has somewhere to land even
    // if our publish() call is slow. externalRef = placement.id ties the
    // two sides together; Sigcore's (workspaceId, externalRef) uniqueness
    // makes the publish call itself idempotent.
    const placement = await prisma.telegramPlacement.create({
      data: {
        workspaceId: ws.workspaceId,
        adId: ad.id,
        channelId: channel.id,
        text: renderedText,
        parseMode: parseMode ?? null,
        imageUrl: imageUrl ?? null,
        status: scheduledAt ? 'scheduled' : 'queued',
        scheduledAt: scheduledAt ?? null,
        createdById: ws.userId,
      },
    })

    try {
      const dispatch = await publishToChannel({
        chatRef: channel.chatRef,
        text: renderedText,
        parseMode,
        imageUrl,
        scheduledAt: scheduledAt?.toISOString(),
        externalRef: placement.id,
        asAccount,
      })
      const updated = await prisma.telegramPlacement.update({
        where: { id: placement.id },
        data: {
          sigcorePlacementId: dispatch.placementId,
          status: dispatch.status,
        },
      })
      results.push({
        channelId: channel.id,
        chatRef: channel.chatRef,
        placementId: updated.id,
        status: updated.status,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await prisma.telegramPlacement.update({
        where: { id: placement.id },
        data: {
          status: 'failed',
          errorCode: err instanceof TelegramApiError && err.status ? `HTTP_${err.status}` : 'DISPATCH_ERROR',
          errorMessage: msg,
          failedAt: new Date(),
        },
      })
      results.push({
        channelId: channel.id,
        chatRef: channel.chatRef,
        placementId: placement.id,
        status: 'failed',
        error: msg,
      })
      // Don't throw — keep trying remaining channels. UI surfaces per-row outcome.
    }
  }

  const failed = results.filter((r) => r.status === 'failed').length
  return NextResponse.json(
    { results, summary: { total: results.length, failed, dispatched: results.length - failed } },
    { status: failed === results.length ? 502 : 200 },
  )
}
