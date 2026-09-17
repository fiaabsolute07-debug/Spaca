import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { refreshOwnXProfile } from '@/modules/x/service';

/** POST (form) → the creator's own X profile read again (at most once a day), back to the profile page with a notice. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(publicUrl(request, '/sign-in?return_to=%2Fsettings%2Fprofile'), 303);
  try {
    return NextResponse.redirect(publicUrl(request, withNotice('/settings/profile', 'message', await refreshOwnXProfile(actor))), 303);
  } catch (error) {
    if (!(error instanceof CommandError)) logError('x profile refresh failed', error);
    const message = error instanceof CommandError ? error.message : 'Refreshing from X failed. Try again later.';
    return NextResponse.redirect(publicUrl(request, withNotice('/settings/profile', 'error', message)), 303);
  }
}
