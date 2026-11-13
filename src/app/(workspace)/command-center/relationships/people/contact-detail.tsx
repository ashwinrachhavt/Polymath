import { Panel, Status } from "@/components/workspace/ui";
import { listCorrespondence } from "@/domains/crm/correspondence";
import { getContactDetail } from "@/domains/crm/queries";
import { RELATIONSHIP_STATUS_LABELS } from "@/domains/crm/status";
import { latestProfileResearch } from "@/domains/knowledge/profile-research";
import { ContactForm } from "../contact-form";
import {
  ArchiveContactButton,
  CancelCorrespondenceButton,
  CorrespondenceForm,
  RequestSendApprovalButton,
  FollowUpForm,
  ObservationForm,
  ResolveFollowUpButton,
  SendApprovedButton,
} from "../contact-detail-controls";
import { ProfileResearchCards } from "../profile-research-cards";
import { ContactResearchControls } from "../profile-research-controls";

/*
 * The CRM contact workspace (detail, edit, research, follow-ups,
 * correspondence, observations), rendered by People when a row is opened
 * with ?id=. It was the /contacts surface before that route folded into
 * People.
 */

export function ContactDetailPanel({
  detail,
  companies,
  correspondence,
  researchCardSet,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getContactDetail>>>;
  companies: Array<{ id: string; name: string }>;
  correspondence: Awaited<ReturnType<typeof listCorrespondence>>;
  researchCardSet: Awaited<ReturnType<typeof latestProfileResearch>>;
}) {
  const { contact } = detail;
  const currentCompany = detail.companies.find((company) => company.isCurrent);
  return (
    <div className="space-y-6">
      <Panel
        title={contact.fullName}
        description={`${contact.title || "No title recorded"}${currentCompany ? ` at ${currentCompany.name}` : ""}`}
        actions={<ArchiveContactButton contactId={contact.id} version={contact.version} />}
      >
        <dl className="mb-4 grid gap-2 text-body-dense sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{contact.primaryEmail || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{contact.phone || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Location</dt>
            <dd>{contact.location || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{RELATIONSHIP_STATUS_LABELS[contact.relationshipStatus]}</dd>
          </div>
        </dl>
        {detail.companies.length ? (
          <div className="mb-4 space-y-1">
            {detail.companies.map((company) => (
              <p key={company.linkId} className="text-xs text-muted-foreground">
                {company.name}
                {company.title ? ` · ${company.title}` : ""} {company.isCurrent ? "(current)" : "(past)"}
              </p>
            ))}
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-body-dense font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Edit contact
          </summary>
          <div className="mt-3">
            <ContactForm
              companies={companies}
              contact={{
                id: contact.id,
                version: contact.version,
                fullName: contact.fullName,
                primaryEmail: contact.primaryEmail,
                phone: contact.phone,
                title: contact.title,
                location: contact.location,
                relationshipStatus: contact.relationshipStatus,
                notes: contact.notes,
                currentCompanyId: currentCompany?.companyId ?? null,
              }}
            />
          </div>
        </details>
      </Panel>
      <Panel title="Research">
        <div className="space-y-4">
          <ContactResearchControls contactId={contact.id} researched={researchCardSet !== null} />
          {researchCardSet ? (
            <ProfileResearchCards cardSet={researchCardSet} />
          ) : (
            <p className="text-body-dense text-muted-foreground">
              Not researched yet. The first pass searches who they are and what they have said recently.
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Follow-ups">
        <div className="mb-4 divide-y divide-border">
          {detail.followUps.map((followUp) => (
            <div key={followUp.id} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
              <div>
                <p className="text-body-dense">{followUp.note || "Follow up"}</p>
                <p className="text-xs text-muted-foreground">
                  {followUp.dueAt ? `Due ${followUp.dueAt.toISOString().slice(0, 10)}` : "No due date"}
                  {followUp.status !== "open" ? ` · ${followUp.status}` : ""}
                </p>
              </div>
              {followUp.status === "open" ? (
                <span className="flex gap-1">
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="done" />
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="cancelled" />
                </span>
              ) : (
                <Status>{followUp.status}</Status>
              )}
            </div>
          ))}
        </div>
        <FollowUpForm contactId={contact.id} />
      </Panel>

      <Panel title="Correspondence" description="Each send is approved in Reviews first.">
        <div className="mb-4 divide-y divide-border">
          {correspondence.map((item) => (
            <div key={item.id} className="py-3 first:pt-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="text-body-dense font-medium">{item.subject ?? "(no subject)"}</p>
                <Status>{item.state}</Status>
                <span className="text-xs text-muted-foreground">{item.channel}</span>
              </div>
              <p className="mb-2 whitespace-pre-wrap text-body-dense leading-relaxed text-muted-foreground">
                {item.body}
              </p>
              {item.state === "drafted" || item.state === "planned" ? (
                <span className="flex flex-wrap items-center gap-2">
                  {item.proposalStatus === "approved" ? (
                    <SendApprovedButton correspondenceId={item.id} />
                  ) : item.proposalStatus === "rejected" ? (
                    <span className="text-xs text-muted-foreground">
                      Send approval was rejected. Cancel this draft and start a new one to change it.
                    </span>
                  ) : (
                    <RequestSendApprovalButton
                      correspondenceId={item.id}
                      version={item.version}
                      hasProposal={!!item.actionProposalId}
                    />
                  )}
                  <CancelCorrespondenceButton correspondenceId={item.id} version={item.version} />
                </span>
              ) : null}
            </div>
          ))}
          {!correspondence.length ? <p className="py-1 text-xs text-muted-foreground">Nothing drafted yet.</p> : null}
        </div>
        <CorrespondenceForm contactId={contact.id} />
      </Panel>

      <Panel title="Observations">
        <div className="mb-4 space-y-3">
          {detail.observations.map((observation) => (
            <div key={observation.id} className="border-b border-border pb-3 last:border-0">
              <p className="whitespace-pre-wrap text-body-dense leading-relaxed">{observation.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {observation.source} · {observation.observedAt.toISOString().slice(0, 10)}
              </p>
            </div>
          ))}
          {!detail.observations.length ? (
            <p className="text-xs text-muted-foreground">No observations recorded yet.</p>
          ) : null}
        </div>
        <ObservationForm contactId={contact.id} />
      </Panel>
    </div>
  );
}
