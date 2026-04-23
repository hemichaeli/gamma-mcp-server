import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createGeneration,
  createFromTemplate,
  getGeneration,
  listThemes,
  listFolders,
  pollGeneration,
  GammaAPIError,
  type CreateGenerationBody,
  type CreateFromTemplateBody,
  type GenerationStatusResponse,
} from "./gamma-client.js";

// ----- Shared enums (Zod) -----

const TextModeSchema = z
  .enum(["generate", "condense", "preserve"])
  .describe(
    "How Gamma interprets inputText. " +
      "`generate` expands a topic into content, `condense` summarizes, `preserve` keeps text as-is."
  );

const FormatSchema = z
  .enum(["presentation", "document", "social", "webpage"])
  .describe("Output artifact type. Defaults to `presentation` if omitted.");

const CardSplitSchema = z
  .enum(["inputTextBreaks", "auto"])
  .describe(
    "How content is divided into cards. `auto` uses numCards; `inputTextBreaks` splits on `\\n---\\n` markers."
  );

const TextAmountSchema = z.enum(["brief", "medium", "detailed", "extensive"]);

const ImageSourceSchema = z.enum([
  "webAllImages",
  "webFreeToUse",
  "webFreeToUseCommercially",
  "aiGenerated",
  "pictographic",
  "giphy",
  "pexels",
  "placeholder",
  "noImages",
  "themeAccent",
]);

const CardDimensionsSchema = z.enum([
  "fluid",
  "16x9",
  "4x3",
  "pageless",
  "letter",
  "a4",
  "1x1",
  "4x5",
  "9x16",
]);

const ExportFormatSchema = z.enum(["pptx", "pdf", "png"]);

const WorkspaceAccessSchema = z.enum([
  "edit",
  "comment",
  "view",
  "noAccess",
  "fullAccess",
]);
const ExternalAccessSchema = z.enum(["edit", "comment", "view", "noAccess"]);
const EmailAccessSchema = z.enum(["edit", "comment", "view", "fullAccess"]);

const SharingOptionsSchema = z
  .object({
    workspaceAccess: WorkspaceAccessSchema.optional(),
    externalAccess: ExternalAccessSchema.optional(),
    emailOptions: z
      .object({
        recipients: z.array(z.string().email()),
        access: EmailAccessSchema,
      })
      .optional(),
  })
  .optional();

const TextOptionsSchema = z
  .object({
    amount: TextAmountSchema.optional(),
    tone: z
      .string()
      .max(500)
      .optional()
      .describe('E.g. "professional, upbeat", "academic", "playful".'),
    audience: z
      .string()
      .max(500)
      .optional()
      .describe('E.g. "executives", "new hires", "seven year olds".'),
    language: z
      .string()
      .optional()
      .describe(
        'ISO language code. Examples: "en", "he", "es", "fr", "ja". Defaults to "en".'
      ),
  })
  .optional();

const ImageOptionsSchema = z
  .object({
    model: z
      .string()
      .optional()
      .describe(
        "AI image model id. Examples: imagen-4-pro, flux-1-pro, gpt-image-1-high, gemini-3-pro-image. " +
          "Availability depends on plan."
      ),
    style: z.string().max(500).optional(),
    source: ImageSourceSchema.optional(),
  })
  .optional();

const CardOptionsSchema = z
  .object({
    dimensions: CardDimensionsSchema.optional(),
    headerFooter: z
      .record(z.any())
      .optional()
      .describe(
        "Header/footer config with slots topLeft/topCenter/topRight/bottomLeft/bottomCenter/bottomRight. " +
          "Each slot holds an object with `type` (cardNumber|image|text), plus `value`, `src`, `source`, `size`."
      ),
  })
  .optional();

// ----- Formatting helpers -----

function formatGenerationResult(r: GenerationStatusResponse): string {
  const lines: string[] = [];
  lines.push(`generationId: ${r.generationId}`);
  lines.push(`status: ${r.status}`);
  if (r.gammaId) lines.push(`gammaId: ${r.gammaId}`);
  if (r.gammaUrl) lines.push(`gammaUrl: ${r.gammaUrl}`);
  if (r.exportUrl) lines.push(`exportUrl: ${r.exportUrl}`);
  if (r.credits)
    lines.push(
      `credits: deducted ${r.credits.deducted}, remaining ${r.credits.remaining}`
    );
  if (r.error) lines.push(`error: [${r.error.statusCode}] ${r.error.message}`);
  return lines.join("\n");
}

function toolError(err: unknown) {
  if (err instanceof GammaAPIError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `Gamma API error (${err.status}): ${err.message}\n` +
            `Body: ${JSON.stringify(err.body, null, 2)}`,
        },
      ],
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

// ----- Factory: one McpServer per SSE session (avoids session cross-contamination) -----

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "gamma-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  // --- gamma_generate (create + poll to completion) ---

  server.registerTool(
    "gamma_generate",
    {
      title: "Generate a Gamma from text",
      description:
        "Generate a polished presentation, document, webpage, or social post from text using the Gamma public API. " +
        "Creates the generation, polls until completion, and returns the final gammaUrl and (if requested) exportUrl. " +
        "Use this for the common case. If you need fire-and-forget, set `wait: false` and use `gamma_get_generation` later.",
      inputSchema: {
        inputText: z
          .string()
          .min(1)
          .max(400_000)
          .describe(
            "Content to generate from. Can be a short topic ('Q3 launch strategy'), a detailed outline, or full text. " +
              "Embed image URLs inline to reference specific images. Use `\\n---\\n` to force card splits (pair with cardSplit=inputTextBreaks)."
          ),
        textMode: TextModeSchema,
        format: FormatSchema.optional(),
        numCards: z
          .number()
          .int()
          .min(1)
          .max(75)
          .optional()
          .describe(
            "Target number of cards. Pro/Teams/Business: 1-60. Ultra: 1-75. Only used when cardSplit=auto (the default)."
          ),
        cardSplit: CardSplitSchema.optional(),
        themeId: z
          .string()
          .optional()
          .describe(
            "Theme id from `gamma_list_themes` or copied from the Gamma app. Controls colors/fonts/branding."
          ),
        additionalInstructions: z
          .string()
          .max(5000)
          .optional()
          .describe(
            "Free-form guidance that doesn't fit other params: layout preferences, visual style, tone nudges, formatting rules."
          ),
        textOptions: TextOptionsSchema,
        imageOptions: ImageOptionsSchema,
        cardOptions: CardOptionsSchema,
        sharingOptions: SharingOptionsSchema,
        folderIds: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("Folder ids from `gamma_list_folders` to store the output."),
        exportAs: ExportFormatSchema.optional().describe(
          "Auto-export the result. Only one format per request. Export URLs expire in ~1 week."
        ),
        wait: z
          .boolean()
          .optional()
          .describe(
            "If true (default), poll until completion and return the final URL. " +
              "If false, return immediately with just the generationId."
          ),
        pollIntervalMs: z
          .number()
          .int()
          .min(1000)
          .max(30_000)
          .optional()
          .describe("Poll interval when waiting. Default 5000 (5s)."),
        pollTimeoutMs: z
          .number()
          .int()
          .min(10_000)
          .max(30 * 60 * 1000)
          .optional()
          .describe("Max wait time. Default 600000 (10 minutes)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const {
          wait = true,
          pollIntervalMs,
          pollTimeoutMs,
          ...body
        } = args as Record<string, unknown> & { wait?: boolean };

        const created = await createGeneration(body as CreateGenerationBody);

        if (!wait) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Generation started.\n` +
                  `generationId: ${created.generationId}\n` +
                  (created.warnings ? `warnings: ${created.warnings}\n` : "") +
                  `Poll with: gamma_get_generation { id: "${created.generationId}" }`,
              },
            ],
          };
        }

        const result = await pollGeneration(created.generationId, {
          intervalMs: pollIntervalMs as number | undefined,
          timeoutMs: pollTimeoutMs as number | undefined,
        });

        return {
          content: [
            {
              type: "text",
              text:
                (created.warnings ? `warnings: ${created.warnings}\n\n` : "") +
                formatGenerationResult(result),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- gamma_generate_from_template (create + poll) ---

  server.registerTool(
    "gamma_generate_from_template",
    {
      title: "Generate a Gamma from a template",
      description:
        "Generate a Gamma using an existing single-page template with variable substitution. " +
        "Use this when you want a fixed layout and only the content changes (e.g. repeated sales briefs, weekly reports). " +
        "The template must already exist in your workspace and have exactly one Page.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(400_000)
          .describe("Text prompt describing the content to fill into the template."),
        gammaId: z
          .string()
          .min(1)
          .describe(
            "File id of the template Gamma. Find it in the URL: gamma.app/docs/Name-<gammaId>. The template must have exactly one Page."
          ),
        themeId: z.string().optional(),
        imageOptions: z
          .object({
            model: z.string().optional(),
            style: z.string().max(500).optional(),
          })
          .optional(),
        sharingOptions: SharingOptionsSchema,
        folderIds: z.array(z.string()).max(10).optional(),
        exportAs: ExportFormatSchema.optional(),
        wait: z.boolean().optional(),
        pollIntervalMs: z.number().int().min(1000).max(30_000).optional(),
        pollTimeoutMs: z.number().int().min(10_000).max(30 * 60 * 1000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const {
          wait = true,
          pollIntervalMs,
          pollTimeoutMs,
          ...body
        } = args as Record<string, unknown> & { wait?: boolean };

        const created = await createFromTemplate(body as CreateFromTemplateBody);

        if (!wait) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Template generation started.\n` +
                  `generationId: ${created.generationId}\n` +
                  (created.warnings ? `warnings: ${created.warnings}\n` : "") +
                  `Poll with: gamma_get_generation { id: "${created.generationId}" }`,
              },
            ],
          };
        }

        const result = await pollGeneration(created.generationId, {
          intervalMs: pollIntervalMs as number | undefined,
          timeoutMs: pollTimeoutMs as number | undefined,
        });

        return {
          content: [
            {
              type: "text",
              text:
                (created.warnings ? `warnings: ${created.warnings}\n\n` : "") +
                formatGenerationResult(result),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- gamma_get_generation (poll status manually) ---

  server.registerTool(
    "gamma_get_generation",
    {
      title: "Get generation status",
      description:
        "Check the status of a Gamma generation job by id. Returns status (pending/completed/failed), gammaUrl, exportUrl, and credit usage. " +
        "Use this when you started a generation with `wait: false`, or to check on a long-running job.",
      inputSchema: {
        id: z.string().min(1).describe("Generation id returned by gamma_generate or gamma_generate_from_template."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const r = await getGeneration(id);
        return { content: [{ type: "text", text: formatGenerationResult(r) }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- gamma_list_themes ---

  server.registerTool(
    "gamma_list_themes",
    {
      title: "List workspace themes",
      description:
        "List themes available in the workspace (standard + custom). Use the returned `id` as `themeId` in generation calls. " +
        "Supports cursor pagination via `after` / `nextCursor`.",
      inputSchema: {
        query: z.string().optional().describe("Filter themes by name (substring match)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to return (1-50). Default 50."),
        after: z.string().optional().describe("Pagination cursor from a previous response's nextCursor."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const r = await listThemes(args as {
          query?: string;
          limit?: number;
          after?: string;
        });
        const lines = r.data.map(
          (t) =>
            `- ${t.name} (id: ${t.id}, type: ${t.type}` +
            (t.colorKeywords?.length ? `, colors: ${t.colorKeywords.join("/")}` : "") +
            (t.toneKeywords?.length ? `, tone: ${t.toneKeywords.join("/")}` : "") +
            `)`
        );
        const text =
          `Found ${r.data.length} theme(s). hasMore=${r.hasMore}` +
          (r.nextCursor ? `, nextCursor=${r.nextCursor}` : "") +
          `\n\n` +
          (lines.join("\n") || "(no themes)");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- gamma_list_folders ---

  server.registerTool(
    "gamma_list_folders",
    {
      title: "List workspace folders",
      description:
        "List folders the authenticated user belongs to. Use the returned `id` in `folderIds` on generation calls to save output into a folder. " +
        "Supports cursor pagination.",
      inputSchema: {
        query: z.string().optional().describe("Filter folders by name."),
        limit: z.number().int().min(1).max(50).optional(),
        after: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const r = await listFolders(args as {
          query?: string;
          limit?: number;
          after?: string;
        });
        const lines = r.data.map((f) => `- ${f.name} (id: ${f.id})`);
        const text =
          `Found ${r.data.length} folder(s). hasMore=${r.hasMore}` +
          (r.nextCursor ? `, nextCursor=${r.nextCursor}` : "") +
          `\n\n` +
          (lines.join("\n") || "(no folders)");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
