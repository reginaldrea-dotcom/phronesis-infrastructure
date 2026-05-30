// Shared types for api-prime-invoke.

export interface Artifact {
  title: string;
  content: string;
  type: string;
  version: number;
}

export interface HoldThisPayload {
  mode: "create" | "amend";
  instance_id?: string;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface FileAttachment {
  data: string;
  media_type: string;
  name?: string;
}
