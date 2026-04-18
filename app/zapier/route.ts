import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/airtable-cache/errors";
import { getZapierProxyService } from "@/lib/zapier/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const response = await getZapierProxyService().handle(request);

    return NextResponse.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to forward the Zapier request.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
