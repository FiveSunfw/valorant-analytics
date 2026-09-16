import { proxyApi } from "../../proxy";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return proxyApi(request, `/sync/${encodeURIComponent(jobId)}`);
}
