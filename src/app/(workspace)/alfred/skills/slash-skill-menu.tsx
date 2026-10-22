"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Slash menu for the composer: typing "/" as the first character opens the
 * installed skills; picking one pins it to the run this composer is about to
 * start and clears the draft. This is a keyboard path to the same pin the
 * SkillPicker dropdown writes, not a second mechanism — the chosen skill is
 * held by the parent as `skillId` exactly as before.
 */

export type PickableSkill = { id: string; name: string; description: string };
export type SlashSkill = PickableSkill;

export function SlashSkillMenu({
  skills,
  open,
  query,
  onPick,
  onClose,
}: {
  skills: SlashSkill[];
  open: boolean;
  query: string;
  onPick: (skill: SlashSkill) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = skills.filter((skill) =>
    skill.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  // Reset the highlight during render when the filter changes, the React-recommended
  // alternative to an effect setState: no cascading render.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActive(0);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((current) => Math.min(current + 1, matches.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter" || event.key === "Tab") {
        if (matches[active]) {
          event.preventDefault();
          event.stopPropagation();
          onPick(matches[active]);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    // Capture phase so the composer's own Enter-to-send never sees the key.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, matches, active, onPick, onClose]);

  if (!open || matches.length === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Skills"
      className="border-border bg-popover absolute bottom-full left-0 z-20 mb-1 w-full max-w-sm overflow-y-auto rounded-md border shadow-md"
    >
      {matches.map((skill, index) => (
        <li
          key={skill.id}
          role="option"
          aria-selected={index === active}
          onMouseDown={(event) => {
            // mousedown, not click: the composer's blur must not close the menu first.
            event.preventDefault();
            onPick(skill);
          }}
          onMouseEnter={() => setActive(index)}
          className={`cursor-pointer px-3 py-2 text-[13px] ${index === active ? "bg-muted" : ""}`}
        >
          <p className="font-medium">{skill.name}</p>
          {skill.description ? (
            <p className="text-muted-foreground line-clamp-1 text-[11px]">{skill.description}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
