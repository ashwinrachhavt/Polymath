import type { ReactNode } from "react";

/*
 * One header shape for every destination: what you are looking at, what it is
 * for, and the actions that belong to it. Actions sit last so the reading
 * order is title, purpose, controls.
 *
 * The rule under the header is engraved rather than drawn: a second hairline
 * 8px above a 1px border, at 3% opacity. It is the cheapest structural device
 * that reads as machined, and unlike a border it does not compete with the
 * panel edges below it.
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
    <header className="border-border bg-background/95 sticky top-12 z-10 border-b px-4 pt-5 pb-3.5 backdrop-blur md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[15px] leading-none font-medium">{title}</h1>
          <p className="text-muted-foreground text-[13px]">{purpose}</p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
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
          <p className="text-muted-foreground text-[13px]">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
