/**
 * Public Privacy Policy — referenced from the marketing footer.
 *
 * Plain-language privacy notice tailored to HireFunnel's flow:
 * candidates record videos / answer questions, recruiters review them,
 * data flows through SendGrid (email), Sigcore (SMS), Google Workspace
 * (Meet/Calendar/Drive), Deepgram (transcripts), OpenAI (AI helpers),
 * and is stored on Railway/Postgres + S3.
 */

import Link from 'next/link'
import { LegalShell } from '../_legal/shell'

export const metadata = {
  title: 'Privacy Policy · HireFunnel',
  description:
    'How HireFunnel collects, uses, shares, and protects personal data — for both employers and candidates.',
}

const LAST_UPDATED = 'May 19, 2026'
const EFFECTIVE_DATE = 'May 19, 2026'

export default function PrivacyPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Privacy Policy"
      lastUpdated={LAST_UPDATED}
      effectiveDate={EFFECTIVE_DATE}
      tableOfContents={[
        { id: 'overview', label: '1. Overview' },
        { id: 'who-we-are', label: '2. Who we are' },
        { id: 'what-we-collect', label: '3. What we collect' },
        { id: 'how-we-use', label: '4. How we use it' },
        { id: 'legal-bases', label: '5. Legal bases (GDPR)' },
        { id: 'sharing', label: '6. How we share data' },
        { id: 'subprocessors', label: '7. Subprocessors' },
        { id: 'retention', label: '8. Retention' },
        { id: 'security', label: '9. Security' },
        { id: 'your-rights', label: '10. Your rights' },
        { id: 'candidates', label: '11. Candidate notice' },
        { id: 'cookies', label: '12. Cookies & tracking' },
        { id: 'international', label: '13. International transfers' },
        { id: 'children', label: '14. Children' },
        { id: 'changes', label: '15. Changes' },
        { id: 'contact', label: '16. Contact us' },
      ]}
    >
      <section id="overview">
        <h2>1. Overview</h2>
        <p>
          HireFunnel helps employers run video-first hiring funnels. Candidates record short
          videos, answer questions, and book interviews through a shareable link. Recruiters
          review submissions, schedule meetings, and run automated email and SMS follow-ups.
        </p>
        <p>
          This Privacy Policy explains what personal information we collect from people who
          use HireFunnel (employers, recruiters, and candidates), how we use it, who we
          share it with, and what choices you have. We try to write this in plain language
          and only ask for what we actually need.
        </p>
      </section>

      <section id="who-we-are">
        <h2>2. Who we are</h2>
        <p>
          &ldquo;HireFunnel&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, and &ldquo;our&rdquo;
          refer to the operator of the HireFunnel service at{' '}
          <a href="https://hirefunnel.app">hirefunnel.app</a>. You can reach us at{' '}
          <a href="mailto:privacy@hirefunnel.app">privacy@hirefunnel.app</a>.
        </p>
        <p>
          When an employer uses HireFunnel to screen candidates, the employer is the{' '}
          <strong>data controller</strong> of the candidate&rsquo;s personal data and
          HireFunnel acts as a <strong>data processor</strong> on the employer&rsquo;s
          behalf. For employer account information (names, billing contacts, login
          credentials), HireFunnel is the controller.
        </p>
      </section>

      <section id="what-we-collect">
        <h2>3. What we collect</h2>

        <h3>3.1 Information you give us</h3>
        <ul>
          <li>
            <strong>Account data</strong> — name, work email, password (hashed), workspace
            name, role, and billing details.
          </li>
          <li>
            <strong>Content you upload</strong> — flow questions, training materials,
            templates, branding assets, and notes.
          </li>
          <li>
            <strong>Candidate submissions</strong> (collected from candidates on behalf of
            employers) — video recordings, answers to text or multiple-choice questions,
            uploaded files, contact details (name, email, phone), and any other data the
            employer chooses to collect in their flow.
          </li>
          <li>
            <strong>Scheduling data</strong> — calendar availability, interview times,
            attendee lists, and Google Meet metadata when the employer connects Google
            Workspace.
          </li>
          <li>
            <strong>Support communications</strong> — anything you send us by email, chat,
            or phone.
          </li>
        </ul>

        <h3>3.2 Information we collect automatically</h3>
        <ul>
          <li>
            <strong>Usage data</strong> — pages viewed, buttons clicked, features used,
            timestamps, referring URLs, and approximate location derived from IP address.
          </li>
          <li>
            <strong>Device data</strong> — browser type, operating system, screen size,
            language preference, and device identifiers.
          </li>
          <li>
            <strong>Log data</strong> — IP addresses, request paths, response codes, and
            error traces (used for debugging and abuse prevention).
          </li>
          <li>
            <strong>Cookies and similar technologies</strong> — see Section 12.
          </li>
        </ul>

        <h3>3.3 Information from third parties</h3>
        <ul>
          <li>
            <strong>Google Workspace</strong> — when you connect your Google account, we
            receive calendar events, free/busy data, meeting participant identities, and
            (with your permission) recordings and notes stored in Drive.
          </li>
          <li>
            <strong>Sigcore / SMS provider</strong> — inbound SMS replies from candidates,
            delivery receipts, and reply consent state.
          </li>
          <li>
            <strong>Payment processor</strong> — billing status, subscription level, and
            invoice metadata. We do not store full payment card numbers.
          </li>
        </ul>
      </section>

      <section id="how-we-use">
        <h2>4. How we use it</h2>
        <p>We use personal data to:</p>
        <ul>
          <li>Deliver and operate the HireFunnel service.</li>
          <li>
            Authenticate users, secure accounts, and prevent fraud, spam, and abuse.
          </li>
          <li>
            Process candidate submissions — including transcription of video answers, AI-
            assisted scoring summaries, and automatic routing through the hiring funnel.
          </li>
          <li>
            Send transactional emails and SMS messages (account verification, password
            resets, automation messages sent by employers to candidates).
          </li>
          <li>
            Improve product quality — debug errors, measure performance, and decide what
            to build next. We aggregate or de-identify this data wherever possible.
          </li>
          <li>
            Communicate with you about product updates, security advisories, and policy
            changes. You can opt out of non-essential marketing email at any time.
          </li>
          <li>Meet legal and tax obligations.</li>
        </ul>
        <p>
          We do <strong>not</strong> sell personal data, and we do not use candidate
          submissions to train third-party AI models. Transcription and AI-summary
          providers are configured to disable training on our data.
        </p>
      </section>

      <section id="legal-bases">
        <h2>5. Legal bases (GDPR / UK GDPR)</h2>
        <p>If you are in the EU/EEA, UK, or Switzerland, we rely on these legal bases:</p>
        <ul>
          <li>
            <strong>Contract</strong> — to provide the service you signed up for or applied
            through.
          </li>
          <li>
            <strong>Legitimate interests</strong> — to secure the service, prevent abuse,
            improve features, and run our business. We balance these interests against your
            rights.
          </li>
          <li>
            <strong>Consent</strong> — for optional cookies, marketing emails, and any data
            collection where consent is required. You can withdraw consent at any time.
          </li>
          <li>
            <strong>Legal obligation</strong> — to comply with tax, accounting, and law
            enforcement requirements.
          </li>
        </ul>
      </section>

      <section id="sharing">
        <h2>6. How we share data</h2>
        <p>We share personal data only in the situations below.</p>
        <ul>
          <li>
            <strong>With the employer running the funnel.</strong> If you apply for a job
            through a HireFunnel-powered link, your submission is shared with that employer.
          </li>
          <li>
            <strong>With subprocessors</strong> who help us run the service (see Section 7).
            They are contractually bound to process data only on our instructions.
          </li>
          <li>
            <strong>With other people you share with.</strong> Employers can invite
            teammates to a workspace, share submissions internally, or grant scoped access
            to specific candidates.
          </li>
          <li>
            <strong>For legal reasons</strong> — to comply with laws, court orders, or
            government requests; to enforce our terms; or to protect the rights, property,
            or safety of HireFunnel, our users, or the public.
          </li>
          <li>
            <strong>Business transfers</strong> — if HireFunnel is acquired, merged, or
            sells substantially all of its assets, your data may transfer as part of that
            transaction. We will notify you and honor the commitments in this policy.
          </li>
        </ul>
      </section>

      <section id="subprocessors">
        <h2>7. Subprocessors</h2>
        <p>
          We use the following third parties to operate HireFunnel. Each is bound by a
          data-processing agreement.
        </p>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Purpose</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Vercel</td><td>Application hosting</td><td>US / global edge</td></tr>
              <tr><td>Railway</td><td>Postgres database hosting</td><td>US</td></tr>
              <tr><td>Amazon Web Services</td><td>Video and file storage (S3)</td><td>US</td></tr>
              <tr><td>SendGrid (Twilio)</td><td>Transactional email delivery</td><td>US</td></tr>
              <tr><td>Sigcore</td><td>SMS messaging</td><td>US</td></tr>
              <tr><td>Deepgram</td><td>Video / audio transcription</td><td>US</td></tr>
              <tr><td>OpenAI</td><td>AI-assisted question and summary generation</td><td>US</td></tr>
              <tr><td>Upstash QStash</td><td>Delayed job execution</td><td>US / EU</td></tr>
              <tr><td>Google Cloud</td><td>Calendar, Meet, Drive integrations (employer-connected)</td><td>Global</td></tr>
              <tr><td>Stripe</td><td>Payment processing</td><td>US / EU</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          The current list of subprocessors is available on request. We will give 30 days&rsquo;
          notice before adding a new subprocessor that processes substantial personal data.
        </p>
      </section>

      <section id="retention">
        <h2>8. Retention</h2>
        <ul>
          <li>
            <strong>Account data</strong> — retained while your account is active and for up
            to 12 months after closure, then deleted or anonymized.
          </li>
          <li>
            <strong>Candidate submissions</strong> — retained for the period set by the
            employer (default 180 days, configurable up to 24 months on the Scale plan), then
            deleted. Employers may delete a submission at any time.
          </li>
          <li>
            <strong>Logs</strong> — retained for up to 90 days for security and debugging.
          </li>
          <li>
            <strong>Billing records</strong> — retained for as long as required by tax law
            (typically 7 years).
          </li>
        </ul>
      </section>

      <section id="security">
        <h2>9. Security</h2>
        <p>We protect personal data with industry-standard controls, including:</p>
        <ul>
          <li>TLS 1.2+ encryption for data in transit.</li>
          <li>AES-256 encryption at rest for stored videos and database backups.</li>
          <li>Role-based access controls and least-privilege engineering access.</li>
          <li>Audit logging of administrative actions.</li>
          <li>Regular dependency scans and quarterly security reviews.</li>
          <li>SOC 2 Type II documentation available to Scale-plan customers under NDA.</li>
        </ul>
        <p>
          No system is perfectly secure. If we discover a personal-data breach affecting you,
          we will notify you and the appropriate regulators in accordance with applicable law.
        </p>
      </section>

      <section id="your-rights">
        <h2>10. Your rights</h2>
        <p>
          Depending on where you live, you may have the following rights with respect to
          your personal data:
        </p>
        <ul>
          <li><strong>Access</strong> — a copy of the data we hold about you.</li>
          <li><strong>Correction</strong> — fix data that is inaccurate or incomplete.</li>
          <li><strong>Deletion</strong> — ask us to delete your data, subject to legal exceptions.</li>
          <li><strong>Portability</strong> — receive your data in a machine-readable format.</li>
          <li><strong>Restriction or objection</strong> — limit how we use your data.</li>
          <li><strong>Withdraw consent</strong> — where we rely on consent, you can withdraw it.</li>
          <li>
            <strong>Complaint</strong> — lodge a complaint with your local data-protection
            authority.
          </li>
        </ul>
        <p>
          To exercise these rights, email{' '}
          <a href="mailto:privacy@hirefunnel.app">privacy@hirefunnel.app</a>. If you are a
          candidate and want to access or delete a submission, contact the employer that
          ran the funnel — we will help them honor your request.
        </p>
        <p>
          <strong>California residents.</strong> If you are a California resident, you have
          the right to know, delete, correct, and opt out of the &ldquo;sale&rdquo; or
          &ldquo;sharing&rdquo; of your personal information under the CCPA/CPRA. We do not
          sell personal information.
        </p>
      </section>

      <section id="candidates">
        <h2>11. Notice for candidates</h2>
        <p>
          If you applied for a job using a HireFunnel-powered link, the employer who created
          that link decides what to collect, how to evaluate your submission, and how long to
          keep it. HireFunnel processes your data on their behalf.
        </p>
        <ul>
          <li>
            Your video, transcript, and answers are visible to the employer and anyone they
            invite into their workspace.
          </li>
          <li>
            Transcripts are generated automatically and may contain errors. The employer
            (not HireFunnel) decides how to use them.
          </li>
          <li>
            You can stop SMS messages by replying <code>STOP</code> at any time, and
            unsubscribe from email by clicking the link in any automation message.
          </li>
          <li>
            To request access, correction, or deletion of your submission, contact the
            employer first. You may also email{' '}
            <a href="mailto:privacy@hirefunnel.app">privacy@hirefunnel.app</a> and we will
            forward your request and assist where required by law.
          </li>
        </ul>
      </section>

      <section id="cookies">
        <h2>12. Cookies and tracking</h2>
        <p>We use cookies and similar technologies for these purposes:</p>
        <ul>
          <li><strong>Strictly necessary</strong> — sign-in sessions, security, CSRF tokens.</li>
          <li>
            <strong>Functional</strong> — remember your preferences (theme, language).
          </li>
          <li>
            <strong>Analytics</strong> — measure aggregate usage so we can improve the
            product. We do not use cookies to build advertising profiles or share data with
            ad networks.
          </li>
        </ul>
        <p>
          You can disable non-essential cookies in your browser settings. We do not respond
          to Global Privacy Control or Do-Not-Track headers today because we do not engage
          in cross-site tracking or behavioral advertising.
        </p>
      </section>

      <section id="international">
        <h2>13. International transfers</h2>
        <p>
          HireFunnel is operated from the United States, and most of our subprocessors are
          based in the US. If you access the service from outside the US, your personal data
          will be transferred to, stored, and processed in the US and other countries where
          our subprocessors operate. We rely on Standard Contractual Clauses (SCCs) and
          equivalent transfer mechanisms where required.
        </p>
      </section>

      <section id="children">
        <h2>14. Children</h2>
        <p>
          HireFunnel is not directed at children under 16. We do not knowingly collect
          personal data from anyone under 16. If you believe a child has provided us with
          personal data, contact us and we will delete it.
        </p>
      </section>

      <section id="changes">
        <h2>15. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. When we make material changes
          we will notify account holders by email and update the &ldquo;Last updated&rdquo;
          date at the top of this page. Continued use of HireFunnel after the effective date
          means you accept the revised policy.
        </p>
      </section>

      <section id="contact">
        <h2>16. Contact us</h2>
        <p>
          Questions, requests, or complaints about this policy? Reach us at{' '}
          <a href="mailto:privacy@hirefunnel.app">privacy@hirefunnel.app</a>.
        </p>
        <p>
          For security-related disclosures, please email{' '}
          <a href="mailto:security@hirefunnel.app">security@hirefunnel.app</a>.
        </p>
        <p className="text-sm text-grey-35 mt-8">
          See also: <Link href="/terms" className="underline">Terms of Service</Link>.
        </p>
      </section>
    </LegalShell>
  )
}
