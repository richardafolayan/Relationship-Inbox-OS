export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DiagnosticRecord = {
  sessionId: string;
  sequence: number;
  phase: string;
  recordedAt: string;
  geometry: Record<string, unknown>;
};

const store = globalThis as typeof globalThis & {
  __toviViewportDiagnostics?: DiagnosticRecord[];
};

function records(): DiagnosticRecord[] {
  store.__toviViewportDiagnostics ??= [];
  return store.__toviViewportDiagnostics;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 120);
  if (!isPlainRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([key, item]) => [key.slice(0, 80), sanitizeValue(item, depth + 1)])
  );
}

export async function POST(request: Request): Promise<Response> {
  const payload = await request.json().catch(() => null);
  if (!isPlainRecord(payload) || !isPlainRecord(payload.geometry)) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.slice(0, 80) : "";
  const phase = typeof payload.phase === "string" ? payload.phase.slice(0, 80) : "";
  const sequence = typeof payload.sequence === "number" ? payload.sequence : -1;
  if (!sessionId || !phase || !Number.isInteger(sequence) || sequence < 0) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const entry: DiagnosticRecord = {
    sessionId,
    sequence,
    phase,
    recordedAt: new Date().toISOString(),
    geometry: sanitizeValue(payload.geometry) as Record<string, unknown>
  };
  const current = records();
  current.push(entry);
  if (current.length > 500) current.splice(0, current.length - 500);

  return Response.json({ ok: true });
}

export async function GET(): Promise<Response> {
  return Response.json(
    { records: records() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(): Promise<Response> {
  records().splice(0);
  return Response.json({ ok: true });
}
