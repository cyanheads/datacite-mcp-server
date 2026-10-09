<div align="center">
  <h1>@cyanheads/datacite-mcp-server</h1>
  <p><b>Search DataCite datasets and software, fetch DOI metadata, trace relations, format citations via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/datacite-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/datacite-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/datacite-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/datacite-mcp-server/releases/latest/download/datacite-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=datacite-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZGF0YWNpdGUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22datacite-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fdatacite-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://datacite.caseyjhand.com/mcp](https://datacite.caseyjhand.com/mcp)

</div>

---

## Overview

DOI metadata from DataCite for datasets, software, samples, workflows, and other research outputs that repositories deposit worldwide. Search it, open a record in full, trace a DOI's relations (versions, parts, supplements, citations), find the repositories that publish in a field, and format citations. Runs without an API key, as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `datacite_search_works` | Search works by plain text or query syntax plus structured filters, in ranked pages or a full cursor walk, with optional facet counts |
| `datacite_get_work` | Fetch the full deposited metadata for one DOI, or learn which registration agency holds a DOI DataCite doesn't |
| `datacite_trace_relations` | Map the relation graph around any DOI — versions, parts, supplements, derivations, citations — with each edge's source |
| `datacite_search_repositories` | Find repository accounts by text, field of science, type, certificate, software, or provider, and get the `repositoryId` work search filters on |
| `datacite_get_citation` | Render a DOI as a formatted citation in a CSL style and locale, or as BibTeX, RIS, CSL JSON, and other machine formats |
| `datacite_list_reference` | Look up the vocabularies, identifier forms, and coverage rules the other tools accept, offline |

## Capability reference

### `datacite_search_works` <sub>tool</sub>

- `text` (plain words, every reserved character escaped) or `query` (OpenSearch query syntax), ANDed with filters: `resource_types`, `creator` (ORCID iD or name), `affiliation` (ROR ID or name), `affiliation_country`, `funder` (ROR ID, Crossref Funder ID, or name; `include_child_funders` with a ROR funder), `subject`, `fields_of_science`, `repository_ids`, `provider_ids`, `licenses`, `language`, `place`, `published_from` / `published_to`, and `min_citations`; list filters take up to 10 values, any of which match
- `limit` 1–100 (default 20); ranked `page`s reach the first 10,000 matches under `sort` (`relevance`, `newest`, `oldest`, `recently_updated`, `most_cited`, `most_viewed`, `most_downloaded`; default `relevance` with `text` or `query`, else `newest`), while `cursor: "*"` walks the whole result set in registration order through `nextCursor` and takes neither `page` nor `sort`
- `include_facets` adds top counts for resource types, years, repositories, providers, affiliations, fields of science, and licenses (2–8 s slower); every response reports `totalCount`, `effectiveQuery`, `sortApplied`, and `appliedFilters`

---

### `datacite_get_work` <sub>tool</sub>

- One `doi`, in any case: bare, with a `doi:` or `info:doi/` prefix, as a doi.org URL, or `%2F`-encoded
- Titles, creators and contributors with ORCID iDs and ROR affiliations, dates, subjects, descriptions, funding, geolocations, rights, related identifiers and items, repository and provider, and `counts` (citations, references, versions, parts, views, downloads); long lists are capped and their full sizes reported in `truncatedLists` and `relatedIdentifierCounts`
- A DOI DataCite holds no public record for returns `found: false` with `missReason` (`other_agency`, `does_not_exist`, `not_public`, `unclassified`), the `registrationAgency` when known, and `guidance`

---

### `datacite_trace_relations` <sub>tool</sub>

- Any agency's `doi`: a DataCite dataset or software DOI, or a journal article's DOI to find the DataCite data and software it cites or that cite, supplement, or derive from it
- `depth` 1 (default) or 2 — the second hop expands at most 10 DataCite neighbours and runs only when the first hop leaves `max_nodes` room; `max_nodes` 1–100 (default 50, root included) fills with own-metadata targets, then records pointing at the root, then Event Data endpoints, then the second hop; `relation_types` keeps only the listed relation types, read from the traced DOI's side (omitted: all); `include_event_data` (default `true`) adds Event Data citation links
- Edges keep `relationType` exactly as asserted and list their `sources` (`metadata`, `reverse_metadata`, `event_data`); `coverage` states how much of each source was read (up to 100 reverse records per hop, only the first 10 when those are large, and up to 100 events per call), and `rootCounts` carries DataCite's own counts for comparison. An absent edge is not evidence that no relationship exists

---

### `datacite_search_repositories` <sub>tool</sub>

- `query` text over names and descriptions, plus `field_of_science`, `repository_types`, `certificates`, `software`, `client_type`, and `provider_id`; or `repository_ids` alone (up to 25) to look up known accounts
- `limit` 1–100 (default 20) with `page`; name-ordered rows carry the `repositoryId` that `datacite_search_works` takes in `repository_ids`, plus `providerId`, types, certificates, software, subjects, homepage, and re3data link

---

### `datacite_get_citation` <sub>tool</sub>

- `format`: `text` (default), `csl_json`, `bibtex`, `ris`, `datacite_json`, `datacite_xml`, `schema_org`, `codemeta`, or `jats`
- For `text` only: `style` takes a CSL style id (default `apa`; verified ids under `datacite_list_reference` topic `citation_styles`), and one DataCite would silently render as APA fails as `unsupported_style`; `locale` takes one of the 61 CSL locales DataCite renders (`en-GB`, `de-DE`, `fr-FR`, …) or a bare language code that expands to its primary dialect (`de` → `de-DE`), default `en-US` (list: topic `citation_locales`)
- `text` returns the citation as plain text in `citation` and the upstream markup in `citationHtml`; machine formats return the payload verbatim up to 100,000 characters, with its `mediaType`; a longer payload is cut to its first 100,000 and the cut is disclosed (`truncated: true`). A DOI DataCite doesn't hold returns `found: false` as in `datacite_get_work`; a format DataCite can't render for that DOI fails as `format_unavailable`

---

### `datacite_list_reference` <sub>tool</sub>

- `topic`: `resource_types`, `relation_types`, `identifier_types`, `date_types`, `contributor_types`, `fields_of_science`, `licenses`, `repository_types`, `certificates`, `software_platforms`, `client_types`, `sort_orders`, `query_syntax`, `citation_formats`, `citation_styles`, `citation_locales`, `identifier_formats`, or `coverage`
- Returns `entries` (`value`, `label`, `group`, `inverse`) and usage `notes`; makes no upstream request

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

DataCite-specific:

- Keyless and read-only: the [DataCite REST API](https://support.datacite.org/docs/api) (`/dois`, `/repositories`, [Event Data](https://support.datacite.org/docs/eventdata-guide) at `/events`, and [DOI content negotiation](https://support.datacite.org/docs/datacite-content-resolver) for citations), plus the doi.org [registration-agency lookup](https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation) for DOIs DataCite doesn't hold
- Shared request budget: one paced request queue, an in-process response cache, and a 45 s deadline per tool call; a spent budget fails as `rate_limited` with the wait in seconds. `DATACITE_CONTACT_EMAIL` moves requests to DataCite's identified tier, 1,000 requests per 5 minutes per IP instead of 500
- Forgiving identifiers: DOIs in any case, bare or prefixed or as doi.org URLs; ORCID iDs with their checksum verified; ROR IDs and Crossref Funder IDs bare or as URLs; vocabulary values in any case, with hyphens, underscores, or spaces
- DataCite DOI metadata is waived under [CC0 1.0](https://support.datacite.org/docs/datacite-data-file-use-policy); the waiver covers the deposited metadata only, not the datasets, software, or papers it describes. `datacite_get_work` reports `metadataLicense` separately from the work's own `rights`

Agent-friendly output:

- Provenance on every search: `effectiveQuery`, `appliedFilters` as sent upstream, the sort or order applied, and `totalCount`; trace edges name their `sources`, and `coverage` says how much of each source was read
- Typed misses instead of errors: a DOI DataCite doesn't hold comes back `found: false` with a `missReason`, the agency that holds it when known, and the next step
- Disclosed limits: capped lists report their full counts, and notices explain zero hits, the 10,000-match paging ceiling, an unexpanded second hop, and citations the returned edges don't account for
- In the text output, depositor-supplied text (titles, descriptions, names) is blockquoted or flattened and machine payloads are fenced, so deposited content can't pose as structure; `structuredContent` keeps it verbatim

## Getting started

### Public Hosted Instance

A public instance is available at `https://datacite.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "datacite-mcp-server": {
      "type": "streamable-http",
      "url": "https://datacite.caseyjhand.com/mcp"
    }
  }
}
```

Every caller of the hosted instance shares one DataCite request budget of 800 requests per 5 minutes. For sustained use, run your own instance.

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is needed; the contact email is optional.

```json
{
  "mcpServers": {
    "datacite-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/datacite-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "DATACITE_CONTACT_EMAIL": "you@example.org"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "datacite-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/datacite-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "DATACITE_CONTACT_EMAIL": "you@example.org"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "datacite-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/datacite-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account. Optional: a contact email in `DATACITE_CONTACT_EMAIL` doubles DataCite's per-IP request allowance.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/datacite-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd datacite-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set DATACITE_CONTACT_EMAIL if you want the identified tier
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `DATACITE_CONTACT_EMAIL` | Contact email sent in the `User-Agent` as `mailto:`, never in a URL. Moves requests to DataCite's identified tier: 1,000 requests per 5 minutes per IP instead of 500. Validated as an email at startup. | none |
| `DATACITE_MAX_REQUESTS_PER_5MIN` | Request budget per 5-minute window, an integer from 50 to 1000. Divide it across replicas that share one egress IP. | `800` with a contact email, `400` without |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers the six tools and sets the server instructions. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and the input-schema, miss-guidance, and text-rendering helpers they share. |
| `src/services/datacite` | DataCite REST client (`/dois`, `/repositories`, `/events`, content negotiation), query builder, identifier normalizers, record mappers, relation-graph builder, and citation style check. |
| `src/services/doi-ra` | doi.org registration-agency lookup for DOIs DataCite holds no public record for. |
| `src/services/http` | Shared upstream pipeline — response cache, request pacer, retry, per-call deadline, rate-limit handling. |
| `src/services/reference` | Static vocabularies behind `datacite_list_reference` and the input validators. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Vitest tests mirroring `src/`, with recorded DataCite and doi.org fixtures. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
