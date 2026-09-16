import { proxyApi } from "../../../proxy";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return proxyApi(request, `/agent/runs/${encodeURIComponent(runId)}`);
}
