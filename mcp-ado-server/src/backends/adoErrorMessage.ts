/**
 * Axios's own error.message for a failed ADO REST call is a generic
 * "Request failed with status code 400" -- the actually useful part (which
 * field/value ADO rejected, the TF400xxx error code) lives in
 * error.response.data, which was previously discarded everywhere a tool
 * handler let a backend error propagate as-is to the MCP SDK's default
 * isError serialization (found live: a real createWorkItem 400 surfaced as
 * nothing more than "Request failed with status code 400").
 */
export function adoErrorMessage(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  if (!response) {
    return error instanceof Error ? error.message : String(error);
  }
  const data = response.data as { message?: string } | string | undefined;
  const detail = typeof data === 'string' ? data : data?.message;
  return `ADO request failed with status ${response.status}${detail ? `: ${detail}` : ''}`;
}
