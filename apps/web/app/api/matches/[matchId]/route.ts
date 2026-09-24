import { proxyApi } from "../../proxy";

export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return proxyApi(request, `/matches/${encodeURIComponent(matchId)}`);
}
