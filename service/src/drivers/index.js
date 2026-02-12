// Driver registry — maps agent type strings to driver constructors.

export { BaseDriver } from './BaseDriver.js';
export { ClaudeDriver } from './ClaudeDriver.js';
export { CodexDriver } from './CodexDriver.js';

import { ClaudeDriver } from './ClaudeDriver.js';
import { CodexDriver } from './CodexDriver.js';

const DRIVER_MAP = {
  claude: ClaudeDriver,
  codex: CodexDriver,
};

/**
 * Create a driver instance for the given agent type.
 * @param {string} type — 'claude', 'codex', etc.
 * @returns {BaseDriver}
 */
export function createDriver(type) {
  const DriverClass = DRIVER_MAP[type];
  if (!DriverClass) {
    throw new Error(`Unknown agent type: "${type}". Available: ${Object.keys(DRIVER_MAP).join(', ')}`);
  }
  return new DriverClass();
}

/**
 * Get list of supported agent types.
 * @returns {string[]}
 */
export function getSupportedTypes() {
  return Object.keys(DRIVER_MAP);
}
