/**
 * One-off: send the baseline meeting confirmation to Vitalii Cheliadnik
 * for his upcoming June 1 interview. He missed the confirmation when
 * his initial booking was filtered out by the Cleaner-pipeline-scoped
 * meeting_scheduled rule; this catches him up before the meeting.
 */
import { sendMeetingConfirmation } from '../../src/lib/scheduling/meeting-confirmation'

const MEETING_ID = '289387c1-e691-4217-ab8b-74540968d70d'

async function main() {
  console.log(`Sending baseline confirmation for meeting ${MEETING_ID}...`)
  const result = await sendMeetingConfirmation(MEETING_ID)
  console.log('Result:', JSON.stringify(result, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
