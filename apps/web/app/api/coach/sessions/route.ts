import { proxyApi } from "../../proxy";

export async function GET(request: Request) {
  return proxyApi(request, "/coach/sessions");
}

export async function POST(request: Request) {
  return proxyApi(request, "/coach/sessions");
}
