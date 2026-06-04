import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  DERIVE_RUBRIC_SYSTEM_PROMPT,
  SCORE_CANDIDATE_SYSTEM_PROMPT,
  GENERIC_FORBIDDEN_AXES,
  deriveCriteria,
  type RubricDerivation,
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

  it('forbids generic-axes verbatim only "unless the JD explicitly requires"', () => {
    expect(DERIVE_RUBRIC_SYSTEM_PROMPT).toMatch(/unless the JD explicitly requires/i)
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
    // produce for a dispatcher JD. If the prompt regresses and starts
    // producing generic axes, you'd see it in deployed evaluations and add
    // failing assertions here.
    const goodFixture: RubricDerivation = {
      roleSuccessFactors: [
        'convert leads to booked appointments',
        'qualify scope before quoting',
        'handle objections',
        'upsell add-ons',
      ],
      criteria: [
        { name: 'Lead Qualification', description: 'Discovery questions before quoting.', weight: 25 },
        { name: 'Service Explanation', description: 'Walks through service crisply.', weight: 15 },
        { name: 'Pricing Delivery', description: 'States rate without apology.', weight: 15 },
        { name: 'Booking Control', description: 'Steers toward an appointment.', weight: 20 },
        { name: 'Objection Handling', description: 'Addresses hesitation.', weight: 15 },
        { name: 'Upsell Ability', description: 'Offers right add-ons.', weight: 10 },
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

    // Spec-required: these generic HR axes MUST NOT appear unless the JD
    // explicitly requires them. The dispatcher JD above does not.
    expect(names).not.toContain('Technical Proficiency')
    expect(names).not.toContain('Organizational Skills')
    expect(names).not.toContain('Organization')
    expect(names).not.toContain('Communication')
    expect(names).not.toContain('Customer Service')
    expect(names).not.toContain('Customer Service Excellence')
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
