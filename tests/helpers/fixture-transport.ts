import type { GraphqlReadRequest, Transport, TransportRequest, TransportResult } from "@/domains/integrations/transport";

/*
 * A Transport backed by recorded provider responses. Every test that exercises a
 * read tool uses this instead of the network, so CI needs no credentials and no
 * Composio account.
 *
 * It throws on an unmatched request on purpose: a fixture transport that
 * returned `{}` or a 404 would let a tool with the wrong endpoint or method
 * pass a test it should fail, and the failure would only appear against the real
 * provider.
 */

export type FixtureRoute = {
  method: TransportRequest["method"] | "GRAPHQL";
  /** Matched with `startsWith`, so a route can cover a path plus its query. */
  endpointPrefix: string;
  status: number;
  body: unknown;
};

function matches(route: FixtureRoute, request: TransportRequest): boolean {
  if (route.method === "GRAPHQL" || route.method !== request.method) return false;
  if (!request.endpoint.startsWith(route.endpointPrefix)) return false;
  // A route that declares no query is satisfied by any query; one that declares
  // a query prefix (endpointPrefix includes `?`) is matched by the prefix above.
  return true;
}

export function fixtureTransport(routes: FixtureRoute[]): Transport {
  return {
    async graphql(request: GraphqlReadRequest): Promise<TransportResult> {
      // Matched on the endpoint plus a fragment of the query, so a fixture proves
      // which document the tool sent, not just that it called.
      const route = routes.find((r) => r.method === "GRAPHQL" && request.endpoint.startsWith(r.endpointPrefix.split("#")[0]) && request.query.includes(r.endpointPrefix.split("#")[1] ?? ""));
      if (!route) throw new Error(`fixtureTransport: no GRAPHQL route for ${request.endpoint}`);
      if (route.status >= 400) {
        return { ok: false, code: "provider_error", status: route.status, message: `The connected service returned ${route.status}.` };
      }
      return { ok: true, status: route.status, data: route.body };
    },
    async read(request): Promise<TransportResult> {
      const route = routes.find((candidate) => matches(candidate, request));
      if (!route) {
        throw new Error(
          `fixtureTransport: no route for ${request.method} ${request.endpoint}. ` +
            "Add the fixture rather than letting the read fall through.",
        );
      }
      if (route.status >= 400) {
        return {
          ok: false,
          code: "provider_error",
          status: route.status,
          message: `The connected service returned ${route.status}.`,
        };
      }
      return { ok: true, status: route.status, data: route.body };
    },
  };
}
