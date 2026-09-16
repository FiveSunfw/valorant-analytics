import { proxyApi } from "../proxy";

export async function GET(request: Request) {
  return proxyApi(request, "/memory");
}

export async function POST(request: Request) {
  return proxyApi(request, "/memory");
}
