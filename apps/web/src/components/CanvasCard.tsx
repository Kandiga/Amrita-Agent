import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import type { CardLayout } from '../canvas-layout.ts';
import { textDir } from '../lib.ts';

/**
 * One draggable / resizable / minimizable card on the free canvas (Live Canvas
 * Phase 1). Drag from the title bar, resize from the bottom-right handle. During
 * a gesture the movement is a local CSS transform (smooth, no parent re-render);
 * only the FINAL position/size is committed to the layout on pointer-up.
 *
 * Selecting a card (pointer-down anywhere) raises it and marks it the focus, so
 * the next chat instruction is about THIS build (Phase 3).
 */

interface Props {
  card: CardLayout;
  title: string;
  kindLabel: string;
  selected: boolean;
  building?: boolean;
  children: ReactNode;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onToggleMin: () => void;
}

type Gesture =
  | { mode: 'move'; px: number; py: number; ox: number; oy: number }
  | { mode: 'resize'; px: number; py: number; ow: number; oh: number };

export function CanvasCard({
  card,
  title,
  kindLabel,
  selected,
  building,
  children,
  onSelect,
  onMove,
  onResize,
  onToggleMin,
}: Props) {
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<{ dx: number; dy: number; dw: number; dh: number } | null>(null);

  function startMove(e: ReactPointerEvent): void {
    if (e.button !== 0) return;
    onSelect();
    gesture.current = { mode: 'move', px: e.clientX, py: e.clientY, ox: card.x, oy: card.y };
    setLive({ dx: 0, dy: 0, dw: 0, dh: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function startResize(e: ReactPointerEvent): void {
    if (e.button !== 0) return;
    onSelect();
    gesture.current = { mode: 'resize', px: e.clientX, py: e.clientY, ow: card.w, oh: card.h };
    setLive({ dx: 0, dy: 0, dw: 0, dh: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e: ReactPointerEvent): void {
    const g = gesture.current;
    if (!g) return;
    const dxp = e.clientX - g.px;
    const dyp = e.clientY - g.py;
    if (g.mode === 'move') setLive({ dx: dxp, dy: dyp, dw: 0, dh: 0 });
    else setLive({ dx: 0, dy: 0, dw: dxp, dh: dyp });
  }

  function endGesture(e: ReactPointerEvent): void {
    const g = gesture.current;
    const l = live;
    gesture.current = null;
    setLive(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (!g || !l) return;
    if (g.mode === 'move') onMove(g.ox + l.dx, g.oy + l.dy);
    else onResize(g.ow + l.dw, g.oh + l.dh);
  }

  // Live geometry: base + in-flight gesture delta.
  const x = card.x + (live?.dx ?? 0);
  const y = card.y + (live?.dy ?? 0);
  const w = Math.max(240, card.w + (live?.dw ?? 0));
  const h = card.minimized ? 0 : Math.max(160, card.h + (live?.dh ?? 0));

  return (
    <div
      className={`canvas-card${selected ? ' selected' : ''}${card.minimized ? ' minimized' : ''}`}
      style={{ left: x, top: y, width: w, zIndex: card.z }}
      onPointerDown={onSelect}
    >
      <header
        className="canvas-card-bar"
        onPointerDown={startMove}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <span className="canvas-card-kind">{building ? 'building…' : kindLabel}</span>
        <strong className="canvas-card-title" dir={textDir(title)}>
          {title}
        </strong>
        <div className="canvas-card-actions">
          <button
            type="button"
            aria-label={card.minimized ? 'Expand' : 'Minimize'}
            title={card.minimized ? 'Expand' : 'Minimize'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onToggleMin}
          >
            {card.minimized ? '▢' : '—'}
          </button>
        </div>
      </header>
      {!card.minimized && (
        <>
          <div className="canvas-card-body" style={{ height: h }}>
            {children}
          </div>
          <div
            className="canvas-card-resize"
            aria-label="Resize"
            onPointerDown={startResize}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        </>
      )}
    </div>
  );
}
