"use client";

import dynamic from "next/dynamic";

const loading = () => <p role="status" className="p-6 text-[13px] text-muted-foreground">Loading screen…</p>;
const Briefing = dynamic(() => import("./briefing"), { loading });
const Inbox = dynamic(() => import("./inbox"), { loading });
const Work = dynamic(() => import("./work"), { loading });
const Contacts = dynamic(() => import("./contacts"), { loading });
const Companies = dynamic(() => import("./companies"), { loading });
const Opportunities = dynamic(() => import("./opportunities"), { loading });
const Applications = dynamic(() => import("./applications"), { loading });
const Documents = dynamic(() => import("./documents"), { loading });
const Writing = dynamic(() => import("./writing"), { loading });
const Spaces = dynamic(() => import("./spaces"), { loading });
const Agents = dynamic(() => import("./agents"), { loading });
const Conversations = dynamic(() => import("./conversations"), { loading });
const Memory = dynamic(() => import("./memory"), { loading });
const Reviews = dynamic(() => import("./reviews"), { loading });
const Spending = dynamic(() => import("./spending"), { loading });
const Companion = dynamic(() => import("./companion"), { loading });
const Integrations = dynamic(() => import("./integrations"), { loading });
const Activity = dynamic(() => import("./activity"), { loading });
const Settings = dynamic(() => import("./settings"), { loading });

export default function CommandCenterScreen({ screen, recordId, invalidRecordId, browserPreview }: { screen: string; recordId?: string; invalidRecordId?: boolean; browserPreview?: boolean }) {
  switch (screen) {
    case "briefing": return <Briefing/>;
    case "inbox": return <Inbox/>;
    case "work": return <Work/>;
    case "contacts": return <Contacts initialId={recordId} invalidSelection={invalidRecordId}/>;
    case "companies": return <Companies initialId={recordId} invalidSelection={invalidRecordId}/>;
    case "opportunities": return <Opportunities initialId={recordId} invalidSelection={invalidRecordId}/>;
    case "applications": return <Applications/>;
    case "documents": return <Documents/>;
    case "writing": return <Writing/>;
    case "spaces": return <Spaces/>;
    case "agents": return <Agents/>;
    case "conversations": return <Conversations/>;
    case "memory": return <Memory/>;
    case "reviews": return <Reviews/>;
    case "spending": return <Spending/>;
    case "companion": return <Companion/>;
    case "integrations": return <Integrations/>;
    case "activity": return <Activity/>;
    case "settings": return <Settings browserPreview={browserPreview ?? false}/>;
    default: return null;
  }
}
