import { redirect } from "next/navigation";

/*
 * The front door is the conversation (agents/product.md: "A conversation is
 * home"). The decision queue that used to live here did not go away; it moved
 * into the notifications panel, which reads the same ranked queue and adds the
 * agent runs and audit trail beside it. Keeping a second page that showed the
 * same proposals would be one record with two front doors.
 */
export default function Root() {
  redirect("/alfred");
}
