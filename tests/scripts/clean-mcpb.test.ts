/**
 * @fileoverview Bundle cleanup retains executable skill modules and removes package-root agent documentation.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('bundle agent-document boundaries', () => {
  const docs = [
    'node_modules/pkg/skills/guide/SKILL.md',
    'node_modules/@scope/pkg/framework-skills/build/SKILL.md',
    'node_modules/pkg/.claude/settings.json',
    'node_modules/pkg/.agents/skills/guide/SKILL.md',
    'node_modules/pkg/SKILL.md',
    'node_modules/@scope/outer/node_modules/@inner/pkg/skills/guide/SKILL.md',
  ];
  it('removes dependency agent documentation', () => {
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    expect(docs.filter((path) => AGENT_DOC_ENTRY.test(path))).toEqual(docs);
  });
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/pkg/src/skills/loader.js',
    'skills/datacite-guide/SKILL.md',
  ])('retains runtime or published entry %s', (path) => {
    expect(filterAgentDocEntries([path])).toEqual([]);
    expect(AGENT_DOC_ENTRY.test(path)).toBe(false);
  });
});
