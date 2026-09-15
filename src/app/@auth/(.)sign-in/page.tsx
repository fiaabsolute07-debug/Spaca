import type { PageProps } from '@/components/page-props';
import { AuthEntry } from '@/components/auth/auth-entry';

/** "Log in" opened from any page: a dialog over that page instead of a separate screen. */
export default async function SignInDialog({ searchParams }: PageProps) {
  return <AuthEntry mode="signin" variant="modal" query={await searchParams} />;
}
