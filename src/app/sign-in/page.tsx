import type { PageProps } from '@/components/page-props';
import { AuthEntry } from '@/components/auth/auth-entry';

export const dynamic = 'force-dynamic';

/** Direct visits and shared links show the same card on its own; in-app links open it as a dialog (app/@auth). */
export default async function SignInPage({ searchParams }: PageProps) {
  return <AuthEntry mode="signin" variant="page" query={await searchParams} />;
}
