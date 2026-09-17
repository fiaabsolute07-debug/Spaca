import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { startXConnect } from '@/modules/x/service';

const back = (value: FormDataEntryValue | null) => {
  const path = String(value ?? '');
  return /^\/[^/]/.test(path) && path.length < 300 && !path.startsWith('/api/') ? path : '/settings/profile';
};

/** POST (form) return_to → 303 to X's consent screen (or the local sandbox's). Errors return to the page with a notice. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const returnTo = back(form.get('return_to'));
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(publicUrl(request, `/sign-in?return_to=${encodeURIComponent(returnTo)}`), 303);
  try {
    const destination = await startXConnect(actor, returnTo, publicUrl(request, '/api/x/callback').toString());
    return NextResponse.redirect(destination.startsWith('/') ? publicUrl(request, destination) : destination, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('x connect start failed', error);
    const message = error instanceof CommandError ? error.message : 'Connecting X failed. Try again.';
    return NextResponse.redirect(publicUrl(request, withNotice(returnTo, 'error', message)), 303);
  }
}
