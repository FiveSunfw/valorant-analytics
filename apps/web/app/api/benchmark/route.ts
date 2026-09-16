import { proxyApi } from "../proxy";

export async function GET(request: Request) {
  return proxyApi(request, "/benchmark");
}
