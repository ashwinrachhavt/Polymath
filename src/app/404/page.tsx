import { notFound } from "next/navigation";

/*
 * The proxy rewrites genuinely unmatched paths here (src/proxy.ts, QA F8) so
 * an unauthenticated visitor gets the real not-found surface with a 404
 * status instead of a redirect to the landing funnel that masks the miss.
 * notFound() renders src/app/not-found.tsx; the browser keeps the original
 * URL.
 */
export default function NotFoundRenderer() {
  notFound();
}
