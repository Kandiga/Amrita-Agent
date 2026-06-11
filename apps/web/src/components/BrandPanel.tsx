import { useState } from 'react';
import type { BrandLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface BrandPanelProps {
  brand: BrandLite | null;
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

function parseLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Per-project brand memory (ADR-0020): what Amrita remembers about this
 * project's identity and reuses in previews and lane handoffs. Honest empty
 * state — no brand row means neutral previews that say so.
 */
export function BrandPanel({ brand, writeCtx, onChanged, onError }: BrandPanelProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('');
  const [palette, setPalette] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [typography, setTypography] = useState('');
  const [doNotUse, setDoNotUse] = useState('');

  function startEdit(): void {
    setName(brand?.name ?? '');
    setAudience(brand?.audience ?? '');
    setTone(brand?.tone ?? '');
    setPalette((brand?.palette ?? []).join('\n'));
    setStyleNotes((brand?.styleNotes ?? []).join('\n'));
    setTypography(brand?.typography ?? '');
    setDoNotUse((brand?.doNotUse ?? []).join('\n'));
    setEditing(true);
  }

  const hasContent = () =>
    Boolean(
      name.trim() ||
        audience.trim() ||
        tone.trim() ||
        typography.trim() ||
        parseLines(palette).length ||
        parseLines(styleNotes).length ||
        parseLines(doNotUse).length,
    );

  async function save(): Promise<void> {
    if (!writeCtx || !hasContent()) return;
    try {
      await client.brandUpdate({
        ...writeCtx,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        ...(typography.trim() ? { typography: typography.trim() } : {}),
        palette: parseLines(palette),
        styleNotes: parseLines(styleNotes),
        doNotUse: parseLines(doNotUse),
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>Brand</h2>
      {editing ? (
        <form
          className="brief-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            dir={textDir(name)}
            placeholder="Product/brand name"
          />
          <input
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            dir={textDir(audience)}
            placeholder="Audience (optional)"
          />
          <input
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            dir={textDir(tone)}
            placeholder="Tone — e.g. premium, calm"
          />
          <textarea
            value={palette}
            onChange={(e) => setPalette(e.target.value)}
            dir={textDir(palette)}
            placeholder={'Palette notes — one per line, e.g. #0EA5E9 cyan accents'}
            rows={2}
          />
          <textarea
            value={styleNotes}
            onChange={(e) => setStyleNotes(e.target.value)}
            dir={textDir(styleNotes)}
            placeholder={'Style notes — one per line'}
            rows={2}
          />
          <input
            value={typography}
            onChange={(e) => setTypography(e.target.value)}
            dir={textDir(typography)}
            placeholder="Typography preference (optional)"
          />
          <textarea
            value={doNotUse}
            onChange={(e) => setDoNotUse(e.target.value)}
            dir={textDir(doNotUse)}
            placeholder={'Do not use — one per line, e.g. no neon gradients'}
            rows={2}
          />
          <div className="brief-actions">
            <button type="submit" disabled={!hasContent()}>
              Save brand
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : brand ? (
        <div className="brief-view">
          {brand.name ? (
            <p className="brief-goal" dir={textDir(brand.name)}>
              {brand.name}
            </p>
          ) : null}
          {brand.tone ? <small dir={textDir(brand.tone)}>{brand.tone}</small> : null}
          {brand.audience ? <small>for {brand.audience}</small> : null}
          {brand.palette.length > 0 ? (
            <p className="brief-scope">
              <strong>Palette:</strong> {brand.palette.join(' · ')}
            </p>
          ) : null}
          {brand.styleNotes.length > 0 ? (
            <p className="brief-scope">
              <strong>Style:</strong> {brand.styleNotes.join(' · ')}
            </p>
          ) : null}
          {brand.typography ? (
            <p className="brief-scope">
              <strong>Type:</strong> {brand.typography}
            </p>
          ) : null}
          {brand.doNotUse.length > 0 ? (
            <p className="brief-scope">
              <strong>Never:</strong> {brand.doNotUse.join(' · ')}
            </p>
          ) : null}
          <button type="button" onClick={startEdit}>
            Edit brand
          </button>
        </div>
      ) : (
        <div className="brief-view">
          <p className="empty-note">
            No brand memory yet. Tell Amrita this project's identity — name, tone, palette — and
            previews and coding handoffs will use it consistently.
          </p>
          <button type="button" onClick={startEdit} disabled={!writeCtx}>
            Set the brand
          </button>
        </div>
      )}
    </section>
  );
}
