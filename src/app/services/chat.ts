import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest, of } from 'rxjs';
import { map, switchMap, catchError, tap, finalize } from 'rxjs/operators';
import { Chat, ChatMessage, ElasticResult, Intent, MessageRole } from '../types';
import { ApiService } from './api';
import { AiService } from './ai';

const HISTORY_KEY = 'angular-codemind-state';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly chats$ = new BehaviorSubject<Chat[]>([]);
  private readonly activeChatId$ = new BehaviorSubject<string | null>(null);
  private readonly isLoading$ = new BehaviorSubject<boolean>(false);
  private readonly apiError$ = new BehaviorSubject<string | null>(null);

  public readonly allChats$: Observable<Chat[]> = this.chats$.asObservable();
  public readonly activeChatId$: Observable<string | null> = this.activeChatId$.asObservable();
  public readonly isLoading$: Observable<boolean> = this.isLoading$.asObservable();
  public readonly apiError$: Observable<string | null> = this.apiError$.asObservable();

  public readonly activeChat$: Observable<Chat | null> = combineLatest([
    this.allChats$,
    this.activeChatId$
  ]).pipe(
    map(([chats, activeId]) => chats.find(chat => chat.id === activeId) || null)
  );

  constructor(private apiService: ApiService, private aiService: AiService) {
    this.loadState();
  }

  private loadState() {
    try {
      const savedState = localStorage.getItem(HISTORY_KEY);
      if (savedState) {
        const { chats, activeChatId } = JSON.parse(savedState);
        this.chats$.next(chats || []);
        this.activeChatId$.next(activeChatId || null);
      }
    } catch (error) {
      console.error('Failed to load state from localStorage', error);
    }
  }

  private saveState() {
    const state = {
      chats: this.chats$.getValue(),
      activeChatId: this.activeChatId$.getValue()
    };
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save state to localStorage', error);
    }
  }

  public newChat() {
    const newChat: Chat = {
      id: `chat_${Date.now()}`,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      dataSource: null,
      dataset: [],
      groundingOptions: {
        useCloud: true,
        usePreloaded: false,
        useGoogleSearch: false,
        useGoogleMaps: false,
      },
    };
    const updatedChats = [newChat, ...this.chats$.getValue()];
    this.chats$.next(updatedChats);
    this.activeChatId$.next(newChat.id);
    this.saveState();
  }

  public setActiveChat(chatId: string | null) {
    this.activeChatId$.next(chatId);
    this.saveState();
  }

  private addMessageToActiveChat(message: ChatMessage) {
    const activeId = this.activeChatId$.getValue();
    if (!activeId) return;

    const updatedChats = this.chats$.getValue().map(chat => {
      if (chat.id === activeId) {
        return {
          ...chat,
          messages: [...chat.messages, message],
          title: chat.messages.length === 0 ? message.content.substring(0, 30) : chat.title
        };
      }
      return chat;
    });
    this.chats$.next(updatedChats);
    this.saveState();
  }

  private updateLastMessageInActiveChat(updater: (message: ChatMessage) => ChatMessage) {
    const activeId = this.activeChatId$.getValue();
    if (!activeId) return;

    const updatedChats = this.chats$.getValue().map(chat => {
      if (chat.id === activeId) {
        const lastIndex = chat.messages.length - 1;
        if (lastIndex < 0) return chat;

        const updatedMessages = chat.messages.map((msg, index) =>
            index === lastIndex ? updater(msg) : msg
        );
        return { ...chat, messages: updatedMessages };
      }
      return chat;
    });
    this.chats$.next(updatedChats);
  }

  public sendMessage(query: string) {
    if (!query.trim()) return;

    this.isLoading$.next(true);
    this.apiError$.next(null);

    const userMessage: ChatMessage = { role: MessageRole.USER, content: query };
    this.addMessageToActiveChat(userMessage);

    const activeChat = this.chats$.getValue().find(c => c.id === this.activeChatId$.getValue());
    if (!activeChat) {
        this.isLoading$.next(false);
        return;
    }

    const isGrounded = activeChat.groundingOptions.useCloud || activeChat.groundingOptions.usePreloaded;

    this.aiService.classifyIntent(query).pipe(
      switchMap(intent => {
        if (!isGrounded && intent !== Intent.CHIT_CHAT) {
          intent = Intent.CHIT_CHAT;
        }

        switch (intent) {
          case Intent.CHIT_CHAT:
            return this.handleChitChat(activeChat.messages);
          case Intent.QUERY_DOCUMENTS:
            return this.handleQueryDocuments(activeChat, query);
          default:
            return this.handleQueryDocuments(activeChat, query);
        }
      }),
      catchError(error => {
        console.error('Message handling failed:', error);
        this.apiError$.next('Failed to get a response from the AI.');
        const errorMessage: ChatMessage = {
          role: MessageRole.MODEL,
          content: 'Sorry, I encountered an error during processing.'
        };
        this.addMessageToActiveChat(errorMessage);
        return of(null);
      }),
      finalize(() => {
        this.isLoading$.next(false);
        this.saveState();
      })
    ).subscribe();
  }

  private handleChitChat(history: ChatMessage[]): Observable<any> {
    this.addMessageToActiveChat({ role: MessageRole.MODEL, content: '' });
    const response: ChatMessage = { role: MessageRole.MODEL, content: "This is a chit-chat response."};
    this.updateLastMessageInActiveChat(() => response);
    return of(response);
  }

  private handleQueryDocuments(chat: Chat, query: string): Observable<any> {
    this.addMessageToActiveChat({ role: MessageRole.MODEL, content: '', sources: [] });

    return this.aiService.rewriteQueryForSearch(query).pipe(
      switchMap(rewrittenQuery => this.apiService.searchDocuments(rewrittenQuery)),
      tap(results => {
        this.updateLastMessageInActiveChat(msg => ({ ...msg, sources: results }));
      }),
      switchMap(results => {
        if (results.length === 0) {
          this.updateLastMessageInActiveChat(msg => ({...msg, content: "I couldn't find any relevant information."}));
          return of(null);
        }
        const summary = `Found ${results.length} relevant documents.`;
        this.updateLastMessageInActiveChat(msg => ({...msg, content: summary}));
        return of(results);
      })
    );
  }
}
