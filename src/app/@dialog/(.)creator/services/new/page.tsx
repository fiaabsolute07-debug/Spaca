import Link from 'next/link';
import { getActor } from '@/lib/auth';
import { isCreator } from '@/lib/account';
import { getPostingAccounts } from '@/lib/read-model';
import { NewServiceForm } from '@/components/services/new-service-form';
import { FormDialog } from '@/components/form-dialog';

/**
 * "Create a service" opened from Explore (or any page in the app): the new-service form in a dialog over that page.
 * Opening /creator/services/new directly still shows the full page.
 */
export default async function NewFormDialog() {
  const actor = await getActor();
  if (!actor || !isCreator(actor)) {
    return <FormDialog title="Create a service">
      <p className="muted">{actor ? 'Services are offered from a creator account. This account is a buyer account.' : 'Log in with a creator account to offer a service.'}</p>
      <Link className="button button-dark" href={actor ? '/dashboard' : '/sign-in'}>{actor ? 'Back to your workspace' : 'Log in'}</Link>
    </FormDialog>;
  }
  return <FormDialog title="Create a service" description="Save a draft with its scope, price and one sample. You publish it from My services.">
    <NewServiceForm accounts={await getPostingAccounts(actor.id)} />
  </FormDialog>;
}
