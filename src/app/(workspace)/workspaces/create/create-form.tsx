"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { slugify } from "@/lib/slug";
import { createWorkspaceAction } from "./actions";

/*
 * The create-workspace slice (spec D3). The address field pre-fills from the
 * name while it is untouched, so the common path sends no slug and the domain
 * auto-suffixes collisions; the moment it is edited, the value is the user's
 * explicit choice and a collision comes back as the domain's authored copy.
 * Success is a full navigation, not a router push: the action just wrote the
 * active-workspace cookie, and the whole point is that the next request -
 * including the shell - resolves in the new workspace.
 */
export function CreateWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="grid max-w-md gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await createWorkspaceAction({
            name,
            // Untouched address = auto: the server derives and suffixes from
            // the name. Edited and non-empty = the user's explicit choice.
            slug: slugEdited && slug.trim() ? slug : undefined,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          // The action revalidated the layout, so the push fetches fresh RSC
          // with the cookie it just wrote: the shell renders the new context.
          router.push("/");
        });
      }}
    >
      <Field label="Name">
        <Input
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          placeholder="Acme Studio"
          value={name}
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            if (!slugEdited) setSlug(slugify(next));
          }}
        />
      </Field>
      <Field label="Address">
        <Input
          name="slug"
          autoComplete="off"
          placeholder="acme-studio"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setSlugEdited(true);
          }}
        />
        <span className="text-xs leading-relaxed text-muted-foreground">
          Lowercase letters, numbers, and hyphens. Left as suggested, we pick the next free address if it is taken.
        </span>
      </Field>
      {error ? (
        <p className="text-destructive text-body-dense" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || name.trim().length === 0}>
          {pending ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}
