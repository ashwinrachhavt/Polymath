import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Settings · Axiom" };

/*
 * Connections, policies, and preferences. The one rule worth stating on the
 * screen itself: the browser sees aliases and health, never a credential.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" purpose="Configure connections, models, and policies." />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Connected accounts" description="Aliases only. Tokens stay on the server.">
          <EmptyState
            title="Nothing connected"
            description="Gmail, Calendar, Drive, Notion, GitHub, Linear, and Vercel connect here and get a name you choose, like work-gmail."
            action={<Button disabled>Connect an account</Button>}
          />
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Alfred" description="Model, tools, and the budget each run may spend.">
            <EmptyState
              title="No agent profile"
              description="One profile ships in v1. Its allowed tools and accounts are captured at the start of every run."
            />
          </Section>

          <Section title="Spending" description="Reserved before the work, settled after it.">
            <EmptyState
              title="No budget set"
              description="Daily, monthly, and per-run ceilings live here. No run spends past its captured budget."
            />
          </Section>

          <Section title="Access" description="Who this workspace belongs to.">
            <EmptyState
              title="One owner"
              description="Tenancy is in the schema from the start, so collaboration is a later decision rather than a migration."
            />
          </Section>

          <Section title="Preferences" description="Timezone, week start, appearance, and motion.">
            <EmptyState
              title="Using defaults"
              description="Timezone follows the server until you set it. Reduced motion and disabled celebrations land with the settings commands."
            />
          </Section>
        </div>

        <Section title="Execution" description="One switch stops everything that leaves Axiom.">
          <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Pause all external actions</p>
              <p className="text-muted-foreground text-sm">
                Proposals can still be created and reviewed while paused. Nothing is sent.
              </p>
            </div>
            <Badge variant="outline" className="font-normal">
              Not paused
            </Badge>
          </div>
        </Section>
      </div>
    </>
  );
}
