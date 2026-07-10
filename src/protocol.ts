export type JsonObject = Record<string, unknown>;
export type RequestId = number | string;

export interface AppServerRequest<TParams = unknown> {
  id: RequestId;
  method: string;
  params?: TParams;
}

export interface AppServerResponse<TResult = unknown> {
  id: RequestId;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AppServerNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface McpServerStatusListResponse {
  data: McpServerStatus[];
  nextCursor?: string | null;
}

export interface McpServerStatus {
  name: string;
  authStatus: string;
  tools: Record<string, McpTool>;
  resources: unknown[];
  resourceTemplates: unknown[];
}

export interface McpTool {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    sessionId: string;
    status: unknown;
    cwd: string;
    ephemeral: boolean;
  };
  model: string;
  modelProvider: string;
}
