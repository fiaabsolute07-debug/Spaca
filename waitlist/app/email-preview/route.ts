import { renderWelcomeEmail } from '../../lib/email/welcome';

/** Development-only preview of the welcome email: /email-preview?role=project|creator&format=html|text */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  const role = url.searchParams.get('role') === 'creator' ? 'creator' : 'project';
  const email = renderWelcomeEmail({ role, email: 'you@example.com', baseUrl: url.origin, handleToken: 'preview_token_not_valid_000000', mailingAddress: process.env.WAITLIST_MAILING_ADDRESS });
  if (url.searchParams.get('format') === 'text') return new Response(`Subject: ${email.subject}\n\n${email.text}`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(email.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
}
