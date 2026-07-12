import {
  type CinemaMandate,
  type CinemaMandateReport,
  type UnsealedEvent,
  cinemaMandateReportSchema,
  cinemaMandateSchema,
  newId,
} from '@amrita/protocol';
import type { Store } from '@amrita/store';

/**
 * Cinema mandates (ADR-0029), extracted from the kernel in R2: a derived
 * open/resolved projection over the conversation's event log — no new table
 * (ADR-0027 discipline). amritad records intent + outcome; the module executes
 * under its own trust ladder and reports back.
 */

export function issueCinemaMandate(
  store: Store,
  input: {
    projectId: string;
    conversationId: string;
    goal: string;
    allowedVerbs?: string[];
    maxRisk?: 'local' | 'credit' | 'destructive' | 'ambiguous';
    note?: string;
  },
): { mandateId: string } {
  const mandate: CinemaMandate = cinemaMandateSchema.parse({
    mandateId: newId(),
    goal: input.goal,
    ...(input.allowedVerbs?.length ? { allowedVerbs: input.allowedVerbs } : {}),
    maxRisk: input.maxRisk ?? 'credit',
    ...(input.note ? { note: input.note } : {}),
    issuedAt: new Date().toISOString(),
  });
  store.appendEvent({
    id: newId(),
    ts: new Date().toISOString(),
    projectId: input.projectId,
    conversationId: input.conversationId,
    origin: 'agent',
    type: 'module.mandate.issued',
    payload: { moduleId: 'cinema', mandate },
  } as UnsealedEvent);
  return { mandateId: mandate.mandateId };
}

export function listCinemaMandates(
  store: Store,
  conversationId: string,
  openOnly = false,
): { mandate: CinemaMandate; status: 'open' | 'resolved'; report?: CinemaMandateReport }[] {
  const issued = new Map<string, CinemaMandate>();
  const reports = new Map<string, CinemaMandateReport>();
  for (const ev of store.getEvents(conversationId, 0)) {
    if (ev.type === 'module.mandate.issued') {
      const p = ev.payload as { moduleId: string; mandate: CinemaMandate };
      if (p.moduleId === 'cinema') issued.set(p.mandate.mandateId, p.mandate);
    } else if (ev.type === 'module.mandate.resolved') {
      const p = ev.payload as { moduleId: string; report: CinemaMandateReport };
      if (p.moduleId === 'cinema') reports.set(p.report.mandateId, p.report);
    }
  }
  const rows = [...issued.values()].map((mandate) => {
    const report = reports.get(mandate.mandateId);
    return report
      ? { mandate, status: 'resolved' as const, report }
      : { mandate, status: 'open' as const };
  });
  return openOnly ? rows.filter((r) => r.status === 'open') : rows;
}

export function completeCinemaMandate(
  store: Store,
  input: { projectId: string; conversationId: string; report: unknown },
): { ok: true } | { ok: false; reason: 'not-found' | 'already-resolved' } {
  const report = cinemaMandateReportSchema.parse(input.report);
  const rows = listCinemaMandates(store, input.conversationId);
  const row = rows.find((r) => r.mandate.mandateId === report.mandateId);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status === 'resolved') return { ok: false, reason: 'already-resolved' };
  store.appendEvent({
    id: newId(),
    ts: new Date().toISOString(),
    projectId: input.projectId,
    conversationId: input.conversationId,
    origin: 'agent',
    type: 'module.mandate.resolved',
    payload: { moduleId: 'cinema', report },
  } as UnsealedEvent);
  return { ok: true };
}
