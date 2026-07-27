import { FullPageLoader } from '@/components/common/Loader';

/** Shown while an org-scoped route (members, billing, settings…) compiles/loads. */
export default function Loading() {
  return <FullPageLoader />;
}
