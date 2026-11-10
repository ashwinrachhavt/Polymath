"use client";

import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "cn";
import { recipeToDataUrl } from "@/domains/gamification/recipe";
import type { Stone } from "./stones";
import "./neuralflow-stones.css";

/*
 * A foundry stone's art is the recipe's own SVG (spec §7), validated at the
 * schema boundary before it ever reaches this file. It ships as a data URL
 * inside an <img> - the one rendering where SVG scripts cannot execute - and
 * rides the exact same vitrine / forming CSS the catalog images use, because
 * those selectors style the img elements, not their source.
 */

/** The foundry-stone variant: no catalog entry behind it, just the recipe. */
export function RecipeStoneArt({
  svg,
  name,
  size,
  className,
}: {
  svg: string;
  name: string;
  size: number;
  className?: string;
}) {
  return (
    <span className={cn("nf-vitrine", className)} style={{ width: size, height: size }}>
      {/* A data URL cannot be optimized; unoptimized passes it through untouched. */}
      <Image src={recipeToDataUrl(svg)} alt={name} width={size * 2} height={size * 2} unoptimized />
    </span>
  );
}

export function StoneArt({
  stone,
  size,
  locked = false,
  sheen = false,
  decorative = true,
  className,
  svg,
}: {
  stone: Stone;
  size: number;
  locked?: boolean;
  sheen?: boolean;
  decorative?: boolean;
  className?: string;
  svg?: string;
}) {
  // Size is a per-use dimension, not a design token.
  return (
    <span
      className={cn("nf-vitrine", locked && "nf-locked", sheen && "nf-sheen", className)}
      style={{ width: size, height: size }}
    >
      {svg ? (
        <Image
          src={recipeToDataUrl(svg)}
          alt={decorative ? "" : `${stone.name}${locked ? ", locked" : ""}`}
          width={size * 2}
          height={size * 2}
          unoptimized
        />
      ) : (
        <Image
          src={stone.image}
          alt={decorative ? "" : `${stone.name}${locked ? ", locked" : ""}`}
          width={size * 2}
          height={size * 2}
          sizes={`${size}px`}
        />
      )}
    </span>
  );
}

/*
 * The Opal-style stage (ASH-175): the stone alone on a dark field with a soft
 * halo and a small pedestal, a small-caps caption, and one large readout
 * under it. Used wherever a single stone is the hero - the focus timer and
 * the session reveal. `sub` is a node so the caller can keep the timer's
 * role and aria-label on the readout.
 */
export function StoneStage({
  caption,
  sub,
  children,
  className,
}: {
  caption?: string;
  sub?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("nf-stage", className)}>
      <span className="nf-stage-glow" aria-hidden />
      {children ? (
        <div className="flex flex-col items-center">
          {children}
          <span className="nf-stage-pedestal" aria-hidden />
        </div>
      ) : null}
      {caption ? <p className="nf-stage-caption">{caption}</p> : null}
      {sub ? <div className="nf-stage-sub readout">{sub}</div> : null}
    </div>
  );
}

/* The crystal greys out at the start of an interval and lights up as it elapses. A foundry stone passes its recipe SVG; the animation is identical. */
export function FormingStone({
  stone,
  progress,
  reduceMotion,
  svg,
}: {
  stone: Stone;
  progress: number;
  reduceMotion: boolean;
  svg?: string;
}) {
  const formed = { "--nf-forming": progress } as CSSProperties;
  const src = svg ? recipeToDataUrl(svg) : null;
  return (
    <span className="nf-vitrine nf-forming" style={formed} data-motion={reduceMotion ? "reduce" : "full"} aria-hidden>
      {src ? (
        <>
          <Image className="nf-forming-base" src={src} alt="" width={112} height={112} unoptimized />
          <Image className="nf-forming-lit" src={src} alt="" width={112} height={112} unoptimized />
        </>
      ) : (
        <>
          <Image className="nf-forming-base" src={stone.image} alt="" width={112} height={112} sizes="56px" />
          <Image className="nf-forming-lit" src={stone.image} alt="" width={112} height={112} sizes="56px" />
        </>
      )}
    </span>
  );
}
