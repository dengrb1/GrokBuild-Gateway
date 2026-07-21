/** Join OpenAI-style baseUrl (often ends with /v1) with a path like /v1/models. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let rel = path.startsWith("/") ? path : `/${path}`;
  if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(rel)) {
    rel = rel.replace(/^\/v1/i, "") || "/";
  }
  return `${base}${rel.startsWith("/") ? rel : `/${rel}`}`;
}
