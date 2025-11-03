import React, { useState, useCallback, useEffect } from 'react';
import {
    ChatMessage, MessageRole, Source, ElasticResult, Intent, CodeSuggestion,
    ModelId, MODELS, ResponseType, Chat, Theme, Attachment, DataSource,
    GroundingOptions, DriveFile
} from './types';
import {
    searchCloudDocuments, getAllCloudFiles, getCloudFileContent,
    createDatasetFromSources, updateFileContent, searchPreloadedDocuments,
    getAllPreloadedFiles, getPreloadedFileContent
} from './services/elasticService';
import {
    streamAiResponse, classifyIntent, streamChitChatResponse,
    streamCodeGenerationResponse, rewriteQuery
} from './services/geminiService';
import Header from './components/Header';
import ChatInterface from './components/ChatInterface';
import FileSearch from './components/FileSearch';
import FileViewer from './components/FileViewer';
import EditedFilesViewer from './components/EditedFilesViewer';
import DiffViewerModal from './components/DiffViewerModal';
import ChatHistory from './components/ChatHistory';
import GoogleDrivePicker from './components/GoogleDrivePicker';
import DataSourceModal from './components/DataSourceModal';
import ErrorBoundary from './components/ErrorBoundary';
import { reciprocalRankFusion } from './utils/rrf';
// Import the new chunk viewer modal
import ChunkViewerModal from './components/ChunkViewerModal';

const HISTORY_KEY = 'mnemomind-chat-state-v2'; // Use a new key if structure changed significantly
const EDITABLE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'json', 'md', 'html', 'css', 'scss', 'less',
  'py', 'rb', 'java', 'c', 'cpp', 'cs', 'go', 'php', 'rs', 'swift',
  'kt', 'kts', 'dart', 'sh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'txt'
];

export interface EditedFileRecord {
  file: Source;
  originalContent: string;
  currentContent: string;
}

const App: React.FC = () => {
  // --- State Variables ---
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      const storedTheme = window.localStorage.getItem('theme') as Theme;
      // Default to light theme or system preference if nothing stored
      return storedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    }
    return 'light';
  });

  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [allFiles, setAllFiles] = useState<Source[]>([]); // Files available for the *active* chat's data source
  const [isFileSearchVisible, setIsFileSearchVisible] = useState<boolean>(false);
  const [isEditedFilesVisible, setIsEditedFilesVisible] = useState<boolean>(false);
  const [isDataSourceModalVisible, setIsDataSourceModalVisible] = useState<boolean>(false);
  const [editedFiles, setEditedFiles] = useState<Map<string, EditedFileRecord>>(new Map()); // file.id -> record
  const [selectedFile, setSelectedFile] = useState<Source | null>(null); // For full file viewer
  const [selectedFileContent, setSelectedFileContent] = useState<string>(''); // Content for full file viewer
  const [selectedModel, setSelectedModel] = useState<ModelId>(ModelId.GEMINI_FLASH_LITE);
  const [diffViewerRecord, setDiffViewerRecord] = useState<EditedFileRecord | null>(null); // For diff modal
  const [isSidebarOpen, setIsSidebarOpen] = useState(true); // Chat history sidebar
  const [isCodeGenerationEnabled, setIsCodeGenerationEnabled] = useState<boolean>(false); // Default to off unless cloud source
  const [apiError, setApiError] = useState<string | null>(null); // General API errors
  const [cloudSearchError, setCloudSearchError] = useState<string | null>(null); // Specific Elastic Cloud errors
  const [location, setLocation] = useState<GeolocationPosition | null>(null); // User location for Maps
  const [showGoogleDrivePicker, setShowGoogleDrivePicker] = useState<boolean>(false); // Control GDrive picker visibility
  const [chunkViewerData, setChunkViewerData] = useState<ElasticResult | null>(null); // State for the chunk viewer modal


  // --- Derived State ---
  const activeChat = chats.find(c => c.id === activeChatId);
  const groundingOptions = activeChat?.groundingOptions;
  const messages = activeChat?.messages || [];

  // --- Utility Functions ---
  const updateActiveChat = useCallback((updater: (chat: Chat) => Chat) => {
    setChats(prevChats => prevChats.map(chat =>
      chat.id === activeChatId ? updater(chat) : chat
    ));
  }, [activeChatId]);

  // --- Handlers ---
  const handleNewChat = useCallback(() => {
    const newChat: Chat = {
      id: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`, // More unique ID
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      dataSource: null, // No data source initially
      dataset: [],      // No client-side data initially
      groundingOptions: { // Default grounding options
        useCloud: true,        // Default to cloud search if available
        usePreloaded: false,
        useGoogleSearch: false,
        useGoogleMaps: false,
      },
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    setEditedFiles(new Map()); // Clear edits for new chat
    setCloudSearchError(null); // Clear errors
    setIsCodeGenerationEnabled(true); // Enable code gen if cloud is default
    setSelectedFile(null); // Close viewers
    setDiffViewerRecord(null);
    setChunkViewerData(null);
  }, []);

  // --- Effects ---

  // Load state from localStorage on mount
  useEffect(() => {
    try {
      const savedState = localStorage.getItem(HISTORY_KEY);
      if (savedState) {
        const { chats: savedChats, activeChatId: savedActiveChatId, model: savedModel } = JSON.parse(savedState);
        // Ensure restored chats have default grounding options if missing
        const restoredChats = (savedChats || []).map((chat: any) => ({
          ...chat,
          dataset: chat.dataset || [], // Ensure dataset exists
          groundingOptions: chat.groundingOptions || { // Default if missing
            useCloud: !chat.dataSource, // Sensible default: use cloud if no specific source
            usePreloaded: !!chat.dataSource,
            useGoogleSearch: false,
            useGoogleMaps: false,
          },
          // Ensure messages have the new elasticSources field if loading old state
          messages: (chat.messages || []).map((msg: any) => ({
              ...msg,
              elasticSources: msg.elasticSources || msg.sources || [], // Migrate sources -> elasticSources
              // sources: undefined // Optional: remove old field
          }))
        }));

        setChats(restoredChats);
        setSelectedModel(savedModel || ModelId.GEMINI_FLASH_LITE);

        // Set active chat ID, handling potential inconsistencies
        if (savedActiveChatId && restoredChats.some((c: Chat) => c.id === savedActiveChatId)) {
          setActiveChatId(savedActiveChatId);
        } else if (restoredChats.length > 0) {
          setActiveChatId(restoredChats[0].id); // Fallback to the first chat
        } else {
          handleNewChat(); // Create a new chat if none exist
        }
      } else {
        handleNewChat(); // Create initial chat if no saved state
      }
    } catch (error) {
      console.error("Failed to parse state from localStorage", error);
      localStorage.removeItem(HISTORY_KEY); // Clear potentially corrupted state
      handleNewChat(); // Start fresh
    }
    // handleNewChat is memoized, runs only once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    try {
      // Ensure we don't save excessively large datasets in localStorage
      const chatsToSave = chats.map(chat => ({
          ...chat,
          // Optionally strip large dataset content if storage is a concern
          // dataset: chat.dataset.map(d => ({ ...d, contentSnippet: d.contentSnippet.substring(0, 100) + '...' }))
      }));
      const stateToSave = JSON.stringify({ chats: chatsToSave, activeChatId, model: selectedModel });
      localStorage.setItem(HISTORY_KEY, stateToSave);
    } catch (error) {
      console.error("Failed to save state to localStorage", error);
      // Handle potential storage full errors if necessary
    }
  }, [chats, activeChatId, selectedModel]);

  // Apply theme class to HTML element
  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Get user's location on mount
  useEffect(() => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                console.log("Geolocation acquired:", position);
                setLocation(position);
            },
            (error) => {
                console.warn(`Geolocation error (${error.code}): ${error.message}. Maps grounding may be less effective.`);
                // Optionally inform the user if Maps grounding is enabled but location failed
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 } // Options
        );
    } else {
        console.warn("Geolocation is not supported by this browser.");
    }
  }, []); // Runs once on mount

  // Handle Google Drive callback URL parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('source') === 'google-drive') {
      setIsDataSourceModalVisible(true);
      setShowGoogleDrivePicker(true);
      // Clean the URL parameters after handling
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Fetch file list when active chat or grounding options change
  useEffect(() => {
    const fetchFiles = async () => {
      if (!activeChat || !groundingOptions) {
        setAllFiles([]);
        return;
      }

      let combinedFiles: Source[] = [];
      let cloudError: string | null = null;

      // Fetch preloaded files first (always available if source exists)
      if (groundingOptions.usePreloaded && activeChat.dataset.length > 0) {
          combinedFiles.push(...getAllPreloadedFiles(activeChat.dataset));
      }

      // Fetch cloud files if enabled
      if (groundingOptions.useCloud) {
          try {
              const cloudFiles = await getAllCloudFiles();
              combinedFiles.push(...cloudFiles);
          } catch (error) {
              console.error("Error fetching cloud files:", error);
              cloudError = error instanceof Error ? error.message : "Failed to fetch cloud files.";
              // If fetching fails, immediately update state to reflect the error and disable cloud
              setCloudSearchError(cloudError);
              updateActiveChat(chat => ({
                  ...chat,
                  groundingOptions: { ...chat.groundingOptions, useCloud: false }
              }));
              // Proceed without cloud files for now
          }
      }

       // Fetch Google Drive files if the data source is Drive
       if (activeChat.dataSource?.type === 'drive') {
            try {
                // Assuming an API endpoint exists to list Drive files based on stored credentials
                const response = await fetch('/api/drive/files'); // Adjust endpoint if needed
                if (!response.ok) throw new Error('Failed to fetch Google Drive files');
                const driveFilesData: DriveFile[] = await response.json();
                const driveSources: Source[] = driveFilesData.map(df => ({
                    id: df.id, // Use Drive file ID
                    fileName: df.name,
                    path: 'Google Drive', // Indicate source path
                }));
                combinedFiles.push(...driveSources);
            } catch(driveError) {
                 console.error("Error fetching Google Drive files:", driveError);
                 // Handle Drive error separately if needed, maybe show a specific message
                 setApiError(driveError instanceof Error ? driveError.message : "Failed to load Google Drive files.");
            }
       }


      // Deduplicate files based on a unique identifier (e.g., id or combination)
      // This simple Map approach assumes `id` is unique across sources. Refine if needed.
      const uniqueFiles = Array.from(new Map(combinedFiles.map(file => [file.id, file])).values());
      setAllFiles(uniqueFiles);

      // If there was no cloud error during the fetch attempt, clear any previous error state
      if (!cloudError) {
          setCloudSearchError(null);
      }

       // Automatically disable code generation if only preloaded/drive sources are active
       setIsCodeGenerationEnabled(groundingOptions.useCloud); // Only allow if cloud source is used

       // Ensure preloaded is off if there's no data source or dataset
       if (activeChat && (!activeChat.dataSource || activeChat.dataset.length === 0) && groundingOptions?.usePreloaded) {
           updateActiveChat(chat => ({
               ...chat,
               groundingOptions: { ...chat.groundingOptions, usePreloaded: false }
           }));
       }
    };

    fetchFiles();
  // Dependencies: Rerun when active chat ID changes, or any grounding option changes
  }, [activeChatId, activeChat?.dataSource, activeChat?.dataset, groundingOptions?.useCloud, groundingOptions?.usePreloaded, updateActiveChat]);


  // --- Message Handling Logic ---

  const addMessageToActiveChat = (message: ChatMessage) => {
    updateActiveChat(chat => ({ ...chat, messages: [...chat.messages, message] }));
  };

  const updateLastMessageInActiveChat = (updater: (message: ChatMessage) => ChatMessage) => {
    updateActiveChat(chat => {
        if (!chat.messages || chat.messages.length === 0) return chat; // Safety check
        const lastIndex = chat.messages.length - 1;
        const updatedMessages = [...chat.messages];
        updatedMessages[lastIndex] = updater(updatedMessages[lastIndex]);
        return { ...chat, messages: updatedMessages };
    });
  };

  const searchElastic = async (query: string): Promise<ElasticResult[]> => {
    if (!activeChat || !activeChat.groundingOptions) return [];
    // Reset specific cloud error before attempting search
    setCloudSearchError(null);

    const searchPromises: Promise<ElasticResult[]>[] = [];
    const { useCloud, usePreloaded } = activeChat.groundingOptions;

    // Cloud Search
    if (useCloud) {
        // Wrap in try-catch to handle potential API errors gracefully
        const cloudSearchPromise = searchCloudDocuments(query)
            .catch(error => {
                console.error("Cloud search failed:", error);
                setCloudSearchError(error.message || "Failed to fetch from cloud.");
                // Disable cloud search for this chat if it fails
                 updateActiveChat(chat => ({
                     ...chat,
                     groundingOptions: { ...chat.groundingOptions, useCloud: false }
                 }));
                return []; // Return empty results on error
            });
        searchPromises.push(cloudSearchPromise);
    }

    // Preloaded Search (Client-side, less likely to fail)
    if (usePreloaded && activeChat.dataset.length > 0) {
      searchPromises.push(Promise.resolve(searchPreloadedDocuments(query, activeChat.dataset)));
    }

    try {
      const searchResultsArrays = await Promise.all(searchPromises);
      // Flatten results and apply RRF
      const fusedResults = reciprocalRankFusion(searchResultsArrays);
      return fusedResults.slice(0, 10); // Limit to top 10 fused results
    } catch (error) {
      // This catch might be redundant if individual promises handle errors, but good for safety
      console.error("Error during search result fusion:", error);
      setApiError("An error occurred while combining search results."); // More generic error
      return [];
    }
  };


  const getFileContent = useCallback(async (source: Source): Promise<string | null> => {
      if (!activeChat) return null;
       setApiError(null); // Clear previous errors

       // Handle Google Drive files
       if (source.path === 'Google Drive') {
         try {
           // Ensure the endpoint matches your backend route
           const response = await fetch(`/api/drive/files/${source.id}`);
           if (!response.ok) {
              const errorData = await response.text(); // Get error details
              throw new Error(`Failed to fetch Google Drive content (${response.status}): ${errorData}`);
           }
           const data = await response.json();
           return data.content ?? null; // Return content or null if missing
         } catch (error) {
           const message = error instanceof Error ? error.message : 'Could not load Google Drive file content.';
           setApiError(message);
           console.error("Drive fetch error:", error);
           return `Error: ${message}`;
         }
       }

      // Handle Preloaded files (client-side)
      if (groundingOptions?.usePreloaded && activeChat.dataset.length > 0) {
          const content = getPreloadedFileContent(source, activeChat.dataset);
          if (content !== null) return content;
          // If not found in preloaded but usePreloaded is true, maybe log a warning
          console.warn(`File ${source.fileName} (ID: ${source.id}) not found in preloaded dataset.`);
      }

      // Handle Cloud files (backend API)
      if (groundingOptions?.useCloud) {
          try {
              const content = await getCloudFileContent(source);
              // getCloudFileContent should return the error string directly if fetch fails
              return content;
          } catch (error) {
              // This catch is mainly for unexpected errors *within* getCloudFileContent itself
              const message = error instanceof Error ? error.message : 'Could not load cloud file content.';
              setApiError(message);
               console.error("Cloud fetch error:", error);
              return `Error: ${message}`;
          }
      }

      // If no relevant source type was active or file wasn't found
      setApiError(`Could not determine how to load content for ${source.fileName}. Check grounding options.`);
      return `Error: Could not load content for ${source.fileName}. No active source type matches.`;

  }, [activeChat, groundingOptions]);


  // --- Message Sending Logic (handleQueryDocuments, handleChitChat, etc.) ---

  const handleQueryDocuments = async (currentMessages: ChatMessage[]) => {
    if (!activeChat || !activeChat.groundingOptions) return;

    // Add model message placeholder
    addMessageToActiveChat({
      role: MessageRole.MODEL,
      content: '', // Start empty
      elasticSources: [], // Initialize
      groundingChunks: [],
      responseType: ResponseType.RAG,
      modelId: selectedModel
    });

    const latestQuery = currentMessages[currentMessages.length - 1];
    const { useCloud, usePreloaded, useGoogleSearch, useGoogleMaps } = activeChat.groundingOptions;

    let queryToUse = latestQuery.content;
    let elasticResults: ElasticResult[] = [];

    // 1. Rewrite Query if using Cloud source
    if (useCloud) {
        try {
            const modelToUse = MODELS.find(m => m.id === selectedModel)?.model || MODELS[0].model;
            queryToUse = await rewriteQuery(latestQuery.content, modelToUse);
            console.log("Rewritten Query:", queryToUse);
        } catch (rewriteError) {
             console.error("Query rewrite failed:", rewriteError);
             // Proceed with the original query if rewrite fails
        }
    }

    // 2. Perform Search (Cloud and/or Preloaded)
    if (useCloud || usePreloaded) {
      elasticResults = await searchElastic(queryToUse);
      console.log("Elastic/Preloaded Results:", elasticResults);
      // Update the placeholder message with the retrieved sources
      updateLastMessageInActiveChat(msg => ({ ...msg, elasticSources: elasticResults }));
    }

    // 3. Decide Generation Strategy
    const modelToUse = MODELS.find(m => m.id === selectedModel)?.model || MODELS[0].model;
    const shouldFallbackToWeb = elasticResults.length === 0 && (useGoogleSearch || useGoogleMaps);

    try {
        if (shouldFallbackToWeb) {
            // --- Fallback to Web/Maps Grounding ---
            console.log("No Elastic/Preloaded results, falling back to Gemini grounding (Search/Maps)");
            const effectiveGroundingOptions = { ...activeChat.groundingOptions, useGoogleSearch, useGoogleMaps };
             updateLastMessageInActiveChat(msg => ({
                ...msg,
                responseType: useGoogleMaps ? ResponseType.GOOGLE_MAPS : ResponseType.GOOGLE_SEARCH // Set type
            }));

            const responseStream = await streamAiResponse(currentMessages, [], modelToUse, effectiveGroundingOptions, location);

            let accumulatedText = '';
            let allGroundingChunks: any[] = []; // Collect grounding chunks from API response

            for await (const chunk of responseStream) {
                const chunkText = chunk.text(); // Use text() method for Gemini Stream
                accumulatedText += chunkText;
                updateLastMessageInActiveChat(msg => ({ ...msg, content: accumulatedText }));

                // Extract grounding metadata if available (adjust based on actual Gemini API response structure)
                const metadata = chunk.candidates?.[0]?.groundingMetadata;
                if (metadata?.groundingAttributions) {
                     // Map attributions to your GroundingChunk format
                     const newChunks = metadata.groundingAttributions.map((attr: any) => {
                          if (attr.web) return { web: { uri: attr.web.uri, title: attr.web.title } };
                          // Add mapping for maps if the structure is known
                          // if (attr.maps) return { maps: { ... } };
                          return null;
                     }).filter(Boolean); // Filter out nulls
                     allGroundingChunks.push(...newChunks);
                 }
            }
             // Deduplicate and set final grounding chunks
             const uniqueChunks = Array.from(new Map(allGroundingChunks.map(item => [item.web?.uri || item.maps?.uri, item])).values());
             updateLastMessageInActiveChat(msg => ({ ...msg, groundingChunks: uniqueChunks }));

        } else if (elasticResults.length > 0 || useGoogleSearch || useGoogleMaps) {
            // --- Generate using Elastic/Preloaded Context (and potentially Web/Maps) ---
            console.log("Generating response using retrieved Elastic/Preloaded context.");
             updateLastMessageInActiveChat(msg => ({ ...msg, responseType: ResponseType.RAG })); // Ensure RAG type

            // Pass Elastic results to streamAiResponse. It will combine them with user query.
            // If useGoogleSearch/Maps is also true, streamAiResponse should handle adding those tools.
            const responseStream = await streamAiResponse(currentMessages, elasticResults, modelToUse, activeChat.groundingOptions, location);

            let accumulatedText = '';
            // Grounding chunks from Gemini API might still appear if Search/Maps were enabled *alongside* Elastic
            let allApiGroundingChunks: any[] = [];

            for await (const chunk of responseStream) {
                const chunkText = chunk.text();
                accumulatedText += chunkText;
                updateLastMessageInActiveChat(msg => ({ ...msg, content: accumulatedText }));

                 // Extract grounding metadata if available (e.g., if Google Search was also used)
                 const metadata = chunk.candidates?.[0]?.groundingMetadata;
                 if (metadata?.groundingAttributions) {
                     const newChunks = metadata.groundingAttributions.map((attr: any) => {
                          if (attr.web) return { web: { uri: attr.web.uri, title: attr.web.title } };
                          // if (attr.maps) return { maps: { ... } };
                          return null;
                     }).filter(Boolean);
                     allApiGroundingChunks.push(...newChunks);
                 }
            }
             // Set API grounding chunks if any were found
             if (allApiGroundingChunks.length > 0) {
                 const uniqueApiChunks = Array.from(new Map(allApiGroundingChunks.map(item => [item.web?.uri || item.maps?.uri, item])).values());
                 updateLastMessageInActiveChat(msg => ({ ...msg, groundingChunks: uniqueApiChunks }));
             }

        } else {
             // --- No Context Found and No Web Fallback ---
            console.log("No relevant context found from any source.");
            updateLastMessageInActiveChat(msg => ({
                ...msg,
                content: "I couldn't find any relevant information in the available sources to answer your question.",
                responseType: ResponseType.ERROR // Indicate inability to answer
            }));
        }
    } catch (error) {
         console.error('Error during AI response generation:', error);
         const errorMsg = error instanceof Error ? error.message : "An unknown error occurred.";
         updateLastMessageInActiveChat(msg => ({
             ...msg,
             content: `Sorry, I encountered an error while generating the response: ${errorMsg}`,
             responseType: ResponseType.ERROR
         }));
    }
  };

  const handleChitChat = async (currentMessages: ChatMessage[]) => {
    addMessageToActiveChat({
      role: MessageRole.MODEL,
      content: '', // Start empty
      responseType: ResponseType.CHIT_CHAT,
      modelId: selectedModel
    });
    try {
        const modelToUse = MODELS.find(m => m.id === selectedModel)?.model || MODELS[0].model;
        const responseStream = await streamChitChatResponse(currentMessages, modelToUse);
        let accumulatedText = '';
        for await (const chunk of responseStream) {
            // Adjust depending on actual stream response structure
            const chunkText = chunk.text(); // Assuming text() method exists
            accumulatedText += chunkText;
            updateLastMessageInActiveChat(msg => ({ ...msg, content: accumulatedText }));
        }
    } catch (error) {
        console.error('Error during ChitChat response:', error);
        const errorMsg = error instanceof Error ? error.message : "An unknown error occurred.";
        updateLastMessageInActiveChat(msg => ({
             ...msg,
             content: `Sorry, I encountered an error: ${errorMsg}`,
             responseType: ResponseType.ERROR
         }));
    }
  };

  const handleCodeGeneration = async (currentMessages: ChatMessage[]) => {
    addMessageToActiveChat({
      role: MessageRole.MODEL,
      content: 'Analyzing files and preparing suggestion...', // Initial placeholder
      responseType: ResponseType.CODE_GENERATION,
      modelId: selectedModel
    });

    const latestQuery = currentMessages[currentMessages.length - 1].content;
    let searchResults: ElasticResult[] = [];

    // Search only cloud documents for code generation context for now
    if (activeChat?.groundingOptions.useCloud) {
         searchResults = await searchElastic(latestQuery); // Use rewritten or original query? Consider consistency.
    } else {
         updateLastMessageInActiveChat(msg => ({ ...msg, content: "Code generation requires a connection to the cloud data source.", responseType: ResponseType.ERROR }));
         return;
    }

    // Filter for editable files based on extension
    const editableSearchResults = searchResults.filter(r => {
        const extension = r.source.fileName.split('.').pop()?.toLowerCase();
        return extension && EDITABLE_EXTENSIONS.includes(extension);
    });

    if (editableSearchResults.length === 0) {
        updateLastMessageInActiveChat(msg => ({ ...msg, content: "I couldn't find any relevant editable files (like source code, markdown, etc.) based on your request. I can only suggest edits for text-based files." , responseType: ResponseType.ERROR}));
        return;
    }

    try {
        const modelToUse = MODELS.find(m => m.id === selectedModel)?.model || MODELS[0].model;
        const responseStream = await streamCodeGenerationResponse(currentMessages, editableSearchResults, modelToUse);
        let responseJsonText = '';
        for await (const chunk of responseStream) {
            responseJsonText += chunk.text(); // Assuming text() method
        }

        // Attempt to parse the complete JSON response
        const responseObject = JSON.parse(responseJsonText);

        if (responseObject.error) {
            throw new Error(responseObject.error); // Handle errors reported by the model
        }

        if (!responseObject.filePath || !responseObject.newContent || !responseObject.thought) {
             throw new Error("Received incomplete or invalid JSON structure for code suggestion.");
        }

        // Find the corresponding source file from *all* available files (cloud, preloaded, drive)
        const fullPath = responseObject.filePath;
        const file = allFiles.find(f => `${f.path}/${f.fileName}` === fullPath || f.fileName === fullPath); // Match full path or just filename as fallback

        if (!file) {
            throw new Error(`The model suggested editing a file I couldn't find: ${fullPath}`);
        }

        // Fetch original content to create the suggestion diff
        const originalContent = await getFileContent(file);
        if (originalContent === null || originalContent.startsWith('Error:')) {
            throw new Error(`Could not fetch original content for ${file.fileName}. Cannot create suggestion.`);
        }

        const suggestion: CodeSuggestion = {
            file,
            thought: responseObject.thought,
            originalContent,
            suggestedContent: responseObject.newContent,
            status: 'pending',
        };

        // Update the message to show the suggestion
        updateLastMessageInActiveChat(msg => ({
            ...msg,
            content: `I have a suggestion for \`file:${file.fileName}\`. Thought: "${suggestion.thought}"`, // Use backticks for file mention
            suggestion // Attach the suggestion object
        }));

    } catch (e) {
        console.error("Code generation processing error:", e);
        const errorMessage = e instanceof Error ? e.message : "Sorry, I couldn't generate the code edit correctly.";
        updateLastMessageInActiveChat(msg => ({ ...msg, content: errorMessage, responseType: ResponseType.ERROR }));
    }
  };


  const handleSendMessage = useCallback(async (query: string, attachment?: Attachment) => {
    if ((!query.trim() && !attachment) || isLoading || !activeChat) return; // Prevent empty sends
    setIsLoading(true);
    setApiError(null); // Clear previous errors

    const userMessage: ChatMessage = { role: MessageRole.USER, content: query, attachment };
    // Add user message and update title if it's the first message
    updateActiveChat(chat => ({
      ...chat,
      messages: [...chat.messages, userMessage],
      // Update title only if it's still "New Chat" or similar placeholder
      title: chat.messages.length === 0 && query.trim() ? query.substring(0, 40) + (query.length > 40 ? '...' : '') : chat.title
    }));

    // Use the state *after* adding the user message
    const currentMessages = [...messages, userMessage];

    try {
      const { useCloud, usePreloaded, useGoogleSearch, useGoogleMaps } = activeChat.groundingOptions;
      // Determine if *any* grounding source (including attachments) is active
      const isGrounded = useCloud || usePreloaded || useGoogleSearch || useGoogleMaps || !!attachment;

      if (isGrounded) {
          const modelToUse = MODELS.find(m => m.id === selectedModel)?.model || MODELS[0].model;
          // Classify intent based on query text only
          const intent = await classifyIntent(query, modelToUse);

          if (intent === Intent.GENERATE_CODE && isCodeGenerationEnabled) {
              await handleCodeGeneration(currentMessages);
          } else if (intent === Intent.CHIT_CHAT && !attachment) {
               // Only treat as chit-chat if no attachment and no grounding explicitly needed
               // If web search is on, might still prefer RAG route even for chit-chat like queries
              if (useGoogleSearch && !useCloud && !usePreloaded) {
                await handleQueryDocuments(currentMessages); // Use RAG if only web search is on
              } else {
                 await handleChitChat(currentMessages);
              }
          } else {
              // Default to RAG if intent is query, unknown, or if code-gen is disabled, or if there's an attachment
              await handleQueryDocuments(currentMessages);
          }
      } else {
        // No grounding sources enabled and no attachment -> Chit-chat
        await handleChitChat(currentMessages);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      const errorMessageContent = error instanceof Error ? error.message : "An unknown error occurred.";
      // Add a new error message instead of updating the last one (which doesn't exist yet)
      addMessageToActiveChat({
           role: MessageRole.MODEL,
           content: `Sorry, I encountered an error processing your request: ${errorMessageContent}`,
           responseType: ResponseType.ERROR
      });
    } finally {
      setIsLoading(false);
    }
  // Include 'messages' in dependency array as currentMessages relies on it
  }, [isLoading, activeChat, messages, selectedModel, isCodeGenerationEnabled, updateActiveChat, location, allFiles, getFileContent]);


  const handleConnectDataSource = useCallback(async (files: File[], dataSource: DataSource) => {
    setIsLoading(true);
    setIsDataSourceModalVisible(false);
    setApiError(null);
    try {
        // Show immediate feedback
        const tempChatTitle = dataSource.name || `Processing ${files.length} file(s)...`;
         const tempChat: Chat = {
            id: `chat_temp_${Date.now()}`,
            title: tempChatTitle,
            messages: [{ role: MessageRole.SYSTEM, content: `Processing ${files.length} file(s)...` }],
            createdAt: Date.now(),
            dataSource,
            dataset: [],
            groundingOptions: { useCloud: false, usePreloaded: true, useGoogleSearch: false, useGoogleMaps: false },
        };
        setChats(prev => [tempChat, ...prev]);
        setActiveChatId(tempChat.id);


        const newDataset = await createDatasetFromSources(files);
        console.log("handleConnectDataSource: newDataset created with", newDataset.length, "entries");

        // Replace temporary chat with the real one
        const finalChat: Chat = {
          ...tempChat,
          id: `chat_${Date.now()}`, // Generate final ID
          title: dataSource.name, // Use final name
          messages: [], // Start with empty messages
          dataset: newDataset,
          groundingOptions: { // Set grounding options for preloaded data
            useCloud: false, // Turn off cloud by default when loading local files
            usePreloaded: true,
            useGoogleSearch: false,
            useGoogleMaps: false,
          },
        };
        setChats(prev => [finalChat, ...prev.filter(c => c.id !== tempChat.id)]);
        setActiveChatId(finalChat.id);
        setEditedFiles(new Map()); // Clear edits
        setCloudSearchError(null); // Clear errors
        setIsCodeGenerationEnabled(false); // Disable code gen for local files

    } catch (error) {
        console.error("Error processing data source:", error);
        setApiError(error instanceof Error ? error.message : "An unknown error occurred while processing files.");
        // Consider removing the temporary chat on error or displaying the error within it
         setChats(prev => prev.filter(c => !c.id.startsWith('chat_temp_')));
         // Optionally, create a new empty chat after error
         handleNewChat();
    } finally {
        setIsLoading(false);
    }
  }, [handleNewChat]); // Include handleNewChat dependency


  const handleConnectGoogleDrive = useCallback((driveFiles: DriveFile[], dataSource: DataSource) => {
    // This function creates the chat immediately. File fetching happens via getFileContent later.
    setIsDataSourceModalVisible(false);
    setShowGoogleDrivePicker(false);
    setApiError(null);

    const newChat: Chat = {
      id: `chat_drive_${Date.now()}`,
      title: dataSource.name || "Google Drive Files",
      messages: [],
      createdAt: Date.now(),
      dataSource: dataSource, // Store the Drive data source info
      dataset: [], // Client-side dataset is not used for Drive files directly
      groundingOptions: {
        useCloud: false, // Disable cloud search by default for Drive chat
        usePreloaded: false, // Disable preloaded search (we fetch Drive content on demand)
        useGoogleSearch: false,
        useGoogleMaps: false,
        // Potentially add a specific flag like useGoogleDrive: true if needed
      },
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    setEditedFiles(new Map());
    setCloudSearchError(null);
    setIsCodeGenerationEnabled(false); // Cannot edit Drive files directly
  }, []);

  const handleExportToSheets = useCallback(async (tableData: (string | null)[][]) => {
     setApiError(null);
    if (!tableData || tableData.length === 0) {
        setApiError("No table data found to export.");
        return;
    }
    try {
      const response = await fetch('/api/sheets/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Include credentials if your backend requires auth for this endpoint
        },
        body: JSON.stringify({ tableData }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to export to Google Sheets (${response.status}): ${errorText}`);
      }
      const data = await response.json();
      if (data.sheetUrl) {
          window.open(data.sheetUrl, '_blank', 'noopener,noreferrer'); // Open in new tab securely
      } else {
           throw new Error("API response did not include a sheet URL.");
      }
    } catch (error) {
      console.error("Export to Sheets error:", error);
      setApiError(error instanceof Error ? error.message : 'Could not export to Google Sheets.');
    }
  }, []);


  const handleSuggestionAction = useCallback(async (messageIndex: number, action: 'accepted' | 'rejected') => {
      if (!activeChat) return;
      const message = messages[messageIndex];
      if (!message?.suggestion) return; // Ensure suggestion exists

      const updatedSuggestion = { ...message.suggestion, status: action };

      // Update the suggestion status within the specific message
      updateActiveChat(chat => ({
        ...chat,
        messages: chat.messages.map((msg, index) =>
            index === messageIndex ? { ...msg, suggestion: updatedSuggestion } : msg)
      }));

      let followUpContent = '';
      let editedFileSource: Source | undefined = undefined;

      if (action === 'accepted') {
          const { file, originalContent, suggestedContent } = message.suggestion;
          let updateSuccess = false;

           // Determine if the file is preloaded or cloud and attempt update
           if (activeChat.dataSource && activeChat.dataSource.type !== 'drive' && activeChat.groundingOptions.usePreloaded) {
              // --- Update Preloaded (Client-side) ---
               const { success, newDataset } = updateFileContent(file, suggestedContent, activeChat.dataset);
               if (success) {
                  updateActiveChat(c => ({...c, dataset: newDataset}));
                  updateSuccess = true;
               } else {
                  console.error(`Failed to apply accepted suggestion to preloaded file: ${file.fileName}`);
                  followUpContent = `Sorry, I failed to apply the changes to the preloaded file \`file:${file.fileName}\`. Could not find it in the current dataset.`;
               }
           } else if (activeChat.groundingOptions.useCloud) {
                // --- Update Cloud (Backend - Placeholder) ---
                // This requires a backend API endpoint to handle file updates.
                // For now, we simulate success locally but warn that backend update is needed.
                console.warn("Simulating acceptance for cloud file. Backend update endpoint is required for persistence.");
                // To make it appear edited locally:
                 updateSuccess = true; // Assume success for UI update
                 // Add to editedFiles map even without backend persistence for this demo
           } else {
                // Cannot update (e.g., Google Drive source)
                 followUpContent = `Cannot automatically apply changes to files from source type '${activeChat.dataSource?.type || 'unknown'}'. Please apply the changes manually if needed.`;
           }

          // If update was successful (or simulated), update edited files map and set follow-up
          if (updateSuccess) {
              setEditedFiles(prev => new Map(prev).set(file.id, {
                  file: file,
                  originalContent: prev.get(file.id)?.originalContent ?? originalContent, // Keep original original
                  currentContent: suggestedContent
              }));
              editedFileSource = file; // Set the source for the follow-up message pill
              followUpContent = `Great! I've applied the changes to \`file:${file.fileName}\`.`;
          }

      } else { // Action was 'rejected'
          followUpContent = "Okay, I've discarded the suggested changes.";
      }

      // Add the follow-up message from the model
       if (followUpContent) {
          addMessageToActiveChat({
              role: MessageRole.MODEL,
              content: followUpContent,
              editedFile: editedFileSource, // Attach source if edit was applied
              responseType: action === 'accepted' && editedFileSource ? ResponseType.CODE_GENERATION : ResponseType.CHIT_CHAT // Adjust type
          });
       }

  }, [messages, activeChat, updateActiveChat]);


  // Handler for opening the *full* file viewer (triggered by file tree, "Show Full Doc" button)
  const handleSelectFile = useCallback(async (file: Source) => {
    setSelectedFile(file);
    setSelectedFileContent('Loading...');
    setIsFileSearchVisible(false);
    setIsEditedFilesVisible(false);
    setChunkViewerData(null); // Close chunk viewer
    setDiffViewerRecord(null); // Close diff viewer

    // Check if the file has been edited first
    const editedRecord = editedFiles.get(file.id);
    if (editedRecord) {
        // If edited, show the *current* edited content in the viewer
        setSelectedFileContent(editedRecord.currentContent);
    } else {
        // If not edited, fetch original content
        try {
            const content = await getFileContent(file);
            // Handle potential error strings returned by getFileContent
            if (typeof content === 'string' && content.startsWith('Error:')) {
                setSelectedFileContent(content); // Show the error in the viewer
            } else {
                 setSelectedFileContent(content ?? 'Could not load file content.');
            }
        } catch (error) {
             const message = error instanceof Error ? error.message : 'Unknown error';
             setSelectedFileContent(`Error loading file: ${message}`);
             console.error(`Error in handleSelectFile for ${file.fileName}:`, error);
        }
    }
  }, [editedFiles, getFileContent]); // Add getFileContent dependency


  // --- Viewer Toggles & Handlers ---
  const handleShowChunk = useCallback((result: ElasticResult) => {
    setChunkViewerData(result);
    setSelectedFile(null);
    setDiffViewerRecord(null);
    setIsFileSearchVisible(false);
    setIsEditedFilesVisible(false);
  }, []);

  const handleCloseChunkViewer = useCallback(() => setChunkViewerData(null), []);
  const handleViewDiff = useCallback((record: EditedFileRecord) => {
        setDiffViewerRecord(record);
        setSelectedFile(null); // Close other viewers
        setChunkViewerData(null);
        setIsFileSearchVisible(false);
        setIsEditedFilesVisible(false);
  }, []);
  const handleCloseDiffViewer = useCallback(() => setDiffViewerRecord(null), []);
  const handleCloseFileViewer = useCallback(() => { setSelectedFile(null); setSelectedFileContent(''); }, []);
  const handleToggleSidebar = useCallback(() => setIsSidebarOpen(prev => !prev), []);
  const handleToggleDataSourceModal = useCallback(() => {
        setShowGoogleDrivePicker(false); // Reset GDrive view when opening normally
        setIsDataSourceModalVisible(prev => !prev);
  }, []);

  const handleToggleFileSearch = useCallback(() => {
    setIsFileSearchVisible(prev => {
      const isOpening = !prev;
      if (isOpening) {
          setIsEditedFilesVisible(false); // Close other panels
          setChunkViewerData(null);
          setSelectedFile(null);
          setDiffViewerRecord(null);
      }
      return isOpening;
    });
  }, []);

  const handleToggleEditedFiles = useCallback(() => {
    setIsEditedFilesVisible(prev => {
      const isOpening = !prev;
      if (isOpening) {
           setIsFileSearchVisible(false); // Close other panels
           setChunkViewerData(null);
           setSelectedFile(null);
           setDiffViewerRecord(null);
      }
      return isOpening;
    });
  }, []);

   const handleGroundingOptionsChange = useCallback((options: GroundingOptions) => {
      updateActiveChat(chat => ({ ...chat, groundingOptions: options }));
  }, [updateActiveChat]);


  // --- Render ---
  return (
    <div className={`flex flex-col h-screen font-sans transition-colors duration-300 bg-white dark:bg-slate-900 text-gray-800 dark:text-gray-200`}>
      <Header
        onToggleFileSearch={handleToggleFileSearch}
        onToggleEditedFiles={handleToggleEditedFiles}
        onToggleSidebar={handleToggleSidebar}
        onConnectDataSource={handleToggleDataSourceModal}
        theme={theme}
        setTheme={setTheme}
        activeDataSource={activeChat?.dataSource ?? null}
      />
      <div className="flex-1 flex overflow-hidden relative">
        {/* Chat History Sidebar */}
        <ChatHistory
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={(id) => {
              setActiveChatId(id);
              // Clear viewers when switching chats
              setSelectedFile(null);
              setDiffViewerRecord(null);
              setChunkViewerData(null);
              // Optionally clear editedFiles map or load persisted edits for the selected chat
              setEditedFiles(new Map()); // Simple: clear edits on chat switch
          }}
          onNewChat={handleNewChat}
          setChats={setChats}
          isOpen={isSidebarOpen}
          files={allFiles} // Pass files relevant to the active chat
          onSelectFile={handleSelectFile} // File tree clicks open full viewer
          activeDataSource={activeChat?.dataSource ?? null}
        />

        {/* Main Chat Area */}
        <main className="flex-1 overflow-hidden transition-all duration-300">
           <ErrorBoundary>
              <ChatInterface
                messages={messages}
                isLoading={isLoading}
                onSendMessage={handleSendMessage}
                onSelectSourceChunk={handleShowChunk} // Pass handler for citations/pills -> chunk viewer
                onSelectSource={handleSelectFile} // Pass handler for "Show Full Document" -> full viewer
                onSuggestionAction={handleSuggestionAction}
                onExportToSheets={handleExportToSheets}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                activeDataSource={activeChat?.dataSource}
                onConnectDataSource={handleToggleDataSourceModal}
                isCodeGenerationEnabled={isCodeGenerationEnabled}
                onToggleCodeGeneration={() => setIsCodeGenerationEnabled(prev => !prev)} // Simplified toggle
                groundingOptions={activeChat?.groundingOptions}
                onGroundingOptionsChange={handleGroundingOptionsChange}
                apiError={apiError}
                cloudSearchError={cloudSearchError}
              />
           </ErrorBoundary>
        </main>

        {/* Slide-out Panels */}
        <div className={`absolute top-0 right-0 h-full w-full md:w-80 lg:w-96 z-20 bg-white/80 dark:bg-slate-950/70 backdrop-blur-md shadow-lg transition-transform duration-300 ease-in-out ${isFileSearchVisible ? 'translate-x-0' : 'translate-x-full'}`}>
          <FileSearch files={allFiles} onClose={handleToggleFileSearch} onSelectFile={handleSelectFile}/>
        </div>

        <div className={`absolute top-0 right-0 h-full w-full md:w-80 lg:w-96 z-20 bg-white/80 dark:bg-slate-950/70 backdrop-blur-md shadow-lg transition-transform duration-300 ease-in-out ${isEditedFilesVisible ? 'translate-x-0' : 'translate-x-full'}`}>
          <EditedFilesViewer
            editedFiles={Array.from(editedFiles.values())}
            onClose={handleToggleEditedFiles}
            onSelectFile={handleViewDiff} // Opens diff viewer
          />
        </div>

        {/* Modals */}
        {selectedFile && <FileViewer file={selectedFile} content={selectedFileContent} onClose={handleCloseFileViewer} />}
        {diffViewerRecord && <DiffViewerModal record={diffViewerRecord} onClose={handleCloseDiffViewer} />}
        {isDataSourceModalVisible &&
          <DataSourceModal
            onClose={handleToggleDataSourceModal}
            onConnect={handleConnectDataSource}
            showGoogleDrivePicker={showGoogleDrivePicker}
            onConnectGoogleDrive={handleConnectGoogleDrive}
          />}
        {/* Render Chunk Viewer Modal */}
        {chunkViewerData && (
            <ChunkViewerModal
                result={chunkViewerData}
                onClose={handleCloseChunkViewer}
                onShowFullDocument={handleSelectFile} // Connect button to full file viewer handler
            />
        )}
      </div>
    </div>
  );
};

export default App;

