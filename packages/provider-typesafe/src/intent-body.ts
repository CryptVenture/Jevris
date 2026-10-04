/**
 * Reading the optional new-task fields of an event body (`task.templates`, `task.unknowns`) into the
 * shapes the core decisions take. No adapter supplies either today; a caller that holds installed
 * workflow templates or explicit unknowns can. Everything is bounded, and a template is trusted only
 * when it says so and is installed.
 */
import type { ExplicitUnknown, TemplateMeta } from '@jevris/core';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string clipped to `max`, or null. */
export function clippedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : null;
}

/** At most `maxItems` non-empty strings, each clipped to `max`. */
export function clippedTexts(value: unknown, maxItems: number, max: number): string[] {
  return Array.isArray(value) ? value.slice(0, maxItems).map((v) => clippedText(v, max)).filter((v): v is string => v !== null) : [];
}

/** At most `maxItems` plain objects. */
export function plainList(value: unknown, maxItems: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, maxItems).filter(isPlainRecord) : [];
}

export function templatesOf(value: unknown): TemplateMeta[] {
  return plainList(value, 64).flatMap((t) => {
    const id = clippedText(t['id'], 128);
    const family = clippedText(t['family'], 64);
    const summary = clippedText(t['summary'], 300);
    if (id === null || family === null || summary === null) return [];
    return [{ id, family, summary, tags: clippedTexts(t['tags'], 16, 64), trusted: t['trusted'] === true, source: t['source'] === 'installed' ? 'installed' : 'external' } as TemplateMeta];
  });
}

export function unknownsOf(value: unknown): ExplicitUnknown[] {
  return plainList(value, 12).flatMap((u) => {
    const id = clippedText(u['id'], 64);
    const topic = clippedText(u['topic'], 300);
    const consequence = clippedText(u['consequence'], 300);
    return id === null || topic === null || consequence === null ? [] : [{ id, topic, consequence, options: clippedTexts(u['options'], 8, 120) }];
  });
}
