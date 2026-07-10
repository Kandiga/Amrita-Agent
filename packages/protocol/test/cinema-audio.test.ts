import { describe, expect, it } from 'vitest';
import {
  type AudioCue,
  type AudioCuePlan,
  DEFAULT_CANDIDATE_COUNT_BY_KIND,
  audioCandidateSchema,
  audioCuePlanSchema,
  audioGenerationJobSchema,
  generationReceiptSchema,
  timelineOperationSchema,
  timelinePatchSchema,
  videoAnalysisRecordSchema,
} from '../src/index.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const ISO = '2026-07-10T20:00:00.000Z';
const evidence = {
  id: 'ev_cut_1',
  sourceHash: A,
  startSec: 1.25,
  endSec: 1.5,
  modality: 'video',
  analyzerVersion: 'ffmpeg-7.1',
  claimClass: 'MEASURED',
};

function analysisFixture() {
  return {
    id: 'analysis_1',
    projectId: 'vp_1',
    sourceAssetId: 'asset_source_1',
    sourceHash: A,
    sourceDurationSec: 12.5,
    timebase: 'seconds',
    analyzerVersion: 'amrita-analysis-1',
    createdAt: ISO,
    scenes: [{ id: 'scene_1', startSec: 0, endSec: 12.5, evidenceRefs: ['ev_cut_1'] }],
    cuts: [1.25],
    speech: [],
    textSpans: [],
    events: [
      { id: 'event_1', label: 'hard cut', startSec: 1.25, endSec: 1.5, evidenceRefs: ['ev_cut_1'] },
    ],
    moodArc: [],
    tempoHints: [],
    dialogueRanges: [],
    unknowns: [],
    warnings: [],
    evidenceIndex: { ev_cut_1: evidence },
    contentHash: B,
  };
}

function planFixture(cueOverrides: Partial<AudioCue> = {}): AudioCuePlan {
  return {
    id: 'plan_1',
    projectId: 'vp_1',
    projectVersion: 7,
    sourceHash: A,
    analysisHash: B,
    mode: 'plan',
    requestText: 'Add one impact at the cut.',
    resolvedRange: { startSec: 1, endSec: 2 },
    cues: [
      {
        cueId: 'cue_1',
        kind: 'sfx',
        startSec: 1.25,
        endSec: 1.75,
        anchorSec: 1.25,
        intent: 'support the hard cut',
        prompt: 'short cinematic impact, no voice',
        negativePrompt: 'speech, melody',
        evidenceRefs: ['ev_cut_1'],
        dialoguePolicy: 'duck',
        fadeInSec: 0,
        fadeOutSec: 0.08,
        targetLufs: -20,
        providerConstraints: ['elevenlabs-sfx'],
        candidateCount: 1,
        confidence: 0.9,
        warnings: [],
        requiresReview: false,
        ...cueOverrides,
      },
    ],
    critic: { pass: true, issues: [] },
    costEstimate: {
      currency: 'USD',
      estimatedAmount: 0.02,
      maxApprovedAmount: 0.05,
      providerIds: ['elevenlabs-sfx'],
      candidateCount: 1,
    },
    privacyRoute: {
      mode: 'standard',
      egress: 'range_proxy',
      providers: ['elevenlabs-sfx'],
      consentId: 'consent_1',
      sentRanges: [{ startSec: 1, endSec: 2 }],
    },
    status: 'approved',
    approvalHash: C,
  };
}

describe('Cinema video-grounded audio contracts', () => {
  it('accepts seconds-based analysis and rejects invalid evidence', () => {
    expect(videoAnalysisRecordSchema.parse(analysisFixture()).timebase).toBe('seconds');
    expect(() =>
      videoAnalysisRecordSchema.parse({ ...analysisFixture(), timebase: 'frames' }),
    ).toThrow();
    const badRange = analysisFixture();
    badRange.evidenceIndex.ev_cut_1 = { ...evidence, startSec: 2, endSec: 1 };
    expect(() => videoAnalysisRecordSchema.parse(badRange)).toThrow();
  });

  it('requires evidence index keys and every nested ref to resolve', () => {
    expect(() =>
      videoAnalysisRecordSchema.parse({
        ...analysisFixture(),
        evidenceIndex: { wrong_key: evidence },
      }),
    ).toThrow();
    expect(() =>
      videoAnalysisRecordSchema.parse({
        ...analysisFixture(),
        moodArc: [{ atSec: 1.3, valence: 0, arousal: 0.8, evidenceRefs: ['missing_ref'] }],
      }),
    ).toThrow();
  });

  it('keeps cue evidence, critic, count, and providers inside the approval envelope', () => {
    expect(audioCuePlanSchema.parse(planFixture()).status).toBe('approved');
    const noEvidence = planFixture({ evidenceRefs: [] });
    expect(() => audioCuePlanSchema.parse(noEvidence)).toThrow();
    const p0 = planFixture();
    p0.critic = {
      pass: false,
      issues: [{ severity: 'P0', code: 'unsupported', detail: 'no evidence' }],
    };
    expect(() => audioCuePlanSchema.parse(p0)).toThrow();
    const tooMany = planFixture({ candidateCount: 2 });
    expect(() => audioCuePlanSchema.parse(tooMany)).toThrow();
    const wrongProvider = planFixture({ providerConstraints: ['fal-mmaudio-v2'] });
    expect(() => audioCuePlanSchema.parse(wrongProvider)).toThrow();
  });

  it('requires provider handles for submitted jobs and lineage for succeeded jobs', () => {
    const job = {
      id: 'job_1',
      idempotencyKey: C,
      projectId: 'vp_1',
      planId: 'plan_1',
      cueId: 'cue_1',
      candidateIndex: 0,
      provider: 'elevenlabs-sfx',
      model: 'sound-generation',
      adapterVersion: '1.0.0',
      inputHash: B,
      estimate: { amount: 0.02, currency: 'USD' },
      attempts: [],
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(audioGenerationJobSchema.parse({ ...job, status: 'cancel_requested' }).status).toBe(
      'cancel_requested',
    );
    expect(() => audioGenerationJobSchema.parse({ ...job, status: 'submitted' })).toThrow();
    expect(
      audioGenerationJobSchema.parse({ ...job, status: 'submitted', providerRequestId: 'req_1' })
        .status,
    ).toBe('submitted');
    expect(() => audioGenerationJobSchema.parse({ ...job, status: 'succeeded' })).toThrow();
    expect(
      audioGenerationJobSchema.parse({
        ...job,
        status: 'succeeded',
        outputAssetId: 'asset_1',
        receiptId: 'receipt_1',
      }).status,
    ).toBe('succeeded');
  });

  it('binds candidates and receipts to rights, cost, and checksums', () => {
    expect(
      audioCandidateSchema.parse({
        id: 'candidate_1',
        jobId: 'job_1',
        projectId: 'vp_1',
        planId: 'plan_1',
        cueId: 'cue_1',
        assetId: 'asset_sfx_1',
        sourceHash: A,
        sourceRange: { startSec: 1, endSec: 2 },
        provider: 'elevenlabs-sfx',
        model: 'sound-generation',
        adapterVersion: '1.0.0',
        promptHash: B,
        parametersHash: C,
        licenseSnapshotId: 'license_1',
        retentionSnapshotId: 'retention_1',
        cost: { amount: 0.02, currency: 'USD' },
        checksum: C,
        approvalState: 'pending',
        createdAt: ISO,
      }).approvalState,
    ).toBe('pending');
    const receipt = generationReceiptSchema.parse({
      id: 'receipt_1',
      jobId: 'job_1',
      sourceHash: A,
      sourceRange: { startSec: 1, endSec: 2 },
      analysisHash: B,
      planHash: C,
      promptHash: B,
      provider: 'elevenlabs-sfx',
      model: 'sound-generation',
      adapterVersion: '1.0.0',
      compiledPromptRedacted: 'impact',
      negativePromptRedacted: 'speech',
      parametersHash: C,
      candidateIndex: 0,
      estimate: { amount: 0.02, currency: 'USD' },
      termsSnapshotId: 'terms_1',
      licenseSnapshotId: 'license_1',
      retentionSnapshotId: 'retention_1',
      consentId: 'consent_1',
      approvalHash: C,
      outputHash: C,
      retentionOutcome: 'retained_first_party',
      createdAt: ISO,
    });
    expect(receipt.outputHash).toBe(C);
    expect(() => generationReceiptSchema.parse({ ...receipt, forbiddenExtra: true })).toThrow();
  });

  it('requires reversible, version/hash-checked timeline patches', () => {
    const patch = timelinePatchSchema.parse({
      id: 'patch_1',
      projectId: 'vp_1',
      precondition: { projectVersion: 7, sourceHash: A, analysisHash: B },
      operations: [
        {
          op: 'addClip',
          assetId: 'asset_sfx_1',
          trackId: 'track_sfx',
          startSec: 1.25,
          durationSec: 0.5,
        },
      ],
      inverseOperations: [{ op: 'removeClip', targetId: 'clip_sfx_1' }],
      assetIds: ['asset_sfx_1'],
      planId: 'plan_1',
      idempotencyKey: C,
      status: 'staged',
    });
    expect(patch.inverseOperations).toHaveLength(1);
    expect(() => timelinePatchSchema.parse({ ...patch, inverseOperations: [] })).toThrow();
  });

  it('bounds timeline operation payloads: size-capped and no smuggled media bytes', () => {
    const op = { op: 'setGain', targetId: 'clip_1', value: -6 };
    expect(timelineOperationSchema.parse({ ...op, payload: { note: 'small metadata' } }).op).toBe(
      'setGain',
    );
    expect(() =>
      timelineOperationSchema.parse({ ...op, payload: { blob: 'x'.repeat(40_000) } }),
    ).toThrow();
    expect(() =>
      timelineOperationSchema.parse({
        ...op,
        payload: { poster: 'data:image/png;base64,AAAA' },
      }),
    ).toThrow();
  });

  it('caps the evidence index and pins conservative candidate-count defaults', () => {
    expect(DEFAULT_CANDIDATE_COUNT_BY_KIND).toEqual({ music: 2, sfx: 1, ambience: 1, foley: 1 });
    const record = analysisFixture();
    const bloated: Record<string, typeof evidence> = {};
    for (let i = 0; i < 100_001; i += 1) {
      bloated[`ev_${i}`] = { ...evidence, id: `ev_${i}` };
    }
    bloated.ev_cut_1 = evidence;
    expect(() => videoAnalysisRecordSchema.parse({ ...record, evidenceIndex: bloated })).toThrow();
  });
});
