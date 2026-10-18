"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const CandidateFacts = dynamic(() => import("./candidate-facts"), { loading: () => <p role="status">Loading candidate fact controls…</p> });
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, Panel, Screen, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Check, Destination, DisabledAction, Select } from "./controls";
import { SchedulerPanel } from "./scheduler-panel";

/*
 * One settings surface for all three products. Anything this browser cannot
 * actually do is named as unavailable with the reason, rather than shown as a
 * control that pretends to save. The only settings that persist here are the
 * ones the preview store genuinely owns.
 */
export default function Settings() {
  const { state, updatePreferences, resetPreview, notify } = useWorkspace();
  const [resetOpen, setResetOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [factsOpen, setFactsOpen] = useState(false);
  return <Screen title="Settings" description="Preferences affect this shared browser preview. They are not server policy, provider credentials or production account settings." actions={<Destination screen="integrations">Connection catalog</Destination>}>
    <Panel title="Planning preferences">
      <form key={`${state.preferences.timezone}-${state.preferences.weekStart}`} className="grid gap-4" onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); const timezone = String(data.get("timezone")).trim(); try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); } catch { notify("Timezone is not recognized. Enter an IANA timezone such as America/Los_Angeles."); return; } updatePreferences({ timezone, weekStart: data.get("weekStart") as "Monday" | "Sunday" }); notify("Planning preferences saved locally across all three products."); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone (IANA identifier)"><Input required name="timezone" defaultValue={state.preferences.timezone} list="cc-timezones"/><datalist id="cc-timezones">{["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kolkata", "Asia/Tokyo"].map((timezone) => <option key={timezone} value={timezone}/>)}</datalist></Field>
          <Field label="Week starts on"><Select name="weekStart" defaultValue={state.preferences.weekStart}><option>Monday</option><option>Sunday</option></Select></Field>
        </div>
        <Button type="submit" variant="outline">Save planning preferences</Button>
      </form>
    </Panel>

    <SchedulerPanel />

    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Panel title="Accessibility and feedback">
        <Check label="Reduce motion" checked={state.preferences.reducedMotion} onChange={(reducedMotion) => updatePreferences({ reducedMotion })}/>
        <Check label="Enable completion celebrations" checked={state.preferences.celebrations} onChange={(celebrations) => updatePreferences({ celebrations })}/>
        <p className="mt-2 text-xs text-muted-foreground">Appearance is controlled by the shared shell, which already follows your system light or dark preference. System reduced-motion settings remain respected.</p>
      </Panel>
      <Panel title="Execution safety" actions={<Status>{state.preferences.killSwitch ? "Preview kill switch enabled" : "Preview kill switch disabled"}</Status>}>
        <Check label="Keep agent execution and paid-call intent paused" checked={state.preferences.killSwitch} onChange={(killSwitch) => updatePreferences({ killSwitch })}/>
        <p className="mt-3 text-[13px] text-muted-foreground">This preference is local-only. No agent runtime is connected, and disabling it does not enable any paid call or external write. A production kill switch must fence server-side claims and running work; it cannot recall in-flight provider effects.</p>
      </Panel>
    </div>

    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Panel title="Model and tool policy" description="Profile, model routing and tool allowlists are server-owned.">
        <Unavailable feature="Alfred profile and tool policy">Model choice, reasoning effort, allowed tools and per-run budgets are captured server-side when a run starts. Nothing on this screen can widen them.</Unavailable>
        <div className="mt-4 flex flex-wrap gap-2"><Destination screen="agents">Alfred profile</Destination><Destination screen="spending">Spending policy</Destination></div>
      </Panel>
      <Panel title="Connector state" description="Connected accounts, aliases and sync health live in the connection catalog.">
        <Unavailable feature="Connector credentials">Provider secrets never reach this browser. Account connection, aliasing and revocation are server-side domain commands against Composio.</Unavailable>
        <div className="mt-4"><Destination screen="integrations">Open connection catalog</Destination></div>
      </Panel>
    </div>

    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Panel title="Document automation policy" description="Automatic classification and rename are unavailable; manual classification stays usable.">
        <DisabledAction reason="Versioned document policies, extraction and model adapters must be configured.">Enable classification suggestions</DisabledAction>
        <div className="mt-4"><Destination screen="documents">Classify manually</Destination></div>
      </Panel>
      <Panel title="Account and machine clients">
        <Unavailable feature="Profile and API-client settings">Authenticated identity, client token creation, one-time secret display and revocation require server-side domain commands. No token is generated here.</Unavailable>
      </Panel>
    </div>

    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Panel title="Appearance" description="Adopted from the shared shell so every product lens matches.">
        <p className="text-[13px] leading-relaxed text-muted-foreground">Light and dark both follow your system preference, with a manual toggle in the header. One accent colour is used across all three products; per-surface palette switching is not offered.</p>
      </Panel>
      <Panel title="Data and retention" description="What this preview stores, and where it stops.">
        <dl className="grid gap-3 text-[13px]">
          <div><dt className="text-muted-foreground">Stored</dt><dd>Tasks, notes and checkpoints, captures, contacts, reviews, preferences and activity, in this browser&apos;s local storage.</dd></div>
          <div><dt className="text-muted-foreground">Sent anywhere</dt><dd>Nothing. No provider, model or analytics call is made from this preview.</dd></div>
          <div><dt className="text-muted-foreground">Retention</dt><dd>Until you reset the sample workspace, or your browser clears site data.</dd></div>
        </dl>
      </Panel>
    </div>

    <div><Button variant="outline" onClick={() => setFactsOpen(!factsOpen)}>{factsOpen ? "Close candidate facts" : "Prepare candidate facts and résumé setup"}</Button></div>
    {factsOpen && <CandidateFacts/>}

    <Panel title="Reset browser preview" description="Replace local edits, notes, checkpoints, tasks and review decisions with the fictional sample workspace. No production or provider data is affected.">
      <Dialog open={resetOpen} onOpenChange={(open) => { setResetOpen(open); setConfirmation(""); }}>
        <DialogTrigger asChild><Button variant="outline">Reset sample workspace</Button></DialogTrigger>
        <DialogContent>
          <DialogTitle>Replace all preview changes?</DialogTitle>
          <DialogDescription>This resets the shared browser workspace used by all three products. Your local edits and saved notes will be lost. Download any notes you need first.</DialogDescription>
          <Field label="Type RESET to confirm"><Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off"/></Field>
          <Button disabled={confirmation !== "RESET"} onClick={() => { resetPreview(); setResetOpen(false); setConfirmation(""); }}>Confirm reset</Button>
        </DialogContent>
      </Dialog>
    </Panel>
  </Screen>;
}
