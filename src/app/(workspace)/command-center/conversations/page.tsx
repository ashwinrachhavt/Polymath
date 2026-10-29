import { redirect } from "next/navigation";

export const metadata = { title: "Conversations · Polymath" };

/*
 * Conversations live in the Assistant now: /polymath is the chat home, with the
 * composer and the full run history. This URL stays as a bridge so old links
 * and bookmarks land somewhere useful; individual thread URLs keep rendering
 * their history (no record is deleted).
 */
export default function ConversationsPage() {
  redirect("/polymath");
}
