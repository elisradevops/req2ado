import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_work_item_type_categories` — resolves req2ado's internal Epic/Feature/Requirement labels to the project's real work-item type names. */
export function registerDiscoverWorkItemTypeCategoriesTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_work_item_type_categories',
    {
      title: 'Discover ADO work-item type categories',
      description:
        'Resolves req2ado\'s 3 internal category labels (Epic/Feature/Requirement) to the REAL work-item type name the target project\'s actual process template uses for each -- e.g. Agile\'s Requirement-category type is "User Story", Scrum\'s is "Product Backlog Item", CMMI\'s is "Requirement". Every caller that needs to send a work-item type name to ADO (ado_create_work_item, ado_discover_fields, ado_read_states) must translate through this first.',
      inputSchema: { project: z.string().optional() },
    },
    async ({ project }) => {
      const categories = await backend.discoverWorkItemTypeCategories(project);
      return { content: [{ type: 'text', text: JSON.stringify(categories) }] };
    },
  );
}
