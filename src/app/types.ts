
export interface GroundingOptions {
  useCloud: boolean;
  usePreloaded: boolean;
  useGoogleSearch: boolean;
  useGoogleMaps: boolean;
}

export interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
  maps?: {
    uri: string;
    title: string;
    reviewSnippets?: {
      text: string;
      uri: string;
      title: string;
    }[];
  };
}

export enum MessageRole {
  USER = 'user',
  MODEL = 'model',
}

export enum Intent {
  QUERY_DOCUMENTS = 'query_documents',
  GENERATE_CODE = 'generate_code',
  CHIT_CHAT = 'chit_chat',
  UNKNOWN = 'unknown'
}

export enum ResponseType {
  RAG = 'RAG',
  CODE_GENERATION = 'Code Generation',
  CHIT_CHAT = 'Chit-Chat',
  GOOGLE_SEARCH = 'Google Search',
}

export enum ModelId {
  GEMINI_FLASH_LITE = 'gemini-flash-lite',
  GEMINI_FLASH = 'gemini-flash',
  GEMINI_PRO = 'gemini-pro',
  GEMINI_NANO = 'gemini-nano'
}

export type Theme = 'light' | 'dark';

export interface ModelDefinition {
  id: ModelId;
  name: string;
  model: string;
  group: string;
  description: string;
}

export const MODELS: ModelDefinition[] = [
  {
    id: ModelId.GEMINI_FLASH_LITE,
    name: '2.5 Flash Lite',
    model: 'gemini-flash-lite-latest',
    group: 'Fast all-round help',
    description: 'Gemini-flash-lite-latest'
  },
  {
    id: ModelId.GEMINI_FLASH,
    name: '2.5 Flash',
    model: 'gemini-2.5-flash',
    group: 'Fast all-round help',
    description: '2.5 Flash'
  },
  {
    id: ModelId.GEMINI_PRO,
    name: '2.5 Pro',
    model: 'gemini-2.5-pro',
    group: 'Reasoning, maths and code',
    description: '2.5 Pro'
  },
  {
    id: ModelId.GEMINI_NANO,
    name: 'Gemini Nano',
    model: 'gemini-nano',
    group: 'On-device',
    description: 'Local on-device model'
  }
];

export interface Source {
  id: string;
  file_name: string;
  path: string;
}

export interface CodeSuggestion {
  file: Source;
  thought: string;
  originalContent: string;
  suggestedContent: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface Attachment {
    name: string;
    type: string; // Mime type
    size: number;
    content: string; // base64 encoded
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  attachment?: Attachment;
  sources?: ElasticResult[];
  suggestion?: CodeSuggestion;
  editedFile?: Source;
  responseType?: ResponseType;
  modelId?: ModelId;
  groundingChunks?: GroundingChunk[];
}

export interface DataSource {
  type: 'folder' | 'files' | 'drive' | 'database';
  name: string;
  fileCount: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  dataSource: DataSource | null;
  dataset: ElasticResult[];
  groundingOptions: GroundingOptions;
}

export interface ElasticResult {
  source: Source;
  contentSnippet: string;
  score: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}
