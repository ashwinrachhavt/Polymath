"use client";

import { useState } from "react";
import { Screen, SearchField, Panel, Field } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Select } from "./controls";
import { NewTask, TaskQueue, taskStatuses } from "./task-queue";

export default function Work() {
  const { state } = useWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Active");
  const [project, setProject] = useState("");
  const filtered = state.tasks.filter((task) => task.title.toLowerCase().includes(search.toLowerCase()) && (!project || task.projectId === project) && (status === "All" || (status === "Active" ? task.status !== "DONE" : task.status === status)));
  return <Screen title="Work queue" description="One canonical task model across Command Center and NeuralFlow. Waiting is a deliberate status, not a failed run."><Panel title="Capture a commitment"><NewTask/></Panel><div className="flex flex-wrap items-end gap-4"><SearchField value={search} onChange={setSearch} placeholder="Search commitments"/><Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{["Active", "All", ...taskStatuses].map((value) => <option key={value}>{value}</option>)}</Select></Field><Field label="Project"><Select value={project} onChange={(e) => setProject(e.target.value)}><option value="">All projects</option>{state.projects.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</Select></Field></div><TaskQueue key={`${search}-${status}-${project}`} title={`${filtered.length} commitments`} tasks={filtered}/></Screen>;
}
