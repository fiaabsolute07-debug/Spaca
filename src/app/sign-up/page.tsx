import type { PageProps } from '@/components/page-props';
import { AuthScreen } from '@/components/auth-screen';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  return <AuthScreen signup={true} query={query} />;
}
