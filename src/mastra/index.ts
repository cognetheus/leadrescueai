import { Mastra } from '@mastra/core/mastra';
import { getConfig } from '../config/env';
import { mastraOptions } from './create-mastra';
import { buildApiRoutes } from './routes';

const config = getConfig();

export const mastra = new Mastra({
  ...mastraOptions({ config }),
  server: {
    port: 4111,
    host: 'localhost',
    apiRoutes: buildApiRoutes(),
  },
  bundler: {
    externals: ['better-sqlite3'],
  },
});
