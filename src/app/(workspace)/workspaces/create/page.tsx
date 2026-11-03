import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { CreateWorkspaceForm } from "./create-form";

export const metadata = { title: "Create a workspace · Polymath" };

/*
 * Spec D3: any signed-in user may create a workspace. The page only frames
 * the form; the command does the work and the action lands the creator in
 * the new workspace. Nothing here renders workspace data, so - like the
 * Access console - it degrades to a named empty state on a deployment
 * without storage instead of throwing a preview into an error page.
 */
export default function CreateWorkspacePage() {
  const description = "A workspace is a home for its own conversations, notes, and people. You become its owner.";
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <Screen title="Create a workspace" description={description}>
        <Empty
          title="Storage is not configured"
          description="Set DATABASE_URL and apply the database migrations to create workspaces."
        />
      </Screen>
    );
  }
  return (
    <Screen title="Create a workspace" description={description}>
      <Panel title="New workspace" description="Pick a name; the address suggests itself from it and stays editable.">
        <CreateWorkspaceForm />
      </Panel>
    </Screen>
  );
}
