import { EXPLICIT_BASE_URL, EXPLICIT_LOG_LEVEL, type ExplicitClientFields } from '@jevris/contracts';

const MODEL_PIN = /^jev-\d+\.\d+\.\d+$/;

function isPlainObject(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype;
}

function own(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function refused(): never {
  throw new Error('refused');
}

/**
 * Requires the four explicit client fields and returns only those fields.
 * Does not construct a client and does not read the environment.
 */
export function explicitClientConfig(input: object): ExplicitClientFields {
  if (!isPlainObject(input)) refused();
  const apiKey = own(input, 'apiKey');
  const baseURL = own(input, 'baseURL');
  const defaultModel = own(input, 'defaultModel');
  const logLevel = own(input, 'logLevel');
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.includes('\r') || apiKey.includes('\n') || apiKey.includes('\0')) {
    refused();
  }
  if (baseURL !== EXPLICIT_BASE_URL) refused();
  if (typeof defaultModel !== 'string' || !MODEL_PIN.test(defaultModel)) refused();
  if (logLevel !== EXPLICIT_LOG_LEVEL) refused();
  return {
    apiKey,
    baseURL: EXPLICIT_BASE_URL,
    defaultModel,
    logLevel: EXPLICIT_LOG_LEVEL,
  };
}
