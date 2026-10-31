export type EvidenceItem = {
  evidence_type?: string;
  source?: string;
  notes?: string;
  evidence_info?: {
    tracking_info?: Array<{ carrier_name?: string; tracking_number?: string }>;
    refund_ids?: string[];
  };
};

export type EvidencePlan = {
  requested: string[];
  satisfiable: string[];
  missing: string[];
  tracking: { carrier: string; number: string } | null;
  refundId: string | null;
};

export function buyerTextOf(dispute: {
  evidences?: EvidenceItem[];
  messages?: Array<{ posted_by?: string; content?: string }>;
}): string {
  const parts: string[] = [];
  for (const ev of dispute.evidences || []) {
    if (ev.source === "SUBMITTED_BY_BUYER" && ev.notes) parts.push(ev.notes);
  }
  for (const message of dispute.messages || []) {
    if ((message.posted_by || "").toUpperCase() === "BUYER" && message.content) parts.push(message.content);
  }
  return parts.join("\n").trim();
}

export function orderTracking(order: {
  purchase_units?: Array<{
    shipping?: { trackers?: Array<{ carrier?: string; carrier_name?: string; tracking_number?: string; status?: string }> };
    payments?: { captures?: Array<{ id?: string }> };
  }>;
} | null): { carrier: string; number: string } | null {
  const tracker = order?.purchase_units?.[0]?.shipping?.trackers?.find((t) => t.tracking_number);
  if (!tracker?.tracking_number) return null;
  return {
    carrier: tracker.carrier || tracker.carrier_name || "OTHER",
    number: tracker.tracking_number,
  };
}

export function refundIdOf(order: {
  purchase_units?: Array<{ payments?: { refunds?: Array<{ id?: string }> } }>;
} | null, dispute?: { extensions?: { mendcash_refund_id?: string } }): string | null {
  return order?.purchase_units?.[0]?.payments?.refunds?.[0]?.id || dispute?.extensions?.mendcash_refund_id || null;
}

export function planEvidence(
  dispute: { evidences?: EvidenceItem[] },
  order: Parameters<typeof orderTracking>[0],
  refundId?: string | null,
): EvidencePlan {
  const requested: string[] = [];
  for (const ev of dispute.evidences || []) {
    if (ev.source === "REQUESTED_FROM_SELLER" && ev.evidence_type && !requested.includes(ev.evidence_type)) {
      requested.push(ev.evidence_type);
    }
  }
  const tracking = orderTracking(order);
  const refund = refundId || null;
  const satisfiable = requested.filter((type) => evidenceSatisfiable(type, tracking, refund));
  const missing = requested.filter((type) => !satisfiable.includes(type));
  return { requested, satisfiable, missing, tracking, refundId: refund };
}

export function evidenceSatisfiable(
  type: string,
  tracking: { carrier: string; number: string } | null,
  refundId: string | null,
): boolean {
  if (type === "PROOF_OF_FULFILLMENT" || type === "PROOF_OF_DELIVERY_SIGNATURE") return Boolean(tracking);
  if (type === "PROOF_OF_REFUND") return Boolean(refundId);
  if (type === "OTHER") return true;
  return false;
}
