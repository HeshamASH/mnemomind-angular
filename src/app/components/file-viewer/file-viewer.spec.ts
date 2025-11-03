import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FileViewer } from './file-viewer';

describe('FileViewer', () => {
  let component: FileViewer;
  let fixture: ComponentFixture<FileViewer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileViewer]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FileViewer);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
