import type { ReactNode } from "react";

/*
 * One header shape for every destination: what you are looking at, what it is
 * for, and the actions that belong to it. Actions sit last so the reading
 * order is title, purpose, controls.
 *
 * No accent rule above the title: the breadcrumb already names the app, and a
 * second coloured mark on every page made the accent a theme instead of an
 * indicator. The single hairline below is the whole structure, as in Notion.
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
    <header className="page-header border-border bg-background/95 sticky top-12 z-10 border-b backdrop-blur">
      <div className="screen-heading">
        <div className="min-w-0 flex-1">
          <h1 className="screen-title">{title}</h1>
          <p className="screen-description">{purpose}</p>
        </div>
        {actions ? <div className="screen-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/**
 * A titled block of content. Whitespace separates groups; a panel is for
 * things that are genuinely separable. A section is not a container — it has
 * no border, no background, and no padding of its own.
 */
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
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] leading-tight font-medium">{title}</h2>
        {description ? (
          <p className="screen-description">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
