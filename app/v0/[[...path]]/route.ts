import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/airtable-cache/errors";
import { buildAirtableProxyRequest } from "@/lib/airtable-cache/request";
import { getAirtableCacheService } from "@/lib/airtable-cache/service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const proxyRequest = buildAirtableProxyRequest(request);
    const response = await getAirtableCacheService().handle(proxyRequest);

    return NextResponse.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to proxy the Airtable request.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
