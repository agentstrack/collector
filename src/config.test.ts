import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configWarnings } from './config.js';

describe('configWarnings', () => {
  it('names unknown keys by path, so a typo in a privacy control is visible', () => {
    expect(
      configWarnings({ privacy: { mod: 'metadata', excluded_project: ['~/x'] }, tracking: {}, colour: 'red' }),
    ).toEqual([
      "unknown config key 'privacy.mod' is ignored",
      "unknown config key 'privacy.excluded_project' is ignored",
      "unknown config key 'colour' is ignored",
    ]);
  });

  it('is quiet for a config saveConfig wrote', async () => {
    const { Config } = await import('./config.js');
    expect(configWarnings(Config.parse({ api_key: 'k' }))).toEqual([]);
  });

  it('flags process_metrics: false as having no effect', () => {
    expect(configWarnings({ tracking: { process_metrics: false } })).toEqual([
      "'tracking.process_metrics' is deprecated and has no effect",
    ]);
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const loadFrom = async (yaml: string) => {
    const home = mkdtempSync(join(tmpdir(), 'agentstrack-config-'));
    writeFileSync(join(home, 'config.yaml'), yaml);
    vi.stubEnv('AGENTSTRACK_HOME', home);
    vi.resetModules();
    const { loadConfig } = await import('./config.js');
    return loadConfig;
  };

  it('reports validation errors as path: message lines, not a JSON dump', async () => {
    const loadConfig = await loadFrom('privacy:\n  mode: everything\nupload:\n  batch_size: 0\n');
    let message = '';
    try {
      loadConfig();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\n {2}privacy\.mode: .+/);
    expect(message).toMatch(/\n {2}upload\.batch_size: .+/);
    expect(message).not.toContain('[');
  });

  it('still loads a config with unknown keys, warning once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadConfig = await loadFrom('privacy:\n  mode: metadata\n  mod: full\n');
    expect(loadConfig().privacy.mode).toBe('metadata');
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("'privacy.mod'");
  });
});
