import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * RTL only arms auto-cleanup when `afterEach` is a global, and this repo does
 * not enable vitest globals. Without this, every component test leaves its
 * rendered tree mounted and the next test in the file queries a document that
 * still holds the previous one's nodes.
 */
afterEach(cleanup);
