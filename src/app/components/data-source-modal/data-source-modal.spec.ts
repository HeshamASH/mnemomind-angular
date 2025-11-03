import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DataSourceModal } from './data-source-modal';

describe('DataSourceModal', () => {
  let component: DataSourceModal;
  let fixture: ComponentFixture<DataSourceModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DataSourceModal]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DataSourceModal);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
