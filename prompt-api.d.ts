declare const LanguageModel: LanguageModel;

interface LanguageModel {
  availability(): Promise<
    'available' | 'downloading' | 'downloadable' | 'unavailable'
  >;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  params(): Promise<LanguageModelParams>;
}

interface LanguageModelCreateOptions {
  topK?: number;
  temperature?: number;
  signal?: AbortSignal;
  initialPrompts?: LanguageModelPrompt[];
  expectedInputs?: LanguageModelExpectedInput[];
  expectedOutputs?: LanguageModelExpectedOutput[];
  monitor?: (monitor: LanguageModelMonitor) => void;
}

interface LanguageModelMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: LanguageModelDownloadProgressEvent) => void,
  ): void;
}

interface LanguageModelDownloadProgressEvent extends Event {
  loaded: number;
  total: number;
}

interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

interface LanguageModelSession {
  prompt(
    prompt: string | LanguageModelPrompt[],
    options?: LanguageModelPromptOptions,
  ): Promise<string>;
  promptStreaming(
    prompt: string | LanguageModelPrompt[],
    options?: LanguageModelPromptOptions,
  ): ReadableStream<string>;
  destroy(): void;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  inputUsage: number;
  inputQuota: number;
  measureInputUsage(options: {
    responseConstraint?: any;
  }): Promise<{ totalTokens: number }>;
  append(prompts: LanguageModelPrompt[]): Promise<void>;
}

interface LanguageModelPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string | (LanguageModelTextContent | LanguageModelImageContent)[];
  prefix?: boolean;
}

interface LanguageModelTextContent {
  type: 'text';
  value: string;
}

interface LanguageModelImageContent {
  type: 'image';
  value: Blob;
}

interface LanguageModelPromptOptions {
  signal?: AbortSignal;
  responseConstraint?: any;
  omitResponseConstraintInput?: boolean;
}

interface LanguageModelExpectedInput {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

interface LanguageModelExpectedOutput {
  type: 'text';
  languages?: string[];
}
