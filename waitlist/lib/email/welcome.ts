/**
 * Onboarding ("welcome") email for new waitlist signups. Table layout and inline styles for email clients;
 * neutral palette matching the site, one dark button. Pure function: safe to unit test and preview.
 */
import type { Role } from '../validate';

export type WelcomeEmailInput = {
  role: Role;
  email: string;
  /** Absolute origin of the waitlist site, e.g. https://join.spaca.xyz */
  baseUrl: string;
  /** One-time token for the optional X handle step; null when the step is unavailable. */
  handleToken: string | null;
  mailingAddress?: string;
};

export type WelcomeEmail = { subject: string; preheader: string; html: string; text: string };

const COPY: Record<Role, { subject: string; preheader: string; intro: string; steps: [string, string][]; cta: string; replyHint: string }> = {
  project: {
    subject: "You're on the spaca waitlist",
    preheader: "Here's what happens next for your launch.",
    intro: "Thanks for joining spaca. We're opening early access in small groups so every pilot campaign gets real attention.",
    steps: [
      ["Add your project's X handle", 'It helps us review your project. It takes about 10 seconds.'],
      ['We review and reach out', 'We check fit and invite projects in small batches.'],
      ['Run your first pilot campaign', 'Brief creators on X, review their work, and pay each one when it is approved.'],
    ],
    cta: 'Add your X handle',
    replyHint: 'Launching soon? Reply with your launch date and the content you need. It helps us prioritize.',
  },
  creator: {
    subject: 'You applied as a founding creator on spaca',
    preheader: 'Two quick steps to help us review your work.',
    intro: "Thanks for applying to spaca as a founding creator. We're onboarding a small group of crypto-native writers first.",
    steps: [
      ['Add your X handle', 'So we can read your work. It takes about 10 seconds.'],
      ['Reply with 2–3 links to your best posts', "Threads, research or launch copy you're proud of."],
      ['We review your work and invite you', 'Creators are chosen for their samples, not follower count.'],
    ],
    cta: 'Add your X handle',
    replyHint: 'Just reply to this email with your links. A real person reads every reply.',
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function handleStepUrl(baseUrl: string, role: Role, token: string): string {
  const url = new URL('/', baseUrl);
  url.searchParams.set('step', 'handle');
  url.searchParams.set('r', role);
  url.searchParams.set('t', token);
  return url.toString();
}

export function renderWelcomeEmail(input: WelcomeEmailInput): WelcomeEmail {
  const copy = COPY[input.role];
  const base = input.baseUrl.replace(/\/+$/, '');
  const ctaUrl = input.handleToken ? handleStepUrl(base, input.role, input.handleToken) : null;
  const privacyUrl = `${base}/privacy`;
  const iconUrl = `${base}/email/spaca-icon.png`;
  const address = input.mailingAddress?.trim() || '[MAILING ADDRESS]';
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

  const steps = copy.steps.map(([title, body], index) => `
              <tr>
                <td valign="top" width="36" style="padding:0 0 18px 0;">
                  <div style="width:26px;height:26px;border-radius:13px;background:#f5f5f7;color:#1d1d1f;font:600 13px/26px ${font};text-align:center;">${index + 1}</div>
                </td>
                <td valign="top" style="padding:2px 0 18px 0;">
                  <div style="font:600 15px/1.4 ${font};color:#1d1d1f;">${escapeHtml(title)}</div>
                  <div style="font:400 14px/1.5 ${font};color:#6e6e73;padding-top:2px;">${escapeHtml(body)}</div>
                </td>
              </tr>`).join('');

  const button = ctaUrl ? `
          <tr>
            <td style="padding:8px 40px 8px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td bgcolor="#1d1d1f" style="border-radius:980px;">
                  <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 26px;font:500 15px/1 ${font};color:#ffffff;text-decoration:none;border-radius:980px;">${escapeHtml(copy.cta)}</a>
                </td>
              </tr></table>
              <div style="font:400 12px/1.5 ${font};color:#86868b;padding-top:10px;">This link works for 7 days.</div>
            </td>
          </tr>` : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:20px;">
        <tr>
          <td style="padding:32px 40px 8px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle"><img src="${escapeHtml(iconUrl)}" width="32" height="32" alt="" style="display:block;border:0;border-radius:7px;"></td>
              <td valign="middle" style="padding-left:10px;font:600 20px/1 ${font};color:#1d1d1f;letter-spacing:-0.5px;">spaca</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0 40px;">
            <h1 style="margin:0;font:600 28px/1.15 ${font};color:#1d1d1f;letter-spacing:-0.6px;">You're on the list.</h1>
            <p style="margin:12px 0 0 0;font:400 16px/1.55 ${font};color:#424245;">${escapeHtml(copy.intro)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 40px 4px 40px;">
            <div style="font:600 12px/1 ${font};color:#86868b;text-transform:uppercase;letter-spacing:0.6px;padding-bottom:16px;">What happens next</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps}
            </table>
          </td>
        </tr>${button}
        <tr>
          <td style="padding:20px 40px 32px 40px;">
            <p style="margin:0;padding:16px 18px;background:#f5f5f7;border-radius:12px;font:400 14px/1.55 ${font};color:#424245;">${escapeHtml(copy.replyHint)}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:20px 40px 0 40px;font:400 12px/1.6 ${font};color:#86868b;">
            You're receiving this because ${escapeHtml(input.email)} joined the spaca waitlist. Reply "unsubscribe" and we'll remove you.<br>
            <a href="${escapeHtml(privacyUrl)}" style="color:#6e6e73;">Privacy</a> · ${escapeHtml(address)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    "You're on the list.",
    '',
    copy.intro,
    '',
    'What happens next',
    ...copy.steps.map(([title, body], index) => `${index + 1}. ${title}: ${body}`),
    '',
    ...(ctaUrl ? [`${copy.cta} (link works for 7 days):`, ctaUrl, ''] : []),
    copy.replyHint,
    '',
    '---',
    `You're receiving this because ${input.email} joined the spaca waitlist. Reply "unsubscribe" and we'll remove you.`,
    `Privacy: ${privacyUrl}`,
    address,
  ].join('\n');

  return { subject: copy.subject, preheader: copy.preheader, html, text };
}
