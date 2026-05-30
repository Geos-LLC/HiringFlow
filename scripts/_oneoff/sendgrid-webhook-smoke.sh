#!/bin/bash
# One-off smoke test for the SendGrid Event Webhook end-to-end pipeline.
# Sends a real email via SendGrid with synthetic customArgs and watches
# for the webhook event to arrive at /api/webhooks/sendgrid.
#
# We deliberately send to bounce-test@simulator.amazonses.com so SendGrid
# generates both processed + bounce events without affecting real users.
set -euo pipefail

SENDGRID_API_KEY=$(grep -E "^SENDGRID_API_KEY" .env.prod | cut -d= -f2- | tr -d '"')

PAYLOAD='{
  "personalizations": [{"to": [{"email": "bounce-test@simulator.amazonses.com"}]}],
  "from": {"email": "noreply@hirefunnel.app", "name": "HireFunnel smoke test"},
  "subject": "Webhook smoke test",
  "content": [{"type": "text/plain", "value": "Synthetic webhook smoke test."}],
  "custom_args": {
    "executionId": "smoke-test-00000000-0000-0000-0000-000000000000",
    "workspaceId": "smoke-test-ws"
  }
}'

echo "$PAYLOAD" > /tmp/sg_payload.json

curl -s -o /tmp/sg_response.json -w "HTTP %{http_code}\n" \
  -X POST "https://api.sendgrid.com/v3/mail/send" \
  -H "Authorization: Bearer $SENDGRID_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "@/tmp/sg_payload.json"

cat /tmp/sg_response.json
