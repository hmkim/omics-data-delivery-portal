import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setConfig } from '../config';

afterEach(() => cleanup());

setConfig({
  region: 'ap-northeast-2',
  accountId: '111111111111',
  userPoolId: 'ap-northeast-2_TEST',
  clientId: 'testclientid',
  apiBase: '/api',
  dataBucket: 'genome-portal-data-111111111111-ap-northeast-2',
  cfDomain: 'd111111abcdef8.cloudfront.net',
  splitThresholdBytes: 1_073_741_824,
  singleObjectLimitBytes: 50_000_000_000,
  mfaMode: 'REQUIRED',
  brand: { name: 'Genome Data Portal', logoUrl: '/brand/logo.svg', primaryColor: '#0B5FFF' },
});
