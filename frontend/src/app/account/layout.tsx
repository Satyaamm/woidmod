import type { ReactNode } from 'react';
import { AccountShell } from '@/features/account/AccountShell';

/** Person-level account context. No org/workspace scope — a profile spans them all. */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
