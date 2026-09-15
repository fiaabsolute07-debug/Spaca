import type { PageProps } from '@/components/page-props';
import { AuthEntry } from '@/components/auth/auth-entry';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({ searchParams }: PageProps) {
  return <AuthEntry mode="signup" variant="page" query={await searchParams} />;
}
