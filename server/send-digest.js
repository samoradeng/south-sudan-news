#!/usr/bin/env node
// Weekly email digest sender
// Usage:
//   node server/send-digest.js              # Send to all recipients
//   node server/send-digest.js --preview    # Generate HTML to stdout (no send)
//   node server/send-digest.js --test       # Send only to SMTP_USER (yourself)
//
// Required .env vars:
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=you@gmail.com
//   SMTP_PASS=your-app-password        (Gmail: use App Password, not account password)
//   DIGEST_RECIPIENTS=analyst@ngo.org,researcher@university.edu,journalist@media.org
//   DIGEST_FROM_NAME=Horn Monitor       (optional, defaults to "Horn Monitor")

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const nodemailer = require('nodemailer');
const { initDB } = require('./db');
const { generateDigest, renderDigestHTML, renderDigestText } = require('./digest');

// ─── Config ──────────────────────────────────────────────────

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.DIGEST_FROM_NAME || 'Horn Monitor';
const RECIPIENTS = (process.env.DIGEST_RECIPIENTS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);

const args = process.argv.slice(2);
const isPreview = args.includes('--preview');
const isTest = args.includes('--test');

// ─── Main ────────────────────────────────────────────────────

async function main() {
  // Initialize database (needed for digest queries)
  initDB();

  // Generate the digest
  const digest = generateDigest();
  const html = renderDigestHTML(digest);
  const text = renderDigestText(digest);
  const weekNum = digest.weekNumber;

  // Preview mode: just output the HTML
  if (isPreview) {
    console.log(html);
    return;
  }

  // Validate SMTP config
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error('Missing SMTP configuration. Required .env vars:');
    console.error('  SMTP_HOST, SMTP_USER, SMTP_PASS');
    console.error('');
    console.error('For Gmail:');
    console.error('  SMTP_HOST=smtp.gmail.com');
    console.error('  SMTP_PORT=587');
    console.error('  SMTP_USER=your.email@gmail.com');
    console.error('  SMTP_PASS=your-16-char-app-password');
    console.error('');
    console.error('Generate an App Password at: https://myaccount.google.com/apppasswords');
    process.exit(1);
  }

  // Determine recipients
  let to;
  if (isTest) {
    to = [SMTP_USER];
    console.log(`Test mode: sending only to ${SMTP_USER}`);
  } else {
    to = RECIPIENTS.length > 0 ? RECIPIENTS : [SMTP_USER];
    if (RECIPIENTS.length === 0) {
      console.log('No DIGEST_RECIPIENTS set — sending to SMTP_USER as fallback');
    }
  }

  console.log(`Sending Week ${weekNum} digest to ${to.length} recipient(s)...`);

  // Create SMTP transport
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Verify connection
  try {
    await transporter.verify();
    console.log('SMTP connection verified');
  } catch (err) {
    console.error('SMTP connection failed:', err.message);
    process.exit(1);
  }

  // Build the subject line
  const evtCount = digest.dataPoints.eventsThisWeek;
  const highSevCount = digest.dataPoints.highSevCount;
  const countries = digest.dataPoints.countriesThisWeek.join('/') || 'Horn of Africa';

  let subject = `Horn Risk Delta — Week ${weekNum}`;
  if (evtCount > 0) {
    subject += ` | ${evtCount} events`;
    if (highSevCount > 0) subject += `, ${highSevCount} high-severity`;
  } else {
    subject += ' | Quiet week';
  }

  // Send to each recipient individually (BCC-style, no one sees the list)
  let sent = 0;
  for (const recipient of to) {
    try {
      await transporter.sendMail({
        from: `"${FROM_NAME}" <${SMTP_USER}>`,
        to: recipient,
        subject,
        text,
        html,
      });
      console.log(`  Sent to ${recipient}`);
      sent++;
    } catch (err) {
      console.error(`  Failed to send to ${recipient}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${sent}/${to.length} emails sent successfully.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
