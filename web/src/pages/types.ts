import type { AuthErrorHandler } from '../lib/hooks';

export interface PageProps {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
}
