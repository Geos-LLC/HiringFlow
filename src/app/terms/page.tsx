/**
 * Public Terms of Service — referenced from the marketing footer.
 *
 * Written in plain language. Covers account terms, acceptable use,
 * candidate consent, IP, payment, termination, disclaimers, and the
 * limited warranty / liability cap appropriate for a SaaS hiring tool.
 */

import Link from 'next/link'
import { LegalShell } from '../_legal/shell'

export const metadata = {
  title: 'Terms of Service · HireFunnel',
  description:
    'The rules and contract that govern your use of HireFunnel — for both employers and candidates.',
}

const LAST_UPDATED = 'May 19, 2026'
const EFFECTIVE_DATE = 'May 19, 2026'

export default function TermsPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Terms of Service"
      lastUpdated={LAST_UPDATED}
      effectiveDate={EFFECTIVE_DATE}
      tableOfContents={[
        { id: 'intro', label: '1. Agreement to terms' },
        { id: 'eligibility', label: '2. Eligibility' },
        { id: 'accounts', label: '3. Accounts and workspaces' },
        { id: 'service', label: '4. The service' },
        { id: 'plans', label: '5. Plans, billing, and trials' },
        { id: 'customer-data', label: '6. Customer data and content' },
        { id: 'candidate-consent', label: '7. Employer obligations for candidates' },
        { id: 'acceptable-use', label: '8. Acceptable use' },
        { id: 'ai', label: '9. AI features' },
        { id: 'ip', label: '10. Intellectual property' },
        { id: 'third-party', label: '11. Third-party services' },
        { id: 'termination', label: '12. Suspension and termination' },
        { id: 'warranty', label: '13. Disclaimers' },
        { id: 'liability', label: '14. Limitation of liability' },
        { id: 'indemnity', label: '15. Indemnification' },
        { id: 'law', label: '16. Governing law and disputes' },
        { id: 'changes', label: '17. Changes to the terms' },
        { id: 'misc', label: '18. Miscellaneous' },
        { id: 'contact', label: '19. Contact' },
      ]}
    >
      <section id="intro">
        <h2>1. Agreement to these Terms</h2>
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) form a binding agreement between
          you and HireFunnel (&ldquo;HireFunnel&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;)
          and govern your use of the HireFunnel website, applications, and APIs (together,
          the &ldquo;Service&rdquo;). By creating an account, signing in, or using the
          Service, you agree to these Terms and to our{' '}
          <Link href="/privacy">Privacy Policy</Link>.
        </p>
        <p>
          If you are using the Service on behalf of a company or other organization, you
          represent that you have authority to bind that organization to these Terms, and
          &ldquo;you&rdquo; means that organization.
        </p>
      </section>

      <section id="eligibility">
        <h2>2. Eligibility</h2>
        <p>
          You must be at least 16 years old to use the Service. You may not use the Service
          if you are barred from doing so under applicable law, or if your access has been
          previously terminated by us. Candidates submitting through a HireFunnel-powered
          link must be old enough to be eligible for the job they are applying to.
        </p>
      </section>

      <section id="accounts">
        <h2>3. Accounts and workspaces</h2>
        <ul>
          <li>
            You are responsible for everything that happens under your account, including
            the actions of teammates you invite into your workspace.
          </li>
          <li>
            Keep your password secret. Notify us immediately at{' '}
            <a href="mailto:security@hirefunnel.app">security@hirefunnel.app</a> if you
            suspect unauthorized access.
          </li>
          <li>
            One workspace owner is the &ldquo;Account Owner&rdquo; with control over
            billing, members, and data deletion.
          </li>
          <li>
            We may require email verification, two-factor authentication, or other
            reasonable security checks before granting access.
          </li>
        </ul>
      </section>

      <section id="service">
        <h2>4. The Service</h2>
        <p>
          HireFunnel provides tools for building video-based hiring funnels, screening
          candidates, scheduling interviews, and running follow-up automations. We work
          continuously to improve the Service and may add, change, or remove features. If
          we make a material change that meaningfully degrades a feature you rely on, we
          will give you reasonable notice.
        </p>
        <p>
          We do not guarantee uninterrupted availability. Planned maintenance, third-party
          outages, and unforeseen incidents can affect the Service. Our target uptime and
          incident-response commitments for Scale-plan customers are documented in a
          separate Service Level Agreement.
        </p>
      </section>

      <section id="plans">
        <h2>5. Plans, billing, and trials</h2>
        <ul>
          <li>
            Pricing is shown on our <a href="/#pricing">pricing page</a> and may change with
            30 days&rsquo; notice. Current subscribers are billed at the rate in effect
            when they signed up until the next renewal.
          </li>
          <li>
            Paid plans renew automatically at the end of each billing period unless you
            cancel before the renewal date.
          </li>
          <li>
            Fees are non-refundable except where required by law. If you cancel mid-cycle,
            you keep access until the end of the period you paid for.
          </li>
          <li>
            Trials convert to a paid plan only if you choose one. The default free plan
            (&ldquo;Starter&rdquo;) does not require payment.
          </li>
          <li>
            Taxes are your responsibility unless we explicitly state that fees include tax.
          </li>
          <li>
            If a payment fails, we may downgrade or suspend the account after written
            notice and a reasonable grace period.
          </li>
        </ul>
      </section>

      <section id="customer-data">
        <h2>6. Customer data and content</h2>
        <p>
          You own everything you put into HireFunnel — flows, training material, brand
          assets, candidate submissions collected through your workspace, notes, and
          ratings (together, &ldquo;Customer Data&rdquo;).
        </p>
        <p>
          You grant HireFunnel a worldwide, non-exclusive, royalty-free license to host,
          process, transmit, transcribe, summarize, and display Customer Data solely as
          needed to operate the Service for you. We will not use Customer Data to train
          general-purpose AI models, sell it, or use it for advertising.
        </p>
        <p>
          You can export your data at any time using the in-app export tools, and you can
          request a full data export by emailing{' '}
          <a href="mailto:support@hirefunnel.app">support@hirefunnel.app</a>.
        </p>
      </section>

      <section id="candidate-consent">
        <h2>7. Employer obligations for candidates</h2>
        <p>
          If you use HireFunnel to collect submissions from candidates, you are the
          controller of that personal data. You agree to:
        </p>
        <ul>
          <li>
            Give candidates a clear privacy notice that describes what you collect, why,
            who you share it with, and how long you keep it.
          </li>
          <li>
            Obtain any consents required by law in your jurisdiction — including consent
            for video recording, transcription, AI-assisted evaluation, and SMS
            communications where required.
          </li>
          <li>
            Use HireFunnel only for legitimate hiring purposes. Do not discriminate against
            protected classes. Do not collect data you do not need for the role you are
            hiring for.
          </li>
          <li>
            Respond to candidate access, correction, and deletion requests in accordance
            with applicable law. HireFunnel will help where required.
          </li>
          <li>
            Comply with all applicable employment, privacy, and consumer-protection laws,
            including (where relevant) GDPR, CCPA/CPRA, EEOC guidance, the FCRA, and state
            biometric-information laws.
          </li>
        </ul>
        <p>
          HireFunnel is a tool. We do not make hiring decisions. You are solely responsible
          for the hiring decisions you make using the Service.
        </p>
      </section>

      <section id="acceptable-use">
        <h2>8. Acceptable use</h2>
        <p>You agree not to, and not to help anyone else:</p>
        <ul>
          <li>Break the law or violate someone&rsquo;s rights.</li>
          <li>
            Send spam, phishing, malware, unauthorized telemarketing, or material that is
            harmful, harassing, defamatory, or sexually explicit involving minors.
          </li>
          <li>
            Use the Service to collect biometric identifiers without explicit, informed
            consent and a documented retention schedule.
          </li>
          <li>
            Probe, scan, or test the vulnerability of the Service, except through our
            disclosed responsible-disclosure channel.
          </li>
          <li>
            Reverse engineer, copy, scrape, or build a competing product from the Service.
          </li>
          <li>
            Exceed plan limits, share login credentials, or attempt to bypass billing.
          </li>
          <li>
            Upload content you don&rsquo;t have the right to share, or use HireFunnel to
            infringe intellectual-property rights.
          </li>
        </ul>
        <p>
          We may remove content, suspend accounts, or report illegal activity if we
          reasonably believe these rules have been broken.
        </p>
      </section>

      <section id="ai">
        <h2>9. AI features</h2>
        <p>
          HireFunnel uses third-party AI providers (such as OpenAI and Deepgram) to power
          features like transcript generation, AI-assisted question writing, and candidate
          summaries.
        </p>
        <ul>
          <li>
            AI output can be inaccurate, biased, or incomplete. You must review it before
            relying on it for any hiring decision.
          </li>
          <li>
            We have configured our providers to not train their models on your data.
          </li>
          <li>
            AI features may be added, changed, or removed. We will give reasonable notice
            for material changes.
          </li>
          <li>
            You are responsible for telling candidates if AI is used as part of your
            evaluation process when local law requires that disclosure (for example, NYC
            Local Law 144, Illinois AIVI Act, EU AI Act).
          </li>
        </ul>
      </section>

      <section id="ip">
        <h2>10. Intellectual property</h2>
        <p>
          HireFunnel and its underlying technology, design, and content (excluding Customer
          Data) are owned by us and protected by intellectual-property laws. We grant you a
          limited, revocable, non-transferable license to use the Service in accordance
          with these Terms. We retain all rights not expressly granted.
        </p>
        <p>
          We welcome feedback. If you send us feedback or suggestions, you grant us the
          right to use them without restriction or compensation. We will never reveal your
          identity as the source of feedback without your permission.
        </p>
      </section>

      <section id="third-party">
        <h2>11. Third-party services</h2>
        <p>
          The Service integrates with third-party providers (for example, Google Workspace,
          SendGrid, Sigcore, Stripe, OpenAI). Those services are governed by their own terms
          and privacy policies. We are not responsible for third-party services and do not
          control their availability, content, or behavior. Connecting a third-party service
          may grant HireFunnel the permissions described at the time of connection.
        </p>
      </section>

      <section id="termination">
        <h2>12. Suspension and termination</h2>
        <ul>
          <li>
            You can cancel at any time from billing settings. Your account remains active
            until the end of the period you paid for.
          </li>
          <li>
            We may suspend or terminate your access if you materially breach these Terms,
            create risk or possible legal exposure for HireFunnel, or fail to pay fees when
            due, in each case after reasonable notice (immediate when necessary to protect
            the Service or other users).
          </li>
          <li>
            After termination, Customer Data is available for export for 30 days, then
            scheduled for deletion. Backups may persist for up to 90 additional days before
            being purged.
          </li>
          <li>
            Sections that by their nature should survive termination (intellectual
            property, disclaimers, liability limits, governing law) will survive.
          </li>
        </ul>
      </section>

      <section id="warranty">
        <h2>13. Disclaimers</h2>
        <p>
          The Service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>.
          To the maximum extent permitted by law, HireFunnel disclaims all warranties,
          express or implied, including warranties of merchantability, fitness for a
          particular purpose, non-infringement, and any warranty arising from course of
          dealing or trade usage. We do not warrant that the Service will be uninterrupted,
          error-free, or that any defects will be corrected.
        </p>
      </section>

      <section id="liability">
        <h2>14. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, HireFunnel will not be liable for any
          indirect, incidental, special, consequential, exemplary, or punitive damages, or
          for any loss of profits, revenue, data, or goodwill, arising out of or in
          connection with these Terms or the Service, even if advised of the possibility of
          such damages.
        </p>
        <p>
          Our total cumulative liability for any claim arising out of or relating to these
          Terms or the Service is limited to the greater of (a) the amount you paid us in
          the 12 months before the event giving rise to the claim, or (b) US $100.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion or limitation of certain damages,
          so some of the above may not apply to you.
        </p>
      </section>

      <section id="indemnity">
        <h2>15. Indemnification</h2>
        <p>
          You agree to defend, indemnify, and hold harmless HireFunnel and its officers,
          employees, and agents from and against any claims, damages, liabilities, costs,
          and expenses (including reasonable legal fees) arising out of or related to (a)
          your Customer Data, (b) your use of the Service, (c) your violation of these
          Terms, or (d) your violation of any law or third-party right, including the
          rights of candidates.
        </p>
      </section>

      <section id="law">
        <h2>16. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of the State of Michigan, USA, without
          regard to its conflict-of-law principles. The exclusive venue for any dispute
          arising out of these Terms or the Service is the state or federal courts located
          in Michigan, and the parties consent to the personal jurisdiction of those
          courts. Nothing here prevents either party from seeking injunctive relief in any
          court of competent jurisdiction.
        </p>
        <p>
          If you are a consumer in the EU, UK, or another jurisdiction with mandatory
          consumer-protection laws, the mandatory laws of your country of residence apply
          in addition to these Terms.
        </p>
      </section>

      <section id="changes">
        <h2>17. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. For material changes, we will give
          notice by email or by posting a banner in the Service at least 14 days before
          the changes take effect. By continuing to use the Service after the effective
          date, you accept the updated Terms. If you do not agree, stop using the Service
          and cancel your account.
        </p>
      </section>

      <section id="misc">
        <h2>18. Miscellaneous</h2>
        <ul>
          <li>
            <strong>Entire agreement.</strong> These Terms (together with the Privacy
            Policy and any order form or addendum we sign with you) are the entire
            agreement between you and HireFunnel and supersede any prior agreements.
          </li>
          <li>
            <strong>Assignment.</strong> You may not assign these Terms without our prior
            written consent. We may assign these Terms in connection with a merger,
            acquisition, or sale of assets.
          </li>
          <li>
            <strong>Severability.</strong> If any provision is held unenforceable, the
            remaining provisions remain in full force.
          </li>
          <li>
            <strong>No waiver.</strong> Failure to enforce a right is not a waiver of that
            right.
          </li>
          <li>
            <strong>Force majeure.</strong> Neither party is liable for delays caused by
            events outside its reasonable control.
          </li>
          <li>
            <strong>Independent contractors.</strong> We are independent contractors. These
            Terms do not create a partnership, agency, or joint venture.
          </li>
        </ul>
      </section>

      <section id="contact">
        <h2>19. Contact</h2>
        <p>
          Questions about these Terms? Email{' '}
          <a href="mailto:legal@hirefunnel.app">legal@hirefunnel.app</a>. For privacy
          questions, see our <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </section>
    </LegalShell>
  )
}
