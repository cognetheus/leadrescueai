import { Mastra } from '@mastra/core/mastra';
import { getConfig } from '../config/env';
import { mastraOptions } from './create-mastra';

const config = getConfig();

export const mastra = new Mastra({
  ...mastraOptions({ config }),
  server: {
    port: 4111,
    host: 'localhost',
  },
  bundler: {
    externals: ['better-sqlite3'],
  },
});
