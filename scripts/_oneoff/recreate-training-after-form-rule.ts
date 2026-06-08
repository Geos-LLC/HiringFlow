/**
 * Recreate the "Training email after completing form" rule on Spotless
 * after it was permanently deleted earlier in this session. Same shape as
 * before, MINUS the stage pin (user principle: automations should not
 * depend on stage).
 *
 * Source of truth for the recreated shape (captured before deletion):
 *   trigger:      flow_completed
 *   flow:         df8473ec (Application Form)
 *   stageId:      null   ← was 'in_progress', removed
 *   steps:
 *     [0] channel=email delay=2m    template="Orientation Cleaners" nextStep=training
 *     [1] channel=email delay=4320m template="Orientation Cleaners" nextStep=training
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const FLOW_ID = 'df8473ec-166d-48ae-a3dc-d7b30bf9061c'

async function main() {
  // Resolve the Orientation Cleaners template + Onboarding training by name
  // (IDs were not captured pre-delete, but names are stable in this workspace).
  const [template, training, anyMember] = await Promise.all([
    prisma.emailTemplate.findFirst({
      where: { workspaceId: WORKSPACE_ID, name: { contains: 'Orientation Cleaners', mode: 'insensitive' } },
      select: { id: true, name: true },
    }),
    prisma.training.findFirst({
      where: { workspaceId: WORKSPACE_ID, title: { contains: 'Onboarding', mode: 'insensitive' } },
      select: { id: true, title: true },
    }),
    prisma.workspaceMember.findFirst({
      where: { workspaceId: WORKSPACE_ID, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    }),
  ])

  if (!template) throw new Error('Orientation Cleaners template not found')
  if (!training) throw new Error('Onboarding training not found')
  if (!anyMember) throw new Error('No workspace owner/admin found to attribute createdBy')

  console.log('Using:')
  console.log(`  template = "${template.name}" (${template.id.slice(0, 8)})`)
  console.log(`  training = "${training.title}" (${training.id.slice(0, 8)})`)
  console.log(`  createdBy = ${anyMember.userId.slice(0, 8)}`)

  // Guard: refuse if a rule with the same name already exists (so the script
  // is safe to re-run if the user already recreated it through the UI).
  const existing = await prisma.automationRule.findFirst({
    where: { workspaceId: WORKSPACE_ID, name: 'Training email after completing form' },
    select: { id: true },
  })
  if (existing) {
    console.log(`\nA rule with this name already exists (${existing.id}). Aborting to avoid duplicates.`)
    return
  }

  const rule = await prisma.automationRule.create({
    data: {
      workspaceId: WORKSPACE_ID,
      createdById: anyMember.userId,
      name: 'Training email after completing form',
      triggerType: 'flow_completed',
      flowId: FLOW_ID,
      stageId: null, // intentionally unpinned
      channel: 'email',
      emailTemplateId: template.id,
      emailDestination: 'applicant',
      nextStepType: 'training',
      trainingId: training.id,
      delayMinutes: 2, // mirrors step 0 for back-compat with any legacy read paths
      isActive: true,
      steps: {
        create: [
          {
            order: 0,
            channel: 'email',
            delayMinutes: 2,
            emailTemplateId: template.id,
            emailDestination: 'applicant',
            nextStepType: 'training',
            trainingId: training.id,
          },
          {
            order: 1,
            channel: 'email',
            delayMinutes: 4320, // 3 days
            emailTemplateId: template.id,
            emailDestination: 'applicant',
            nextStepType: 'training',
            trainingId: training.id,
          },
        ],
      },
    },
    include: { steps: { orderBy: { order: 'asc' } } },
  })

  console.log(`\nCreated rule ${rule.id}`)
  for (const s of rule.steps) {
    console.log(`  step ${s.order}: delay=${s.delayMinutes}m channel=${s.channel} nextStep=${s.nextStepType}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
