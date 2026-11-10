"use client";

import { useEffect } from "react";
import { recordDocumentOpenAction } from "./open-actions";

/*
 * Counts one open per mount of the document detail. It lives on the client,
 * not in the server render, so a router refresh after a review decision does
 * not count as another open. A failed write is dropped: the open count is a
 * signal, never something the screen waits on.
 */
export function OpenRecorder({ documentId }: { documentId: string }) {
  useEffect(() => {
    void recordDocumentOpenAction(documentId).catch(() => undefined);
  }, [documentId]);
  return null;
}
