import { io } from "next/cache";
import { Suspense } from "react";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { normalizeEmail, pendingInvitationForToken } from "@/domains/identity/invitations";
import { getAuthContext } from "@/lib/auth";
import { AcceptButton } from "./accept-button";
import { sessionVerifiedEmail } from "./session-email";

export const metadata = { title: "Invitation · Polymath" };

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

async function Invitation({ token }: { token: string }) {
  await io();
  const auth = await getAuthContext();
  const verifiedEmail = await sessionVerifiedEmail(auth);
  const invitation = verifiedEmail ? await pendingInvitationForToken(token) : null;

  // One state for every failure: unknown token, expired, revoked, already
  // used, or a session email that does not match the recipient. The page
  // cannot tell a stranger which emails hold live invitations, so it does
  // not try.
  if (!invitation || !verifiedEmail || invitation.email !== normalizeEmail(verifiedEmail)) {
    return (
      <Screen title="Invitation" description="Invitations are single-use links tied to one email address.">
        <Panel title="Invitation">
          <Empty
            title="This invitation is not valid"
            description="It may be expired, revoked, already used, or meant for a different email. Ask the workspace's admin for a fresh link."
          />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen title="Invitation" description="One click to join the workspace.">
      <Panel title={`Join ${invitation.workspaceName}`}>
        <p className="text-body-dense">
          You were invited to <span className="font-medium">{invitation.workspaceName}</span> as{" "}
          <span className="font-medium capitalize">{invitation.role}</span>. This link is tied to{" "}
          <span className="font-medium">{invitation.email}</span> and expires {dateFormat.format(invitation.expiresAt)}.
        </p>
        <AcceptButton token={token} />
      </Panel>
    </Screen>
  );
}

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <Invitation token={token} />
    </Suspense>
  );
}
