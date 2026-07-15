import { useEffect, useRef, useState } from 'react';
import {
  type CanvasLayout,
  loadLayout,
  raise,
  reconcile,
  saveLayout,
  setPosition,
  setSize,
  toggleMinimized,
} from '../canvas-layout.ts';
import { CanvasCard } from './CanvasCard.tsx';
import { CanvasFrame } from './CanvasFrame.tsx';

/**
 * The free canvas (Live Canvas Phase 1): every openable build is a card the
 * operator can drag, resize, minimize and stack. Layout is VIEW state — persisted
 * to localStorage per conversation, never to the event store. On mobile the CSS
 * collapses the absolute positioning to a readable vertical stack (Phase 5).
 */

export interface FreeCanvasArtifact {
  id: string;
  title: string;
  kindLabel: string;
  html: string;
  /** True while the artifact is still streaming in (Phase 2). */
  building?: boolean;
}

interface Props {
  conversationId: string;
  artifacts: FreeCanvasArtifact[];
  selectedId: string | null;
  onSelect: (id: string, title: string) => void;
}

export function FreeCanvas({ conversationId, artifacts, selectedId, onSelect }: Props) {
  const [layout, setLayout] = useState<CanvasLayout>(() => loadLayout(conversationId));

  // Reload the saved layout when the conversation changes.
  const convRef = useRef(conversationId);
  useEffect(() => {
    if (convRef.current !== conversationId) {
      convRef.current = conversationId;
      setLayout(loadLayout(conversationId));
    }
  }, [conversationId]);

  // Reconcile ONLY when the set of artifact ids changes (new build, or one gone) —
  // never on a move/resize, so a drag is never undone by a re-render.
  const idKey = artifacts.map((a) => a.id).join('|');
  useEffect(() => {
    setLayout((prev) => reconcile(prev, idKey ? idKey.split('|') : []));
  }, [idKey]);

  // Persist whenever the layout changes.
  useEffect(() => {
    saveLayout(conversationId, layout);
  }, [conversationId, layout]);

  const update = (next: CanvasLayout) => setLayout(next);

  return (
    <div className="free-canvas">
      {artifacts.map((a) => {
        const card = layout[a.id];
        if (!card) return null; // placed on the next reconcile tick
        return (
          <CanvasCard
            key={a.id}
            card={card}
            title={a.title}
            kindLabel={a.kindLabel}
            building={a.building ?? false}
            selected={selectedId === a.id}
            onSelect={() => {
              setLayout((l) => raise(l, a.id));
              onSelect(a.id, a.title);
            }}
            onMove={(x, y) => update(setPosition(layout, a.id, x, y))}
            onResize={(w, h) => update(setSize(layout, a.id, w, h))}
            onToggleMin={() => update(toggleMinimized(layout, a.id))}
          >
            <CanvasFrame html={a.html} title={a.title} />
          </CanvasCard>
        );
      })}
    </div>
  );
}
