import { describe, expect, it } from 'vitest';
import { classifyIntent, looksLikeBuildIntent } from '../src/execution-route.ts';

/**
 * The chat-message intent classifier (ADR-0048) — the chat-side sibling of
 * `routeFor`. Pure and deterministic; conservative by design so a false negative
 * (just answer in chat) is safe and a false `build` never spins up a session.
 */
describe('classifyIntent — what a chat message is asking for (ADR-0048)', () => {
  it('ordinary conversation is not a delegation request', () => {
    expect(classifyIntent('what is our current pricing?').intent).toBe('conversational');
    expect(classifyIntent('thanks, that helps').intent).toBe('conversational');
    expect(classifyIntent('can you review my plan?').intent).toBe('conversational'); // not build/research
  });

  it('build work is a build intent', () => {
    expect(classifyIntent('build me a login page').intent).toBe('build');
    expect(classifyIntent('implement the checkout endpoint').intent).toBe('build');
    expect(classifyIntent('refactor the payment module').intent).toBe('build');
    expect(classifyIntent('fix the failing test').intent).toBe('build');
  });

  it('research/QA work is a research intent (the Codex sweet spot)', () => {
    expect(classifyIntent('investigate why the build is slow').intent).toBe('research');
    expect(classifyIntent('reproduce the crash from issue 12').intent).toBe('research');
    expect(classifyIntent('benchmark the two approaches').intent).toBe('research');
  });

  it('a missing connector beats everything and stays honest', () => {
    const v = classifyIntent('send an email to the vendor');
    expect(v.intent).toBe('needs-connector');
    expect(v.missing?.what).toMatch(/email/i);
    expect(v.missing?.fix).toBeTruthy();
  });

  it('work a machine must not quietly do is human', () => {
    expect(classifyIntent('call the caterer and negotiate the price').intent).toBe('human');
  });

  it('the cheap gate fires only for delegatable build/research', () => {
    expect(looksLikeBuildIntent('build me a login page')).toBe(true);
    expect(looksLikeBuildIntent('investigate the slow query')).toBe(true);
    expect(looksLikeBuildIntent('what did we decide?')).toBe(false);
    expect(looksLikeBuildIntent('send an email to the vendor')).toBe(false); // honest, not delegated
    expect(looksLikeBuildIntent('call the caterer')).toBe(false);
  });

  // Hebrew is the operator's first language. Every phrase below is a REAL request
  // from the live event log that the English-only tables classified
  // `conversational` — the Planner never fired and no session ever opened.
  it('Hebrew build requests are build intents (the live-log regression)', () => {
    expect(classifyIntent('תבני לי משחק Prism Snake').intent).toBe('build');
    expect(classifyIntent('תבני לי משחק נחש ניאון').intent).toBe('build');
    expect(classifyIntent('אני רוצה שתצרי משחק סנייק ברמה גבוהה ומקורית').intent).toBe('build');
    expect(classifyIntent('תוסיפי עוד אפשרויות לתפריט').intent).toBe('build');
    expect(classifyIntent('תבנה לי אתר עם דף נחיתה').intent).toBe('build');
    expect(classifyIntent('יש באג בקוד של הטופס').intent).toBe('build');
  });

  it('Hebrew with attached prefixes (ו/ש) still matches the bare verb', () => {
    expect(classifyIntent('חשבתי ושתבני לי דשבורד').intent).toBe('build');
    expect(classifyIntent('הרעיון הוא שתצרי אפליקציה קטנה').intent).toBe('build');
  });

  it('Hebrew research requests are research intents', () => {
    expect(classifyIntent('תחקרי למה הבנייה איטית').intent).toBe('research');
    expect(classifyIntent('תבדקי למה זה קורס').intent).toBe('research');
  });

  it('Hebrew conversation stays conversational', () => {
    expect(classifyIntent('מה שלומך היום?').intent).toBe('conversational');
    expect(classifyIntent('תודה, זה עזר לי מאוד').intent).toBe('conversational');
    expect(classifyIntent('מה החלטנו לגבי המחיר?').intent).toBe('conversational');
  });

  it('Hebrew human-only and connector work stays honest', () => {
    expect(classifyIntent('תתקשרי לספק בבקשה').intent).toBe('human');
    expect(classifyIntent('שלחי מייל ללקוח').intent).toBe('needs-connector');
  });

  it('English word-boundary protection is unchanged by the Unicode matcher', () => {
    expect(classifyIntent('the payment flow is great, thanks').intent).toBe('conversational'); // 'pay' must not fire
    expect(classifyIntent('i love this design direction').intent).toBe('conversational'); // 'sign' must not fire
  });
});
