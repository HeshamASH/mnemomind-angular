import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ElasticResult, Source } from '../types';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private apiUrl = '/api';

  constructor(private http: HttpClient) { }

  searchDocuments(query: string): Observable<ElasticResult[]> {
    return this.http.post<ElasticResult[]>(`${this.apiUrl}/search`, { query });
  }

  getAllFiles(): Observable<Source[]> {
    return this.http.get<Source[]>(`${this.apiUrl}/files`);
  }

  getFileContent(fileId: string): Observable<{ content: string }> {
    return this.http.get<{ content: string }>(`${this.apiUrl}/files/${encodeURIComponent(fileId)}`);
  }
}
