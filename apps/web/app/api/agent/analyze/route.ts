import { proxyApi } from "../../proxy";

export async function POST(request: Request) {
  return proxyApi(request, "/agent/analyze");
}
