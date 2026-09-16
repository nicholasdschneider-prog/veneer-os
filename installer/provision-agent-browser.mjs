#!/usr/bin/env node
import path from 'node:path';
import { provisionManagedAgentBrowser } from './agent-browser.mjs';

const serviceHome = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!serviceHome) {
  console.error('Usage: provision-agent-browser.mjs SERVICE_HOME');
  process.exit(2);
}

provisionManagedAgentBrowser({
  serviceHome,
  installSystemDependencies: true,
  npmBin: '/usr/bin/npm',
});
