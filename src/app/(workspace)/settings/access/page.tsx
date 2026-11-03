import { io } from "next/cache";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { listInvitations, listMembers } from "@/domains/identity/members";
import { ForbiddenRoleError } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth";
import { InviteForm } from "./invite-form";
import { RevokeInvitation } from "./revoke-invitation";
import { MembersTable } from "./members-table";

export const metadata = { title: "Access · Polymath" };

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

async function Access() {
  await io();
  const description =
    "Who belongs to this workspace and which invitations are open. Invitations go out as shareable links.";
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <Screen title="Access" description={description}>
        <Empty
          title="Storage is not configured"
          description="Set DATABASE_URL and apply the database migrations to see members."
        />
      </Screen>
    );
  }
  const auth = await getAuthContext();
  let members;
  try {
    members = await listMembers(auth);
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return (
        <Screen title="Access" description={description}>
          <Empty title="Admins only" description="Ask a workspace owner or admin to review who has access." />
        </Screen>
      );
    }
    throw error;
  }

  // The directory is a member read (D5); invitations carry candidates' email
  // addresses, so that panel stays an admin read and members see the
  // established "Admins only" pattern instead of the data.
  const isAdmin = auth.role === "admin" || auth.role === "owner";
  const invites = isAdmin ? await listInvitations(auth) : null;

  // The one control the matrix withholds from even the owner: demoting
  // themselves while they are the only active owner. The domain enforces the
  // invariant; this only keeps the control honest on the page.
  const soleOwner = members.filter((m) => m.role === "owner" && m.status === "active").length === 1;

  return (
    <Screen title="Access" description={description}>
      <Panel title="Members" description={`${members.length} in this workspace`}>
        <MembersTable members={members} caller={{ userId: auth.userId, role: auth.role }} soleOwner={soleOwner} />
      </Panel>
      <Panel title="Invitations" description="An invitation is single-use, expires, and is tied to one email address.">
        {invites === null ? (
          <Empty title="Admins only" description="Only workspace admins see pending invitations." />
        ) : (
          <>
            <div className="mb-4">
              <InviteForm />
            </div>
            {invites.length === 0 ? (
              <Empty title="No invitations" description="Nothing has been sent from this workspace." />
            ) : (
              <ul className="divide-y">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                    <span>
                      <span className="font-medium">{i.email}</span>
                      <span className="ml-2 text-xs capitalize text-muted-foreground">{i.role}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">expires {dateFormat.format(i.expiresAt)}</span>
                      <Status>{i.state}</Status>
                      {i.state === "pending" ? <RevokeInvitation invitationId={i.id} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
    </Screen>
  );
}

/* io() must sit inside a Suspense boundary; see settings/page.tsx. */
export default function AccessPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-[13px] text-muted-foreground">
          Loading access…
        </p>
      }
    >
      <Access />
    </Suspense>
  );
}
