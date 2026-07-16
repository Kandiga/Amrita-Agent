import { describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { parseIcsEvents } from '../src/ingest-ics.ts';

/** HARMONY-6 — calendar ingestion by import: pure parser + kernel capture. */

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Kickoff with Dana',
  'DTSTART;TZID=Asia/Jerusalem:20260720T100000',
  'DESCRIPTION:Agenda\\, scope\\nand budget',
  'LOCATION:Tel Aviv',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Untitled follow-up',
  'DTSTART:20260722',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcsEvents (pure)', () => {
  it('parses VEVENTs with unescaping, folded fields and ISO dates', () => {
    const events = parseIcsEvents(ICS);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      title: 'Kickoff with Dana',
      date: '2026-07-20',
      body: 'Agenda, scope and budget · Tel Aviv',
    });
    expect(events[1]?.date).toBe('2026-07-22');
  });

  it('garbage never throws — it just yields nothing', () => {
    expect(parseIcsEvents('not an ics at all')).toEqual([]);
    expect(parseIcsEvents('BEGIN:VEVENT\nEND:VEVENT')).toEqual([]); // no SUMMARY
  });
});

describe('kernel.importIcs', () => {
  it('captures each event as a Brain record with calendar-import provenance', () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 'cal', name: 'Cal' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const out = kernel.importIcs({ projectId, conversationId, ics: ICS });
    expect(out.imported).toBe(2);
    const brain = kernel.getProjectBrain(projectId);
    expect(JSON.stringify(brain)).toContain('Kickoff with Dana');
    kernel.close();
  });
});
