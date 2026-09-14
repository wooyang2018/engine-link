import * as fs from 'fs';
import * as path from 'path';

export const ENGINE_LINK_VERSION = '0.2.1';

const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const bundlePath = path.resolve(__filename);

export async function getRuntimeIdentity(): Promise<Record<string, unknown>> {
  const stat = await fs.promises.stat(bundlePath).catch(() => undefined);
  return {
    version: ENGINE_LINK_VERSION,
    serverPid: process.pid,
    processStartedAt,
    bundlePath,
    bundleModifiedAt: stat?.mtime.toISOString() ?? null,
  };
}
