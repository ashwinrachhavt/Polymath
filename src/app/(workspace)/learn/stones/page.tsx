import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getStoneCollection } from "@/domains/stones/queries";
import { getAuthContext } from "@/lib/auth";
import { StoneWall } from "./stone-wall";

export const metadata: Metadata = { title: "Stones · Polymath" };

export default function StonesPage() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-label="Loading stones"
          className="page-content mx-auto flex w-full max-w-5xl flex-col gap-4"
        >
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <StonesSurface />
    </Suspense>
  );
}

async function StonesSurface() {
  await connection();
  const auth = await getAuthContext();
  const collection = await getStoneCollection(auth);
  return (
    <StoneWall
      stones={collection.stones}
      balance={collection.balance}
      level={collection.level}
      earnedToday={collection.earnedToday}
    />
  );
}
