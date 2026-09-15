const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

export async function proxyApi(request: Request, path: string): Promise<Response> {
  const upstream = await fetch(`${apiBaseUrl}${path}`, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "application/json", cookie: request.headers.get("cookie") ?? "" },
    body: request.method === "GET" ? undefined : await request.text(),
    cache: "no-store"
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  const sessionCookie = upstream.headers.get("set-cookie");
  if (sessionCookie) headers.set("set-cookie", sessionCookie);
  return new Response(await upstream.text(), { status: upstream.status, headers });
}
