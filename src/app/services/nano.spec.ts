import { TestBed } from '@angular/core/testing';

import { Nano } from './nano';

describe('Nano', () => {
  let service: Nano;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Nano);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
