/**
 * Recruiter-defined custom questions for the built-in booking form.
 *
 * Stored as a JSON blob on SchedulingConfig.customFields so we can evolve
 * the shape without a migration on this project (which has no migrations
 * folder). Answers land on InterviewMeeting.customFieldAnswers as a flat
 * { [fieldId]: string } map.
 *
 * Types kept intentionally narrow (v1):
 *   - text       — single-line input
 *   - textarea   — multi-line input
 *   - radio      — single-choice from `options`
 *
 * Add multi-select / file upload / date only when a real recruiter asks.
 */

export type CustomFieldType = 'text' | 'textarea' | 'radio'

export interface CustomField {
  id: string
  label: string
  type: CustomFieldType
  required: boolean
  /** Present iff type === 'radio'. At least two entries. */
  options?: string[]
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_LABEL = 200
const MAX_ANSWER = 4000
const MAX_FIELDS = 20
const MAX_OPTIONS = 20

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class CustomFieldError extends Error {
  constructor(public field: string, message: string) {
    super(`customFields.${field}: ${message}`)
    this.name = 'CustomFieldError'
  }
}

/**
 * Strict parse for write paths — throws on any malformed entry so we never
 * persist a blob the candidate form can't render.
 */
export function parseCustomFields(input: unknown): CustomField[] {
  if (input === null || input === undefined) return []
  if (!Array.isArray(input)) throw new CustomFieldError('', 'must be an array')
  if (input.length > MAX_FIELDS) {
    throw new CustomFieldError('', `at most ${MAX_FIELDS} fields`)
  }
  const seenIds = new Set<string>()
  const out: CustomField[] = []
  input.forEach((raw, idx) => {
    if (!isObject(raw)) throw new CustomFieldError(`[${idx}]`, 'must be an object')
    const id = raw.id
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new CustomFieldError(`[${idx}].id`, 'must match /^[a-zA-Z0-9_-]{1,64}$/')
    }
    if (seenIds.has(id)) throw new CustomFieldError(`[${idx}].id`, `duplicate id "${id}"`)
    seenIds.add(id)
    const label = raw.label
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new CustomFieldError(`[${idx}].label`, 'required')
    }
    if (label.length > MAX_LABEL) {
      throw new CustomFieldError(`[${idx}].label`, `must be ≤${MAX_LABEL} chars`)
    }
    const type = raw.type
    if (type !== 'text' && type !== 'textarea' && type !== 'radio') {
      throw new CustomFieldError(`[${idx}].type`, 'must be one of: text, textarea, radio')
    }
    const required = raw.required === true
    let options: string[] | undefined
    if (type === 'radio') {
      if (!Array.isArray(raw.options)) {
        throw new CustomFieldError(`[${idx}].options`, 'required for radio type')
      }
      const opts = raw.options
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
      if (opts.length < 2) {
        throw new CustomFieldError(`[${idx}].options`, 'radio needs at least 2 options')
      }
      if (opts.length > MAX_OPTIONS) {
        throw new CustomFieldError(`[${idx}].options`, `at most ${MAX_OPTIONS} options`)
      }
      if (new Set(opts).size !== opts.length) {
        throw new CustomFieldError(`[${idx}].options`, 'options must be unique')
      }
      options = opts
    }
    out.push({ id, label: label.trim(), type, required, options })
  })
  return out
}

/** Lenient parse for read paths — bad blob returns empty rather than 500ing. */
export function parseCustomFieldsOrEmpty(input: unknown): CustomField[] {
  try {
    return parseCustomFields(input)
  } catch {
    return []
  }
}

export interface AnswerValidationError {
  fieldId: string
  message: string
}

export interface AnswerValidationResult {
  ok: boolean
  errors: AnswerValidationError[]
  clean: Record<string, string>
}

/**
 * Validate a candidate's submitted answers against the config's field schema.
 * Silently drops answers for unknown fieldIds (fields removed between page
 * load and submit); trims strings; enforces required + max length + radio
 * option membership.
 */
export function validateCustomFieldAnswers(
  fields: CustomField[],
  answers: unknown,
): AnswerValidationResult {
  const errors: AnswerValidationError[] = []
  const clean: Record<string, string> = {}
  const raw = isObject(answers) ? answers : {}
  for (const field of fields) {
    const val = raw[field.id]
    const str = typeof val === 'string' ? val.trim() : ''
    if (!str) {
      if (field.required) {
        errors.push({ fieldId: field.id, message: `${field.label} is required` })
      }
      continue
    }
    if (str.length > MAX_ANSWER) {
      errors.push({ fieldId: field.id, message: `${field.label} is too long (max ${MAX_ANSWER} chars)` })
      continue
    }
    if (field.type === 'radio') {
      if (!field.options || !field.options.includes(str)) {
        errors.push({ fieldId: field.id, message: `${field.label}: invalid choice` })
        continue
      }
    }
    clean[field.id] = str
  }
  return { ok: errors.length === 0, errors, clean }
}
