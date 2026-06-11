export * from './types.ts';
export * from './web.ts';
export * from './telegram.ts';
export * from './telegram-runner.ts';

/** The static catalog of channel surfaces Amrita knows about. */
export const CHANNELS: readonly { id: string; kind: 'web' | 'telegram' }[] = [
  { id: 'web', kind: 'web' },
  { id: 'telegram', kind: 'telegram' },
];
