---
name: datacite-guide
description: Use with datacite_* tools to attribute research outputs, find datasets or software linked to an article, compare concept and version DOIs, or assemble a complete inventory. Guides identity resolution and evidence checks before drawing conclusions from search results or relation graphs.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use DataCite for deposited metadata about datasets, software, and other research outputs, and for evidence linking those outputs to articles. It exposes public Findable records, not the underlying research files. Another agency's DOI can start a relation trace even when DataCite cannot return its own metadata; obtain that metadata from the registration agency named in the lookup response.

## Identifiers

- Take work DOIs from `datacite_search_works`; take related identifiers from `datacite_get_work` or `datacite_trace_relations`. Check a related node's identifier type before treating it as a DOI.
- Resolve a repository name with `datacite_search_repositories`. Its repository ID identifies an account; its provider ID identifies the parent provider. Choose the intended scope before searching works.
- Reuse deposited ORCID iDs, affiliation ROR IDs, and funder identifiers from inspected records only after confirming they identify the intended person or organization. These tools have no general person or organization directory: when only a name is known, use it to discover candidates, then inspect their identity evidence.
- Consult `datacite_list_reference` for identifier forms, relation inverses, and query syntax rather than guessing field paths or codes.

## Gates

- Before attributing a result to a person or funder, inspect its creators or funding references with `datacite_get_work`. Name searches can match tokens split across co-authors; a search hit alone does not establish identity. Prefer a verified identifier when available.
- Before reporting a work absent, distinguish an empty search from a DOI lookup's miss classification. A nonpublic record, another agency's DOI, and an unanswered agency lookup do not establish nonexistence.
- Before calling a relation inventory complete, inspect coverage, hydration state, and notices. Reverse metadata, Event Data, node counts, and edges can each be incomplete; increasing the node allowance does not remove every source limit.
- Read each edge as an assertion by its `from` node. Metadata and reverse-metadata sources can be two routes to the same assertion, not independent corroboration.
- Before treating a zero-hit syntax query as evidence of absence, check its field paths with `datacite_list_reference`. Unknown fields can return zero without an error; use literal text search when field syntax is unnecessary.
- Before claiming an output is reusable, inspect its deposited rights. The metadata's CC0 status does not license the described data or software.

## Core chain

Resolve the intended identity or repository scope, discover candidate works, inspect the relevant deposited fields, follow the relations needed for the task, then cite the selected work DOI. Keep search matches, deposited assertions, and harvested links distinguishable in the answer.

## Workflows

**Repository inventory.** Resolve the account before searching its works. To identify repositories holding works on a topic, start with work-search facets, then inspect the returned repository IDs. Repository registry subjects describe the repository; they do not count matching works. Facets show top values, so do not present them as an exhaustive repository ranking.

**Researcher, institution, or funder inventory.** Establish the intended identity, search with its verified identifier when possible, and inspect candidate creators, affiliations, or funding references before attributing outputs. If only name evidence is available, describe that limitation instead of presenting an exact identity inventory.

**Data behind an article.** Start `datacite_trace_relations` from the article DOI even if `datacite_get_work` reports another registration agency. Inspect the relation types and asserting sides, then open the DataCite candidates to establish what each output contains. Report the links found and their coverage; an empty trace cannot establish that an article has no associated data.

**Software versions and citations.** Inspect concept/version relations before deciding which DOI answers the task. Trace the concept and relevant version DOIs separately when assessing their citation evidence. Do not add their citation counts and label the sum unique citing works; retain DOI attribution and deduplicate identified citing works when combining evidence.

**Complete search inventory.** Use ranked search for discovery and a cursor walk for enumeration beyond the ranked window. Follow the returned continuation unchanged with the same search criteria; restart the walk when criteria change. Report continuation or coverage limits before calling an inventory complete. For relation evidence, follow Event Data continuation separately; that mode does not continue metadata edges or second-hop expansion.
