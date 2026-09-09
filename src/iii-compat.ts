// The single place where this codebase's names meet whatever the installed
// iii-sdk calls them.
//
// 0.23.x reshaped the SDK's public surface: `ISdk` became `IIIClient`, and
// `ApiRequest`, `ApiResponse`, `HttpRequest`, `HttpResponse` and `Logger` left
// the root export entirely (`HttpRequest` survives only under
// `iii-sdk/internal`, which is explicitly internal and not worth depending on).
// The methods the codebase actually calls -- registerFunction, registerTrigger,
// trigger, shutdown -- kept identical signatures, so the change is a renaming
// problem rather than a behavioural one.
//
// Routing every import through here means the next rename touches this file
// instead of the 147 `ISdk` sites across 70 files and the 143 `ApiRequest`
// sites across 2.
//
// The HTTP shapes are declared locally rather than imported. In 0.11.2
// `ApiRequest<TBody>` was only an alias of `HttpRequest<TBody>`, and both are
// plain data carried over the wire, so owning the declaration costs nothing and
// removes a dependency on a type the SDK no longer publishes.

import type { ISdk as SdkClient } from "iii-sdk";

export { TriggerAction, registerWorker } from "iii-sdk";

/**
 * The engine client. Named `ISdk` here because that is what the codebase has
 * called it since the beginning; 0.23.x calls it `IIIClient`.
 */
export type ISdk = SdkClient;

/**
 * An inbound HTTP invocation, as the http worker hands it to a function.
 *
 * Copied field-for-field from the 0.11.2 declaration
 * (`Omit<InternalHttpRequest, "response">`) so the shim is a faithful stand-in
 * rather than a stricter one: every field is required, and `query_params` and
 * `headers` carry `string | string[]` because the worker does not collapse
 * repeated keys. Declaring `body` optional here produced fourteen new
 * "possibly undefined" errors in `api.ts` alone.
 *
 * `request_body` is the raw reader for handlers that stream instead of taking
 * the parsed body.
 */
export interface HttpRequest<TBody = unknown> {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
  request_body: unknown;
}

/** Historical alias. Every REST handler in `src/triggers/api.ts` uses this. */
export type ApiRequest<TBody = unknown> = HttpRequest<TBody>;

/**
 * The structured reply an HTTP handler returns. Distinct from the SDK's
 * `HttpResponse`, which is a streaming handle (`status()`, `headers()`,
 * `stream`, `close()`) for handlers that write the response themselves. This
 * codebase returns the structured form everywhere.
 */
export type ApiResponse<
  TStatus extends number = number,
  TBody = string | Buffer | Record<string, unknown>,
> = {
  status_code: TStatus;
  headers?: Record<string, string>;
  body?: TBody;
};
