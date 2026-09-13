import type { PageProps } from '@/components/page-props';
import { AuthScreen } from '@/components/auth-screen';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  return <AuthScreen signup={false} query={query} />;
}
