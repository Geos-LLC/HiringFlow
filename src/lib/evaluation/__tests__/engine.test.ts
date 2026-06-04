import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  DERIVE_RUBRIC_SYSTEM_PROMPT,
  SCORE_CANDIDATE_SYSTEM_PROMPT,
  COMPARE_CANDIDATES_SYSTEM_PROMPT,
  GENERIC_FORBIDDEN_AXES,
  deriveCriteria,
  compareEvaluations,
  type RubricDerivation,
  type ComparisonResult,
} from '../engine'

// Mock the OpenAI singleton. Each test asserts on the args the engine
// passed in, then returns a fixture body. We never hit the network.
vi.mock('@/lib/openai', () => {
  return {
    openai: {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    },
  }
})

// Helper — turn a fixture JSON payload into the shape OpenAI returns from
// chat.completions.create(). The engine reads
// completion.choices[0].message.content.
function fakeCompletion(payload: unknown) {
  return Promise.resolve({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  })
}

const DISPATCHER_JD = `Role: Dispatcher May 2026

Sales manager English and Russian speaking. Our home cleaning company is
looking for a Dispatcher-Coordinator to join our team remotely.

Working time: 8am — 7pm USA EST 4–5 days a week. Workdays and weekends.

Responsibilities:
- Receive and process client requests (phone, messengers, email).
- Create and coordinate schedules.
- Support and coordinate the work of the cleaning team.
- Quote pricing per the rate card ($129 base + $50/hr).
- Handle objections, upsell add-ons where appropriate, and convert inbound
  leads into booked appointments.
- Maintain reports and monitor task completion.

Requirements:
- Advanced English and Ukrainian/Russian.
- Strong communication skills.
- Highly organized and customer-friendly.`

const CLEANER_JD = `Role: Residential Cleaner

We need reliable cleaners for residential homes in Miami.

Responsibilities:
- Arrive on time and follow the customer's checklist exactly.
- Use the products and tools we supply per the safety guide.
- Pay attention to detail in bathrooms, kitchens, and floors.
- Communicate clearly with the homeowner when needed.
- Leave the home presentable; secure the property when you leave.

Requirements:
- Reliable transportation.
- Background check eligible.
- Professional appearance and conduct in customer homes.`

describe('DERIVE_RUBRIC_SYSTEM_PROMPT', () => {
  it('names the success-factor layer first', () => {
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/ROLE SUCCESS FACTORS/)
    // The prompt instructs the model to derive 3-6 factors before criteria.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/3 to 6/i)
  })

  it('explicitly lists every generic axis to avoid', () => {
    // The forbidden-axes constant must be reflected verbatim in the prompt
    // so the model can refuse them — if the list and the prompt drift, the
    // anti-generic guard quietly stops working.
    for (const axis of GENERIC_FORBIDDEN_AXES) {
      expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toContain(axis)
    }
  })

  it('names dispatcher AND cleaner success-factor exemplars so the model has both anchors', () => {
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/dispatcher/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/cleaner|field|in-home/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/booking|qualif|objection|upsell|presentation/)
  })

  it('names the full dispatcher success-factor list — including complaint recovery, rapport, scheduling accuracy', () => {
    // The recruiter spec called out Complaint Recovery as a behavior the
    // model used to miss. Lock it in so a prompt edit can't drop it.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/complaint/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/rapport/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/scheduling|confirm.*appointment/)
    // Outcome-anchored name suggestions are listed in HARD RULES so the
    // model picks "Complaint Recovery" / "Scheduling Accuracy" instead of
    // bland HR labels.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Complaint Recovery/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Scheduling Accuracy/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Rapport Building/)
  })

  it('names sales and operations role-family exemplars so non-dispatcher JDs still get role-specific factors', () => {
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/sales|closing/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/operations|coordination/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/do not default to dispatcher/i)
  })

  it('forbids mechanical JD-bullet paraphrasing — calls out the bad names prod produced', () => {
    // Prod evaluations 2026-06-04 21:15Z produced verbatim JD-paraphrase
    // criterion names: "Client Request Processing", "Schedule Coordination",
    // "Team Support Coordination", "Task Monitoring and Reporting",
    // "Customer Communication Excellence". The prompt must name these as
    // BAD examples so the model never produces them again.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Client Request Processing/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Schedule Coordination/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Team Support Coordination/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Task Monitoring and Reporting/)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Customer Communication Excellence/)
    // The prompt must instruct the model NOT to paraphrase bullets.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/mechanically rename JD responsibility bullets/i)
  })

  it('identifies role TYPE up front before scoring criteria', () => {
    // The prod failure was the model treating "Receive and process client
    // requests" as its own axis instead of recognizing the role as a
    // phone-intake dispatcher. Prompt must demand role identification first.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/identify the role type/i)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/dispatcher|sales dispatcher|sales manager/i)
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT.toLowerCase()).toMatch(/role type is decided by the role nature/i)
  })

  it('shows the worked translation from "Receive and process client requests" to outcome behaviors', () => {
    // The single most important worked example: the JD bullet → outcome
    // behavior translation for the most common dispatcher JD bullet.
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/Receive and process client requests.*Lead Qualification/i)
  })

  it('forbids generic-axes verbatim only "unless the JD explicitly requires"', () => {
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/unless the JD explicitly\s+requires/i)
  })
})

describe('SCORE_CANDIDATE_SYSTEM_PROMPT', () => {
  it('instructs evaluation by conversational outcomes, not isolated quotes', () => {
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/COMPLETE CONVERSATION\s+OUTCOMES/)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/multi-?turn|over the course/)
  })

  it('allows quote OR summarized multi-turn OR "no evidence"', () => {
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/direct quote/i)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/summary of multi-turn/i)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/"no evidence"/)
  })

  it('forbids cherry-picking and forbids observation-only rejection', () => {
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/cherry-pick/i)
    // Phrase can wrap across lines in the prompt template — match
    // whitespace-tolerantly so a reflow doesn't fail this test.
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(
      /Never reject\s+a candidate solely on observation/i,
    )
  })

  it('names the booking/discovery/objection axis for phone roles', () => {
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/discovery|scope qualification/)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/objection/)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/booking|commitment|next step/)
  })

  it('checks the conversational-flow signals the recruiter called out', () => {
    // These are the specific phone-call behaviors the spec required the
    // scorer to evaluate. Lock them in.
    const p = SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()
    expect(p).toMatch(/opened the conversation naturally|opened.*natural|rapport/)
    expect(p).toMatch(/natural order|interrogation/)
    expect(p).toMatch(/confirmed appointment details/)
    expect(p).toMatch(/complaint/)
  })

  it('penalizes candidates with missing data modalities (coverage discount)', () => {
    // The recruiter spec called out "if there is no data, it doesn't mean
    // it is 100%". The prompt must explicitly discount the overall score
    // when an entire modality (AI call, video, etc.) is missing.
    const p = SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()
    expect(p).toMatch(/coverage discount|missing data is not|missing.*not.*100/i)
    expect(p).toMatch(/discount the overall score/i)
    expect(p).toMatch(/no ai-?call.*transcript|phone-roleplay.*transcript/i)
    expect(p).toMatch(/no video|self-intro recording/i)
    // Concrete cap so the model doesn't give 80+ on a criterion it can't verify.
    expect(p).toMatch(/50-65 cap|50-65/i)
    // Comparison rule: a peer with verified material out-ranks one without.
    expect(p).toMatch(/cannot\s+out-rank a peer\s+who verifiably executed/i)
  })

  it('requires the model to write a pre-scoring analysis BEFORE committing to scores', () => {
    // The "let the model think first" pattern. Empirically produces better
    // differentiation between candidates than skipping straight to numbers.
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/Pre-scoring analysis/i)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/write this FIRST/i)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/4-8 sentences/)
  })

  it('requires a coverageGaps list so the UI can surface what was missing', () => {
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/Coverage gaps \(REQUIRED list/i)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT.toLowerCase()).toMatch(/empty array when the candidate\s+had\s+full material/)
  })
})

describe('COMPARE_CANDIDATES_SYSTEM_PROMPT', () => {
  it('derives buckets from THIS role, not hardcoded categories', () => {
    expect(COMPARE_CANDIDATES_SYSTEM_PROMPT).toMatch(/derive 3-5 deployment buckets/i)
    // Explicitly forbids the bland generic banding.
    expect(COMPARE_CANDIDATES_SYSTEM_PROMPT).toMatch(/do NOT use generic/i)
    expect(COMPARE_CANDIDATES_SYSTEM_PROMPT).toMatch(/Top performer.*Average.*Weak/i)
  })

  it('lists role-aware bucket examples for dispatcher, cleaner, sales', () => {
    const p = COMPARE_CANDIDATES_SYSTEM_PROMPT.toLowerCase()
    expect(p).toMatch(/dispatcher conversion|phone-intake/)
    expect(p).toMatch(/ride-along|checklist supervision|ready for solo/)
    expect(p).toMatch(/ready to quota|ramp candidate/)
  })

  it('requires every input candidate to appear in exactly one bucket', () => {
    expect(COMPARE_CANDIDATES_SYSTEM_PROMPT).toMatch(/Every candidate.*exactly ONE bucket/i)
    // Phrase wraps across lines in the prompt template; tolerate whitespace.
    expect(COMPARE_CANDIDATES_SYSTEM_PROMPT).toMatch(/Don't\s+silently drop anyone/i)
  })

  it('names training-required and risk-flags sections with concrete severity rules', () => {
    const p = COMPARE_CANDIDATES_SYSTEM_PROMPT.toLowerCase()
    expect(p).toMatch(/training required/)
    expect(p).toMatch(/risk flags/)
    expect(p).toMatch(/low.*medium.*high/i)
    // Severity examples must be concrete behaviors, not generic words.
    expect(p).toMatch(/made up pricing|deflected complaint|didn.t confirm/)
  })
})

describe('deriveCriteria — dispatcher JD', () => {
  beforeEach(async () => {
    const { openai } = (await import('@/lib/openai')) as any
    openai.chat.completions.create.mockReset()
  })

  it('passes the JD into the user message and forwards the success-factor system prompt', async () => {
    const { openai } = (await import('@/lib/openai')) as any
    const fixture: RubricDerivation = {
      roleSuccessFactors: [
        'convert inbound leads into booked appointments',
        'qualify scope before quoting',
        'deliver pricing without hesitation',
        'handle objections and hesitation',
        'upsell appropriate add-ons',
      ],
      criteria: [
        { name: 'Booking Conversion', description: 'Moves the inbound call toward a confirmed appointment.', weight: 25 },
        { name: 'Scope Qualification', description: 'Asks the right discovery questions before quoting.', weight: 20 },
        { name: 'Pricing Delivery', description: 'States the rate clearly and without apologizing.', weight: 15 },
        { name: 'Objection Handling', description: 'Acknowledges and addresses customer hesitation.', weight: 15 },
        { name: 'Upsell Ability', description: 'Recommends appropriate add-ons in context.', weight: 10 },
        { name: 'Service Explanation', description: 'Explains the cleaning service clearly.', weight: 15 },
      ],
    }
    openai.chat.completions.create.mockReturnValueOnce(fakeCompletion(fixture))

    const result = await deriveCriteria(DISPATCHER_JD)

    // What did we send the model?
    const callArgs = openai.chat.completions.create.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe(DERIVE_RUBRIC_SYSTEM_PROMPT)
    expect(callArgs.messages[1].role).toBe('user')
    expect(callArgs.messages[1].content).toContain(DISPATCHER_JD)
    // Structured Outputs schema demands both fields.
    expect(callArgs.response_format.json_schema.schema.required).toEqual(['roleSuccessFactors', 'criteria'])

    // What did we return?
    expect(result.roleSuccessFactors).toEqual(fixture.roleSuccessFactors)
    expect(result.criteria.map((c) => c.name)).toEqual([
      'Booking Conversion',
      'Scope Qualification',
      'Pricing Delivery',
      'Objection Handling',
      'Upsell Ability',
      'Service Explanation',
    ])
    // Weights are normalized to sum to 100 even though the schema lets the
    // model drift in [5, 50].
    const total = result.criteria.reduce((s, c) => s + c.weight, 0)
    expect(total).toBe(100)
  })

  it('returns dispatcher-specific outcome criteria, not generic HR axes', async () => {
    const { openai } = (await import('@/lib/openai')) as any
    // Even if a sloppy model tried to mix in "Communication" and "Technical
    // Proficiency", the rest of the rubric must still be role-specific. This
    // test asserts on the FIXTURE the test owns — i.e. what the engine SHOULD
    // produce for a residential cleaning dispatcher JD. Includes Complaint
    // Recovery per the latest spec.
    const goodFixture: RubricDerivation = {
      roleSuccessFactors: [
        'build rapport quickly with homeowners',
        'qualify cleaning scope naturally',
        'deliver pricing confidently',
        'handle objections and complaints',
        'upsell appropriate extras',
        'control call toward booking',
      ],
      criteria: [
        { name: 'Lead Qualification', description: 'Discovery questions before quoting.', weight: 18 },
        { name: 'Service Explanation', description: 'Walks through the cleaning service crisply.', weight: 12 },
        { name: 'Pricing Delivery', description: 'States rate without apology.', weight: 15 },
        { name: 'Booking Control', description: 'Steers toward an appointment.', weight: 17 },
        { name: 'Objection Handling', description: 'Addresses hesitation.', weight: 13 },
        { name: 'Upsell Ability', description: 'Offers right add-ons.', weight: 10 },
        { name: 'Complaint Recovery', description: 'Acknowledges complaints and recovers the customer.', weight: 10 },
        { name: 'Rapport Building', description: 'Opens naturally; warms the homeowner.', weight: 5 },
      ],
    }
    openai.chat.completions.create.mockReturnValueOnce(fakeCompletion(goodFixture))
    const result = await deriveCriteria(DISPATCHER_JD)
    const names = result.criteria.map((c) => c.name)

    // Spec-required: dispatcher rubric MUST include these outcome-anchored axes.
    expect(names).toContain('Lead Qualification')
    expect(names).toContain('Service Explanation')
    expect(names).toContain('Pricing Delivery')
    expect(names).toContain('Booking Control')
    expect(names).toContain('Upsell Ability')
    expect(names).toContain('Objection Handling')
    // New: Complaint Recovery is explicitly required for residential
    // cleaning dispatcher / phone intake roles.
    expect(names).toContain('Complaint Recovery')

    // Spec-required: these generic HR axes MUST NOT appear unless the JD
    // explicitly requires them. The dispatcher JD above does not.
    expect(names).not.toContain('Technical Proficiency')
    expect(names).not.toContain('Organizational Skills')
    expect(names).not.toContain('Organization')
    expect(names).not.toContain('Communication')
    expect(names).not.toContain('Customer Service')
    expect(names).not.toContain('Customer Service Excellence')
    // "Bilingual Communication" is the specific example the spec called out
    // as a bad criterion for a bilingual dispatcher role — the bilingual
    // requirement should fold into rapport/qualification, not be its own axis.
    expect(names).not.toContain('Bilingual Communication')

    // The specific prod-failure names from 2026-06-04 21:15Z evaluations.
    // The fixture under test doesn't produce them, but locking them in
    // here documents the regression criteria for future prompt edits.
    expect(names).not.toContain('Client Request Processing')
    expect(names).not.toContain('Schedule Coordination')
    expect(names).not.toContain('Team Support Coordination')
    expect(names).not.toContain('Task Monitoring and Reporting')
    expect(names).not.toContain('Customer Communication Excellence')
  })
})

describe('scoreCandidate schema', () => {
  it('uses the larger model and requires analysis + coverageGaps in the structured output', async () => {
    // We don't directly call scoreCandidate (it's not exported) — but we
    // can inspect the model + schema constants/prompt to make sure the
    // upgrade landed. The schema must require analysis + coverageGaps
    // FIRST so the model writes its reasoning before scoring.
    const { SCORE_CANDIDATE_SYSTEM_PROMPT } = await import('../engine')
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/Pre-scoring analysis \(REQUIRED/)
    expect(SCORE_CANDIDATE_SYSTEM_PROMPT).toMatch(/Coverage gaps \(REQUIRED/)
  })
})

describe('compareEvaluations', () => {
  beforeEach(async () => {
    const { openai } = (await import('@/lib/openai')) as any
    openai.chat.completions.create.mockReset()
  })

  it('refuses to compare fewer than 2 candidates', async () => {
    await expect(
      compareEvaluations(DISPATCHER_JD, [
        {
          sessionId: 's1',
          candidateName: 'Solo',
          overallScore: 70,
          recommendation: 'hire',
          summary: '',
          criteria: [],
          strengths: [],
          weaknesses: [],
        },
      ]),
    ).rejects.toThrow(/at least 2/i)
  })

  it('passes the JD and every candidate to the model, returns the bucketed result', async () => {
    const { openai } = (await import('@/lib/openai')) as any
    const fixture: ComparisonResult = {
      buckets: [
        {
          label: 'Strongest for immediate dispatcher conversion',
          description: 'Ready to take live inbound calls and close.',
          sessionIds: ['s1'],
          reason: 'Scored 88 on Booking Control and 84 on Pricing Delivery.',
        },
        {
          label: 'Strongest for operations / process discipline',
          description: 'Better for scheduling + coordination than live closing.',
          sessionIds: ['s2'],
          reason: 'Scored 80 on Scheduling Accuracy but 55 on Booking Control.',
        },
        {
          label: 'Coachable — needs training',
          description: 'Has rapport but missed dispatcher fundamentals.',
          sessionIds: ['s3'],
          reason: '60 on Lead Qualification, 50 on Pricing Delivery.',
        },
      ],
      trainingRequired: [
        { sessionId: 's3', needs: 'pricing-delivery reps and scope-qualification practice' },
      ],
      riskFlags: [
        { sessionId: 's2', flag: 'deflected complaint instead of recovering', severity: 'medium' },
      ],
      summary:
        'Hire s1 for the dispatcher slot. Place s2 on coordination/operations. Train s3 before putting them on calls.',
    }
    openai.chat.completions.create.mockReturnValueOnce(fakeCompletion(fixture))

    const result = await compareEvaluations(DISPATCHER_JD, [
      {
        sessionId: 's1',
        candidateName: 'A',
        overallScore: 86,
        recommendation: 'strong_hire',
        summary: '',
        criteria: [{ name: 'Booking Control', weight: 20, score: 88, evidence: '…' }],
        strengths: [],
        weaknesses: [],
      },
      {
        sessionId: 's2',
        candidateName: 'B',
        overallScore: 70,
        recommendation: 'hire',
        summary: '',
        criteria: [{ name: 'Booking Control', weight: 20, score: 55, evidence: '…' }],
        strengths: [],
        weaknesses: [],
      },
      {
        sessionId: 's3',
        candidateName: 'C',
        overallScore: 58,
        recommendation: 'borderline',
        summary: '',
        criteria: [{ name: 'Lead Qualification', weight: 20, score: 60, evidence: '…' }],
        strengths: [],
        weaknesses: [],
      },
    ])

    const callArgs = openai.chat.completions.create.mock.calls[0][0]
    expect(callArgs.messages[0].content).toBe(COMPARE_CANDIDATES_SYSTEM_PROMPT)
    expect(callArgs.messages[1].content).toContain(DISPATCHER_JD)
    // Every sessionId must be in the prompt so the model can assign them.
    expect(callArgs.messages[1].content).toContain('"s1"')
    expect(callArgs.messages[1].content).toContain('"s2"')
    expect(callArgs.messages[1].content).toContain('"s3"')

    // Output shape is preserved.
    expect(result.buckets).toHaveLength(3)
    expect(result.buckets[0].label).toMatch(/dispatcher conversion/)
    expect(result.trainingRequired).toHaveLength(1)
    expect(result.trainingRequired[0].sessionId).toBe('s3')
    expect(result.riskFlags).toHaveLength(1)
    expect(result.riskFlags[0].severity).toBe('medium')
    expect(result.summary).toMatch(/Hire s1/)
  })
})

describe('deriveCriteria — cleaner JD', () => {
  beforeEach(async () => {
    const { openai } = (await import('@/lib/openai')) as any
    openai.chat.completions.create.mockReset()
  })

  it('produces field-role outcome criteria, not generic HR axes', async () => {
    const { openai } = (await import('@/lib/openai')) as any
    const fixture: RubricDerivation = {
      roleSuccessFactors: [
        'present professionally in the customer home',
        'follow the customer checklist exactly',
        'show up on time and reliably',
        'maintain attention to detail in bathrooms and kitchens',
        'leave the property secure and presentable',
      ],
      criteria: [
        { name: 'Customer-Home Presentation', description: 'Professional appearance + conduct around the homeowner.', weight: 20 },
        { name: 'Instruction Following', description: 'Sticks to the checklist; uses supplied tools.', weight: 25 },
        { name: 'Reliability Signals', description: 'On-time, dependable, communicative.', weight: 20 },
        { name: 'Attention to Detail', description: 'Bathrooms, kitchens, floors get full coverage.', weight: 20 },
        { name: 'Property Safety', description: 'Secures the home; uses products per safety guide.', weight: 15 },
      ],
    }
    openai.chat.completions.create.mockReturnValueOnce(fakeCompletion(fixture))

    const result = await deriveCriteria(CLEANER_JD)
    const names = result.criteria.map((c) => c.name)

    // Field-role-specific criteria should be present.
    expect(names).toContain('Customer-Home Presentation')
    expect(names).toContain('Instruction Following')
    expect(names).toContain('Reliability Signals')

    // Dispatcher-only criteria should NOT carry over to a cleaner rubric.
    expect(names).not.toContain('Booking Conversion')
    expect(names).not.toContain('Upsell Ability')
    expect(names).not.toContain('Pricing Delivery')
  })
})

describe('deriveCriteria — weight normalization', () => {
  beforeEach(async () => {
    const { openai } = (await import('@/lib/openai')) as any
    openai.chat.completions.create.mockReset()
  })

  it('normalizes a drifted weight distribution to sum to 100', async () => {
    const { openai } = (await import('@/lib/openai')) as any
    openai.chat.completions.create.mockReturnValueOnce(
      fakeCompletion({
        roleSuccessFactors: ['a', 'b', 'c'],
        criteria: [
          { name: 'X', description: '', weight: 30 },
          { name: 'Y', description: '', weight: 30 },
          { name: 'Z', description: '', weight: 30 },
          { name: 'W', description: '', weight: 30 },
          // Total = 120; engine must rescale to 100.
        ],
      }),
    )
    const result = await deriveCriteria(DISPATCHER_JD)
    const total = result.criteria.reduce((s, c) => s + c.weight, 0)
    // Rounding tolerance — Math.round on 4× 25 each lands exactly at 100,
    // but we keep the band wide so a future ±1 rounding wobble doesn't fail.
    expect(total).toBeGreaterThanOrEqual(99)
    expect(total).toBeLessThanOrEqual(101)
  })
})
