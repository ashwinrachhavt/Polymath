import type { ReactNode } from "react";

/*
 * One header shape for every destination: what you are looking at, what it is
 * for, and the actions that belong to it. Actions sit last so the reading
 * order is title, purpose, controls.
 */
export function PageHeader({
  title,
  purpose,
  actions,
}: {
  title: string;
  purpose: string;
  actions?: ReactNode;
}) {
  return (
    <header className="border-border flex flex-wrap items-end justify-between gap-3 border-b px-4 py-4 md:px-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="text-lg font-medium tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{purpose}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A titled block of content. Whitespace separates groups; a card is for things that float. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
