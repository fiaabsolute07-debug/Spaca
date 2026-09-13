import type { PageProps } from '@/components/page-props';
import { PolicyScreen } from '@/components/policy-screen';

export const dynamic = 'force-dynamic';

export default async function PolicyPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  return <PolicyScreen route="/refund-policy" query={query} />;
}
