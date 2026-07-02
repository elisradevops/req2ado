import { configSchema } from '../src/config/config.schema';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://req2ado:req2ado@localhost:5432/req2ado',
  REDIS_URL: 'redis://localhost:6379',
  MCP_URL: 'http://localhost:4100',
  MCP_BEARER: 'test-bearer',
  AUTH_JWT_SECRET: 'test-jwt-secret',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_CHAT_MODEL: 'llama3.1',
  LLM_PROXY_BEARER: 'test-llm-proxy-bearer',
};

describe('configSchema LLM fields', () => {
  it('parses valid LLM config with defaults for optional fields', () => {
    const result = configSchema.parse(BASE_ENV);
    expect(result.LLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(result.LLM_CHAT_MODEL).toBe('llama3.1');
    expect(result.LLM_TRUSTED_LOCAL).toBe(false);
    expect(result.LLM_PROXY_BEARER).toBe('test-llm-proxy-bearer');
  });

  it('rejects missing LLM_BASE_URL', () => {
    const { LLM_BASE_URL, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('rejects missing LLM_PROXY_BEARER', () => {
    const { LLM_PROXY_BEARER, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('coerces LLM_TRUSTED_LOCAL=true from a string env value', () => {
    const result = configSchema.parse({ ...BASE_ENV, LLM_TRUSTED_LOCAL: 'true' });
    expect(result.LLM_TRUSTED_LOCAL).toBe(true);
  });

  it('parses LLM_TRUSTED_LOCAL=false as boolean false, not true', () => {
    const result = configSchema.parse({ ...BASE_ENV, LLM_TRUSTED_LOCAL: 'false' });
    expect(result.LLM_TRUSTED_LOCAL).toBe(false);
  });
});
