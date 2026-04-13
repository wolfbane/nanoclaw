/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync } from 'child_process';
import path from 'path';

import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const image = 'nanoclaw-agent:latest';
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  // Validate Apple Container is available
  if (!commandExists('container')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: 'apple-container',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  // Build
  let buildOk = false;
  logger.info('Building container image');
  try {
    execSync(`container build -t ${image} .`, {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Container build succeeded');
  } catch (err) {
    logger.error({ err }, 'Container build failed');
  }

  // Test
  let testOk = false;
  if (buildOk) {
    logger.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | container run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      logger.info({ testOk }, 'Container test result');
    } catch {
      logger.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: 'apple-container',
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
