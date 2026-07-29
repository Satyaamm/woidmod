import { FullPageLoader } from '@/components/common/Loader';

/** Shown inside the shell while a workspace route compiles/loads (App Router Suspense). */
export default function Loading() {
  return <FullPageLoader />;
}
