import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DiffViewer } from './diff-viewer';

describe('DiffViewer', () => {
  let component: DiffViewer;
  let fixture: ComponentFixture<DiffViewer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiffViewer]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DiffViewer);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
