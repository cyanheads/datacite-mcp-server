# datacite-mcp-server - Directory Structure

Generated on: 2026-09-26 22:48:47

```text
datacite-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _miss.ts
│   │           ├── _schemas.ts
│   │           ├── _text.ts
│   │           ├── get-citation.tool.ts
│   │           ├── get-work.tool.ts
│   │           ├── list-reference.tool.ts
│   │           ├── search-repositories.tool.ts
│   │           ├── search-works.tool.ts
│   │           └── trace-relations.tool.ts
│   ├── services/
│   │   ├── datacite/
│   │   │   ├── citation.ts
│   │   │   ├── cursor.ts
│   │   │   ├── datacite-service.ts
│   │   │   ├── html-text.ts
│   │   │   ├── mappers.ts
│   │   │   ├── normalize.ts
│   │   │   ├── query-builder.ts
│   │   │   ├── relation-graph.ts
│   │   │   └── types.ts
│   │   ├── doi-ra/
│   │   │   └── doi-ra-service.ts
│   │   ├── http/
│   │   │   ├── ttl-cache.ts
│   │   │   └── upstream-client.ts
│   │   └── reference/
│   │       ├── citation.ts
│   │       ├── fields-of-science.ts
│   │       ├── lookup.ts
│   │       ├── query-syntax.ts
│   │       ├── topics.ts
│   │       └── vocabularies.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── datacite/
│   │   │   ├── citations/
│   │   │   │   ├── canary-dryad-234-default.html
│   │   │   │   ├── canary-dryad-234-ieee-de-DE.html
│   │   │   │   ├── canary-dryad-234-mla.html
│   │   │   │   ├── dryad-8515-csl.json
│   │   │   │   ├── dryad-8515-default.html
│   │   │   │   ├── dryad-8515-ieee-de-DE.html
│   │   │   │   ├── dryad-8515-ieee.html
│   │   │   │   ├── dryad-8515-modern-language-association.html
│   │   │   │   └── zenodo-3509134-bibtex.bib
│   │   │   ├── errors/
│   │   │   │   ├── failed-to-parse-date.json
│   │   │   │   ├── negotiation-400-unrenderable.json
│   │   │   │   ├── negotiation-404.json
│   │   │   │   ├── negotiation-500-unrenderable.json
│   │   │   │   ├── parse-exception-query.json
│   │   │   │   ├── parse-exception-repositories.json
│   │   │   │   ├── token-mgr-error-query.json
│   │   │   │   ├── token-mgr-error-repositories.json
│   │   │   │   └── transient-500-claims-400.json
│   │   │   ├── graph/
│   │   │   │   ├── article-events.json
│   │   │   │   ├── article-reverse.json
│   │   │   │   ├── events-dryad-8515.json
│   │   │   │   ├── hydrate-dryad-234-gbif-hnhrg3.json
│   │   │   │   ├── hydrate-linking-copies.json
│   │   │   │   ├── reverse-ppat-1000446.json
│   │   │   │   └── root-dryad-8515.json
│   │   │   ├── repositories/
│   │   │   │   ├── filters-coretrustseal-dataverse.json
│   │   │   │   ├── fos-earth-sciences.json
│   │   │   │   ├── ids-ethz-wgms-dryad.json
│   │   │   │   └── query-glacier.json
│   │   │   └── works/
│   │   │       ├── cursor-first.json
│   │   │       ├── cursor-garbage-restart.json
│   │   │       ├── cursor-sort-ignored.json
│   │   │       ├── facets.json
│   │   │       ├── page-ceiling-clamped.json
│   │   │       ├── page-last-reachable.json
│   │   │       ├── record-dryad-234.json
│   │   │       └── search-glacier.json
│   │   └── doi-ra/
│   │       ├── crossref.json
│   │       ├── datacite.json
│   │       └── does-not-exist.json
│   ├── helpers/
│   │   ├── fixtures.ts
│   │   ├── harness.ts
│   │   ├── network-tripwire.test.ts
│   │   └── network-tripwire.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _miss.test.ts
│   │           ├── _schemas.test.ts
│   │           ├── _text.test.ts
│   │           ├── advertised-patterns.test.ts
│   │           ├── get-citation.tool.test.ts
│   │           ├── get-work.tool.test.ts
│   │           ├── input-bounds.test.ts
│   │           ├── list-reference.tool.test.ts
│   │           ├── search-repositories.tool.test.ts
│   │           ├── search-works.tool.test.ts
│   │           ├── trace-relations.tool.test.ts
│   │           └── upstream-errors.test.ts
│   ├── services/
│   │   ├── datacite/
│   │   │   ├── citation.test.ts
│   │   │   ├── cursor.test.ts
│   │   │   ├── datacite-service.test.ts
│   │   │   ├── html-text.test.ts
│   │   │   ├── mappers.test.ts
│   │   │   ├── normalize.test.ts
│   │   │   └── query-builder.test.ts
│   │   ├── doi-ra/
│   │   │   └── doi-ra-service.test.ts
│   │   ├── http/
│   │   │   ├── ttl-cache.test.ts
│   │   │   └── upstream-client.test.ts
│   │   └── reference/
│   │       └── query-syntax.test.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
