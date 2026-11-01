/**
 * @fileoverview Read-count schemas and disclosed clamps at upstream capacity.
 * @module mcp-server/tools/definitions/_counts
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { blankAsUnset } from './_schemas.js';

let clamps: ReturnType<typeof createCounter> | undefined;

/** DataCite's largest work and repository search page. */
export const SEARCH_PAGE_CAP = 1000;

/** A positive integer count, with an advertised maximum only in strict mode. */
export function countInput(cap: number, fallback: number) {
  return blankAsUnset(
    z.lazy(() => {
      let schema = z
        .number()
        .min(1)
        .multipleOf(1, 'Expected a whole number.')
        .refine(Number.isInteger, {
          message: 'Expected a whole number.',
          when: ({ issues }) => issues.length === 0,
        });
      if (!getServerConfig().clampLimits) schema = schema.max(cap);
      return schema.default(fallback);
    }),
  );
}

/** Apply a read cap; disclose each adjustment once in logs, metrics and notices. */
export function applyCount(
  requested: number,
  cap: number,
  field: 'limit' | 'max_nodes',
  tool: string,
  ctx: Context,
  notices: string[],
): number {
  const applied = Math.min(requested, cap);
  if (requested > applied) {
    const message = `Requested ${field}=${requested}; applied ${field}=${applied}.`;
    notices.push(message);
    ctx.log.notice(message, { tool, field, requested, applied });
    clamps ??= createCounter(
      'datacite.input.clamps',
      'Read counts reduced to upstream capacity',
      '{clamps}',
    );
    clamps.add(1, { tool, field });
  }
  return applied;
}
