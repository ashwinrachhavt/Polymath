"use client";

import { Select } from "@/components/ui/select";

/*
 * The Assist composer's skill picker. A run is pinned to at most one skill, and
 * only enabled skills can be pinned: the engine refuses a disabled id, so
 * offering one here would be an option that cannot work.
 *
 * The value posts as `skillId` on the existing /api/v1/runs call. There is no
 * separate skill-run endpoint.
 */

export type PickableSkill = { id: string; name: string; description: string };

export function SkillPicker({
  skills,
  value,
  onChange,
  id = "skill",
}: {
  skills: PickableSkill[];
  value: string;
  onChange: (skillId: string) => void;
  id?: string;
}) {
  if (skills.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        Skill
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Skill"
        className="border-input bg-background w-56 rounded-md border px-2 py-1 text-xs"
      >
        <option value="">No skill</option>
        {skills.map((skill) => (
          <option key={skill.id} value={skill.id} title={skill.description}>
            {skill.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
