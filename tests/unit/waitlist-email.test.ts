import { describe, expect, it } from 'vitest';
import { handleStepUrl, renderWelcomeEmail } from '../../waitlist/lib/email/welcome';

describe('waitlist welcome email', () => {
  it('renders role-specific copy with a working handle-step link', () => {
    const project = renderWelcomeEmail({ role: 'project', email: 'founder@proto.xyz', baseUrl: 'https://join.example.com/', handleToken: 'tok_abcdefghijklmnopqrstuv' });
    expect(project.subject).toBe("You're on the spaca waitlist");
    expect(project.html).toContain('https://join.example.com/?step=handle&amp;r=project&amp;t=tok_abcdefghijklmnopqrstuv');
    expect(project.text).toContain('https://join.example.com/?step=handle&r=project&t=tok_abcdefghijklmnopqrstuv');
    expect(project.html).toContain('https://join.example.com/email/spaca-icon.svg');
    const creator = renderWelcomeEmail({ role: 'creator', email: 'writer@example.com', baseUrl: 'https://join.example.com', handleToken: null });
    expect(creator.subject).toContain('founding creator');
    expect(creator.html).not.toContain('step=handle');
    expect(creator.text).toContain('Reply with 2–3 links');
  });

  it('escapes the recipient and never claims real contact details it does not have', () => {
    const email = renderWelcomeEmail({ role: 'project', email: '<script>@x.co', baseUrl: 'https://join.example.com', handleToken: null });
    expect(email.html).not.toContain('<script>@');
    expect(email.html).toContain('&lt;script&gt;@x.co');
    expect(email.html).toContain('[MAILING ADDRESS]');
    expect(email.text).not.toMatch(/\b0% |guaranteed|escrow/i);
  });

  it('builds the resume link on the waitlist origin', () => {
    expect(handleStepUrl('http://127.0.0.1:3200', 'creator', 'abc_DEF-123456789012345')).toBe('http://127.0.0.1:3200/?step=handle&r=creator&t=abc_DEF-123456789012345');
  });
});
