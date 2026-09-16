import { proxyApi } from "../../proxy";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyApi(request, `/analytics/window${url.search}`);
}
