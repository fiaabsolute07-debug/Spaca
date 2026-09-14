/**
 * Delivers the welcome email through Resend when configured. Without RESEND_API_KEY in development the email
 * is written to waitlist/.local/emails/ for preview instead; in production a missing key is recorded as FAILED.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import type { WelcomeEmail } from './welcome';

export type DeliveryResult = { status: 'SENT' | 'PREVIEWED' | 'FAILED'; id: string | null; error: string | null };

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 8000;

function config() {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim() || null,
    from: process.env.WAITLIST_EMAIL_FROM?.trim() || null,
    replyTo: process.env.WAITLIST_EMAIL_REPLY_TO?.trim() || null,
  };
}

async function writePreview(to: string, email: WelcomeEmail, signupId: string): Promise<DeliveryResult> {
  const dir = resolve(here, '../../.local/emails');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(dir, `${stamp}-${signupId.slice(0, 8)}.html`);
  await writeFile(file, email.html, 'utf8');
  await writeFile(file.replace(/\.html$/, '.txt'), `To: ${to}\nSubject: ${email.subject}\n\n${email.text}`, 'utf8');
  console.log(`waitlist email preview written: ${file}`);
  return { status: 'PREVIEWED', id: null, error: null };
}

export async function deliverWelcomeEmail(to: string, email: WelcomeEmail, signupId: string): Promise<DeliveryResult> {
  const { apiKey, from, replyTo } = config();
  if (!apiKey || !from) {
    if (process.env.NODE_ENV !== 'production') return writePreview(to, email, signupId);
    return { status: 'FAILED', id: null, error: 'Email is not configured (RESEND_API_KEY, WAITLIST_EMAIL_FROM)' };
  }
  try {
    const resend = new Resend(apiKey);
    const send = resend.emails.send(
      {
        from,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(replyTo ? { replyTo } : {}),
        headers: replyTo ? { 'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>` } : undefined,
        tags: [{ name: 'type', value: 'waitlist_welcome' }],
      },
      { idempotencyKey: `waitlist-welcome-${signupId}` },
    );
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Email provider timed out')), TIMEOUT_MS));
    const { data, error } = await Promise.race([send, timeout]);
    if (error || !data) return { status: 'FAILED', id: null, error: String(error?.message ?? 'Unknown provider error').slice(0, 300) };
    return { status: 'SENT', id: data.id, error: null };
  } catch (error) {
    return { status: 'FAILED', id: null, error: (error instanceof Error ? error.message : 'Unknown error').slice(0, 300) };
  }
}
