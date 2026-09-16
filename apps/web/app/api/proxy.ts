const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

export async function proxyApi(request: Request, path: string): Promise<Response> {
  const upstream = await fetch(`${apiBaseUrl}${path}`, {
    method: request.method,
    headers: { ...(request.headers.get("content-type") ? { "content-type": request.headers.get("content-type")! } : {}), cookie: request.headers.get("cookie") ?? "" },
    body: request.method === "GET" || request.method === "DELETE" ? undefined : await request.text(),
    cache: "no-store"
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  const sessionCookie = upstream.headers.get("set-cookie");
  if (sessionCookie) headers.set("set-cookie", sessionCookie);
  const location = upstream.headers.get("location");
  if (location) headers.set("location", location);
  return new Response(upstream.status === 204 ? null : await upstream.text(), { status: upstream.status, headers });
}
