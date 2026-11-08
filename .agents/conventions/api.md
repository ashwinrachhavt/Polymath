# Resource APIs and protection

## HTTP contracts

- Model public APIs around resources and standard HTTP semantics. GET reads without causing business mutations; POST creates resources or starts operations; PATCH changes specified fields; DELETE removes a resource. Model long-running work as a resource whose state can be retrieved.
- Keep requests self-contained with authenticated identity and explicit inputs. Use stable resource identifiers, bounded pagination, explicit ordering, and documented error shapes. Preserve existing clients when changing a response contract.
- Return status codes that describe the outcome: creation, accepted asynchronous work, invalid input, missing authentication, denied access, missing resource, conflict, throttling, or server failure. A successful HTTP response must not conceal a failed operation.
- Respect method idempotency. For retryable creation or effects, bind an idempotency key to principal, operation, and payload; reject conflicting reuse and replay the recorded result.
- Keep domain logic independent of transport. Next.js server actions and HTTP routes must use equivalent domain checks. This convention does not require replacing internal server actions with HTTP round trips.

## Authorization and input

- Resolve identity on the server. Derive workspace access from verified membership or credential scope, then authorize the specific action and object. A caller-supplied workspace or object ID is input, not authority.
- Scope object lookups, mutations, joins, exports, and cache keys to the authorized tenant. Validate referenced objects belong to the same permitted scope. Return non-disclosing errors where resource existence is sensitive.
- Validate route parameters, query strings, body shape, size, and allowed mutable fields before domain execution. Use explicit update fields to prevent privilege or ownership changes through mass assignment.
- Authenticate internal endpoints and webhooks as deliberately as user routes. Verify webhook signatures and replay protections using the provider contract. Apply CSRF/origin protection to cookie-authenticated mutation boundaries; CORS alone is not authorization.
- Bound request size, page size, execution time, concurrency, and costly operations. For outbound URLs, validate destination and redirects against the permitted access policy to prevent internal-network access.
- Keep credentials server-side and redact secrets and private payloads from logs. Treat retrieved documents and tool outputs as data, never as authority to expand permissions.

## Evidence

For changed access boundaries, test unauthenticated, forbidden-role, cross-workspace, malformed-input, and authorized cases. For effectful endpoints, cover retries and ambiguous provider outcomes. Inspect existing guards in `src/lib/auth/` and the owning domain before adding another authorization mechanism.
