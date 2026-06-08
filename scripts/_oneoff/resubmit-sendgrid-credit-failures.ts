/**
 * Resubmit the 4 remaining failed "Speaking test eamil" sends that hit
 * SendGrid's "Maximum credits exceeded" before the plan was upgraded.
 * Stephan was handled manually (gnail.com typo turned out to be fine —
 * candidate received it and booked an interview), so he is intentionally
 * excluded from this list.
 *
 * Uses executeStep with executionMode='manual_rerun' — the guard
 * short-circuits to allowed for manual reruns (recruiter intent overrides
 * lifecycle/stage/prereq/idempotency checks), so the prior 'failed'
 * AutomationExecution row does NOT block a fresh dispatch.
 *
 * The new emit boundary is NOT in this loop: the boundary exists to dedup
 * concurrent real-time emitters, not to gate one-off backfills. Each
 * executeStep call goes straight to send and writes a fresh execution row
 * with executionMode='manual_rerun' for the audit trail.
 */
import { executeStep } from '../../src/lib/automation'

const STEP_ID = '1a43cf67-2dc1-4b4e-adf2-3e3e67f463a2' // "Speaking test eamil"

const sessions: Array<{ id: string; candidateName: string; candidateEmail: string }> = [
  { id: '60790830-d5f2-4ae4-a85b-fdf45f245af0', candidateName: 'Jada Black',                  candidateEmail: 'jadablack23@icloud.com' },
  { id: 'b8622bf9-1646-4adb-9d97-98c77e431564', candidateName: 'Karen D. Jennings',            candidateEmail: 'kjennings63@yahoo.com' },
  { id: '54994cdf-c85c-49cb-bd99-32342f22092f', candidateName: 'Kyra Hingst',                  candidateEmail: 'khingst540@gmail.com' },
  { id: 'd74d652b-2f54-4fa0-baa9-6a7a76aba0ee', candidateName: 'Rodolfo Antonio Ramirez Miranda', candidateEmail: 'rramirezmiranda918@gmail.com' },
]

async function main() {
  console.log(`Resubmitting ${sessions.length} sends through executeStep(manual_rerun, force=true)\n`)
  for (const s of sessions) {
    process.stdout.write(`  ${s.candidateName.padEnd(40)} <${s.candidateEmail.padEnd(40)}>  ... `)
    try {
      await executeStep(STEP_ID, s.id, 'email', {
        force: true,
        dispatchCtx: {
          triggerType: 'flow_completed',
          executionMode: 'manual_rerun',
        },
      })
      console.log('OK')
    } catch (err) {
      console.log('FAIL:', err instanceof Error ? err.message : String(err))
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
