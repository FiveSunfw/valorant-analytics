import { proxyApi } from "../../../../proxy";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const sessionId = parts.at(-2) ?? "";
  return proxyApi(request, `/coach/sessions/${encodeURIComponent(sessionId)}/messages`);
}
