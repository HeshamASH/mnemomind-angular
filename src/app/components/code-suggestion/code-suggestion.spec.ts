import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CodeSuggestion } from './code-suggestion';

describe('CodeSuggestion', () => {
  let component: CodeSuggestion;
  let fixture: ComponentFixture<CodeSuggestion>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CodeSuggestion]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CodeSuggestion);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
