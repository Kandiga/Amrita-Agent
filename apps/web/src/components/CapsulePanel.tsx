import type { CapsuleItem, ConclusionCapsuleLite } from '../api.ts';
import { textDir } from '../lib.ts';

/**
 * The Conclusion Capsule as a compact Amrita card in the chat column (ADR-0048
 * §11). It is Amrita showing what she concluded — Progress / Decisions / Risks /
 * Conflicts / Validation / Next Actions — instead of a wall of code and logs.
 * DERIVED and read-only: it is never a message and never persisted; each item
 * carries provenance refs (event/lane/task ids) as its clickable evidence.
 */

const SECTIONS: {
  key: keyof Pick<
    ConclusionCapsuleLite,
    'progress' | 'decisions' | 'risks' | 'conflicts' | 'validation' | 'nextActions'
  >;
  label: string;
  tone: string;
}[] = [
  { key: 'nextActions', label: 'Next', tone: 'next' },
  { key: 'conflicts', label: 'Conflicts', tone: 'conflict' },
  { key: 'risks', label: 'Risks', tone: 'risk' },
  { key: 'validation', label: 'Validation', tone: 'ok' },
  { key: 'progress', label: 'Progress', tone: 'progress' },
  { key: 'decisions', label: 'Decisions', tone: 'decision' },
];

const STATUS_LABEL: Record<ConclusionCapsuleLite['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  aborted: 'Aborted',
};

function Item({ item }: { item: CapsuleItem }) {
  return (
    <li className="capsule-item">
      <span dir={textDir(item.text)}>{item.text}</span>
      {item.provenance.length > 0 ? (
        <span
          className="capsule-prov"
          title={item.provenance.map((p) => `${p.kind}:${p.ref}`).join(', ')}
        >
          {item.provenance.map((p) => p.kind).join(' · ')}
        </span>
      ) : null}
    </li>
  );
}

export function CapsulePanel({ capsule }: { capsule: ConclusionCapsuleLite }) {
  const shown = SECTIONS.filter((s) => capsule[s.key].length > 0);
  return (
    <section className="capsule-card" aria-label="Conclusion capsule">
      <header className="capsule-head">
        <span className="capsule-title">Amrita's conclusion</span>
        <span className={`capsule-status capsule-status-${capsule.status}`}>
          {STATUS_LABEL[capsule.status]}
        </span>
      </header>
      {shown.map((s) => (
        <div key={s.key} className={`capsule-section capsule-${s.tone}`}>
          <h4>{s.label}</h4>
          <ul>
            {capsule[s.key].map((item, i) => (
              <Item key={`${s.key}-${i}`} item={item} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
