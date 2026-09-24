import { proxyApi } from "../../../proxy";

function path(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.pathname.split("/").filter(Boolean).at(-1);
  return `/coach/sessions/${encodeURIComponent(sessionId ?? "")}`;
}

export async function GET(request: Request) {
  return proxyApi(request, path(request));
}

export async function PUT(request: Request) {
  return proxyApi(request, path(request));
}

export async function DELETE(request: Request) {
  return proxyApi(request, path(request));
}
