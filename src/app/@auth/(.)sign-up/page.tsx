import type { PageProps } from '@/components/page-props';
import { AuthEntry } from '@/components/auth/auth-entry';

/** "Get started" / "Early access" opened from any page: a dialog over that page. */
export default async function SignUpDialog({ searchParams }: PageProps) {
  return <AuthEntry mode="signup" variant="modal" query={await searchParams} />;
}
