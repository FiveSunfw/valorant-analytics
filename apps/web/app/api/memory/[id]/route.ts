import { proxyApi } from "../../proxy";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyApi(request, `/memory/${encodeURIComponent(id)}`);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyApi(request, `/memory/${encodeURIComponent(id)}`);
}
