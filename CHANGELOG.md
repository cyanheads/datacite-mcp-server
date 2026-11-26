# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-11-25

datacite_search_works gains a bbox filter with per-row inBbox, datacite_get_work gains sections to skip heavy record groups, and requests past DataCite's URL limit fail as request_too_long instead of a bare HTTP 414.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-11-15

Creator, funder, and place filters match inside one name or record, datacite_get_citation pages long documents, datacite_get_work filters relatedIdentifiers by relation type, and datacite_search_works adds version_scope and Crossref Funder ID child expansion.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-10-31

Scientific text decoding, larger search pages, and clearer country and JATS diagnostics.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-10-26 · ⚠️ Breaking

Complete geographic metadata and citation exports with literal description rendering and research-output guidance.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-10-18

Normalize deposited metadata and continue capped DataCite reads.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-10-09

Moves to @cyanheads/mcp-ts-core 0.13.14 from 0.13.8: tool error results carry a request id, \"true\"/\"false\" for a boolean argument and null at an optional one are repaired, the server.json HTTP entry starts the HTTP transport, the Docker image drops musl bindings, and the public hosted endpoint is listed in server.json and the README.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-26

First published release: six read-only DataCite tools for work search, DOI records, relation tracing, repository search, citations, and vocabulary lookup, keyless over stdio or Streamable HTTP.
