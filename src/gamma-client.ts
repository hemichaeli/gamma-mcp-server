/**
 * Gamma Public API v1.0 client.
 * Docs: https://developers.gamma.app
 *
 * Auth uses the custom header `X-API-KEY` (NOT `Authorization: Bearer`).
 * All generation endpoints are async: create → poll until completed/failed.
 */

const GAMMA_BASE_URL = "https://public-api.gamma.app/v1.0";

export class GammaAPIError extends Error {
  public status: number;
  public body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(`Gamma API ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.GAMMA_API_KEY;
  if (!key) {
    throw new Error(
      "GAMMA_API_KEY environment variable is not set. " +
        "Generate one at https://gamma.app/settings/api-keys (requires Pro/Ultra/Teams/Business)."
    );
  }
  return key;
}

async function gammaFetch<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  const { query, ...rest } = init;
  let url = `${GAMMA_BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    ...rest,
    headers: {
      "X-API-KEY": apiKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(rest.headers || {}),
    },
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep as text
  }

  if (!res.ok) {
    const hint =
      res.status === 401
        ? "Invalid or missing API key. Check GAMMA_API_KEY."
        : res.status === 402
        ? "Insufficient credits. Top up at Settings > Billing."
        : res.status === 403
        ? "Access denied or feature not available on this plan."
        : res.status === 404
        ? "Resource not found (check IDs)."
        : res.status === 429
        ? "Rate limited. Back off and retry."
        : "Request failed.";
    throw new GammaAPIError(res.status, hint, body);
  }

  return body as T;
}

// ---------------- Types ----------------

export type TextMode = "generate" | "condense" | "preserve";
export type DocFormat = "presentation" | "document" | "social" | "webpage";
export type CardSplit = "inputTextBreaks" | "auto";
export type TextAmount = "brief" | "medium" | "detailed" | "extensive";
export type ImageSource =
  | "webAllImages"
  | "webFreeToUse"
  | "webFreeToUseCommercially"
  | "aiGenerated"
  | "pictographic"
  | "giphy"
  | "pexels"
  | "placeholder"
  | "noImages"
  | "themeAccent";
export type CardDimensions =
  | "fluid"
  | "16x9"
  | "4x3"
  | "pageless"
  | "letter"
  | "a4"
  | "1x1"
  | "4x5"
  | "9x16";
export type ExportFormat = "pptx" | "pdf" | "png";
export type GenerationStatus = "pending" | "completed" | "failed";

export interface CreateGenerationBody {
  inputText: string;
  textMode: TextMode;
  format?: DocFormat;
  numCards?: number;
  cardSplit?: CardSplit;
  themeId?: string;
  additionalInstructions?: string;
  textOptions?: {
    amount?: TextAmount;
    tone?: string;
    audience?: string;
    language?: string;
  };
  imageOptions?: {
    model?: string;
    style?: string;
    source?: ImageSource;
  };
  cardOptions?: {
    dimensions?: CardDimensions;
    headerFooter?: Record<string, unknown>;
  };
  sharingOptions?: {
    workspaceAccess?: "edit" | "comment" | "view" | "noAccess" | "fullAccess";
    externalAccess?: "edit" | "comment" | "view" | "noAccess";
    emailOptions?: {
      recipients: string[];
      access: "edit" | "comment" | "view" | "fullAccess";
    };
  };
  folderIds?: string[];
  exportAs?: ExportFormat;
}

export interface CreateFromTemplateBody {
  prompt: string;
  gammaId: string;
  themeId?: string;
  imageOptions?: { model?: string; style?: string };
  sharingOptions?: CreateGenerationBody["sharingOptions"];
  folderIds?: string[];
  exportAs?: ExportFormat;
}

export interface GenerationStatusResponse {
  generationId: string;
  status: GenerationStatus;
  gammaId?: string;
  gammaUrl?: string;
  exportUrl?: string;
  error?: { message: string; statusCode: number };
  credits?: { deducted: number; remaining: number };
}

export interface CreateGenerationResponse {
  generationId: string;
  warnings?: string;
}

export interface ThemeItem {
  id: string;
  name: string;
  colorKeywords?: string[];
  toneKeywords?: string[];
  type: "standard" | "custom";
}

export interface FolderItem {
  id: string;
  name: string;
}

export interface ListResponse<T> {
  data: T[];
  hasMore: boolean;
  nextCursor?: string | null;
}

// ---------------- Endpoints ----------------

export async function createGeneration(
  body: CreateGenerationBody
): Promise<CreateGenerationResponse> {
  return gammaFetch<CreateGenerationResponse>("/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function createFromTemplate(
  body: CreateFromTemplateBody
): Promise<CreateGenerationResponse> {
  return gammaFetch<CreateGenerationResponse>("/generations/from-template", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getGeneration(id: string): Promise<GenerationStatusResponse> {
  return gammaFetch<GenerationStatusResponse>(
    `/generations/${encodeURIComponent(id)}`,
    { method: "GET" }
  );
}

export async function listThemes(opts: {
  query?: string;
  limit?: number;
  after?: string;
}): Promise<ListResponse<ThemeItem>> {
  return gammaFetch<ListResponse<ThemeItem>>("/themes", {
    method: "GET",
    query: opts,
  });
}

export async function listFolders(opts: {
  query?: string;
  limit?: number;
  after?: string;
}): Promise<ListResponse<FolderItem>> {
  return gammaFetch<ListResponse<FolderItem>>("/folders", {
    method: "GET",
    query: opts,
  });
}

/**
 * Poll a generation until status is completed or failed.
 * Defaults: 5s interval, 10min timeout (matches Gamma's docs for typical gens).
 */
export async function pollGeneration(
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<GenerationStatusResponse> {
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();

  while (true) {
    const status = await getGeneration(id);
    if (status.status === "completed" || status.status === "failed") {
      return status;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Gamma generation ${id} timed out after ${timeoutMs}ms (last status: ${status.status}). ` +
          `Use gamma_get_generation to keep polling manually.`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
