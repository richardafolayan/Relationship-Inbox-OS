import type { RiskLevel } from "./types";

interface RiskInput {
  lastInboundAt?: Date | null;
  lastOutboundAt?: Date | null;
  amberHours: number;
  redHours: number;
}

export interface RiskResult {
  level: RiskLevel;
  needsReply: boolean;
  riskReason: string;
  slaDueAt?: Date;
}

export function calculateRisk(input: RiskInput): RiskResult {
  const { lastInboundAt, lastOutboundAt, amberHours, redHours } = input;

  if (!lastInboundAt) {
    return {
      level: "GREEN",
      needsReply: false,
      riskReason: "No inbound messages",
      slaDueAt: undefined
    };
  }

  const needsReply = !lastOutboundAt || lastOutboundAt.getTime() < lastInboundAt.getTime();

  if (!needsReply) {
    return {
      level: "GREEN",
      needsReply: false,
      riskReason: "Replied",
      slaDueAt: undefined
    };
  }

  const now = Date.now();
  const waitedMs = now - lastInboundAt.getTime();
  const amberMs = amberHours * 60 * 60 * 1000;
  const redMs = redHours * 60 * 60 * 1000;

  let level: RiskLevel = "GREEN";
  if (waitedMs >= redMs) {
    level = "RED";
  } else if (waitedMs >= amberMs) {
    level = "AMBER";
  }

  const slaDueAt = new Date(lastInboundAt.getTime() + amberMs);
  const waitedHours = Math.floor(waitedMs / (60 * 60 * 1000));

  return {
    level,
    needsReply,
    riskReason: `Inbound waiting ${waitedHours}h`,
    slaDueAt
  };
}

export function formatSlaCountdown(slaDueAt?: Date | null): string {
  if (!slaDueAt) {
    return "No SLA";
  }

  const diffMs = slaDueAt.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const hours = Math.floor(absMs / (60 * 60 * 1000));
  const minutes = Math.floor((absMs % (60 * 60 * 1000)) / (60 * 1000));

  if (diffMs >= 0) {
    return `Due in ${hours}h ${minutes}m`;
  }

  return `Overdue ${hours}h ${minutes}m`;
}
