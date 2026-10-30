import { redirect } from "next/navigation";

/*
 * The Specialists bench is gone: the roster is hidden, not deleted, and its
 * runs stay readable. This route survives only so an old link lands somewhere
 * useful instead of a 404.
 */
export default function SpecialistsRedirect() {
  redirect("/polymath/skills");
}
