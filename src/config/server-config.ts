/**
 * @fileoverview Server-specific configuration: the DataCite contact email and the
 * request budget per 5-minute window. Lazy-parsed from environment variables;
 * framework config (transport, logging, …) is handled by @cyanheads/mcp-ts-core.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  contactEmail: z
    .email()
    .optional()
    .describe(
      "Contact email appended to the User-Agent as mailto: (header only). Moves requests to DataCite's identified tier.",
    ),
  maxRequestsPer5Min: z.coerce
    .number()
    .int()
    .min(50)
    .max(1000)
    .optional()
    .describe('Pacer budget per 5-minute window. Default 800 with a contact email, 400 without.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contactEmail: 'DATACITE_CONTACT_EMAIL',
    maxRequestsPer5Min: 'DATACITE_MAX_REQUESTS_PER_5MIN',
  });
  return _config;
}
