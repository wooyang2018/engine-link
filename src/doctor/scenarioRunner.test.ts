import { describe, expect, it } from 'vitest';
import { executeDoctorScenario, normalizeDoctorInjection } from './scenarioRunner';
import type { DoctorScenarioSpec } from './types';
import type { McpToolOutput, UnrealMcpGateway } from './unrealMcpClient';

describe('Doctor scenario input protocol', () => {
  it('normalizes single, repeat, duration, and Axis2D input', () => {
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Jump', value: true })).toMatchObject({ count: 1, release: false, valueType: 'Boolean' });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Move', repeat: 20, interval_ms: 16 })).toMatchObject({ count: 20, release: true, intervalMs: 16 });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Move', duration_ms: 32, intervalMs: 16 })).toMatchObject({ count: 2, release: true });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Look', value: { type: 'Axis2D', x: 1, y: -1 } })).toMatchObject({ valueType: 'Axis2D', value: { x: 1, y: -1, z: 0 } });
  });

  it('rejects mutually exclusive and bounded parameters', () => {
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', repeat: 2, durationMs: 20 })).toThrow('mutually exclusive');
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', repeat: 10_001 })).toThrow('10000');
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', durationMs: 300_001 })).toThrow('300000');
  });

  it('reports planned/actual injection counts and releases repeated input', async () => {
    const gateway = new ScenarioGateway();
    const result = await executeDoctorScenario(gateway, scenario([
      { action: 'start_pie' },
      { action: 'inject_action', path: '/Game/IA_Jump', value: true },
      { action: 'inject_action', path: '/Game/IA_Move', value: 1, repeat: 3, intervalMs: 0 },
      { action: 'inject_action', path: '/Game/IA_Look', value: { type: 'Axis2D', x: 1, y: 1 }, durationMs: 32, intervalMs: 16 },
    ]), new AbortController().signal, 'D:/Game', async () => undefined);
    expect(result.status).toBe('passed');
    const injections = (result.evidence?.injections as Array<Record<string, unknown>>);
    expect(injections.map((item) => [item.plannedCount, item.actualCount, item.released])).toEqual([[1, 1, false], [3, 3, true], [2, 2, true]]);
    expect(gateway.injected).toBe(8); // six requested ticks plus two zero-value releases
    expect(result.evidence?.teardown).toMatchObject({ succeeded: true });
  });

  it('releases active input when PIE stops during injection', async () => {
    const gateway = new ScenarioGateway();
    gateway.failSecondSegment = true;
    const result = await executeDoctorScenario(gateway, scenario([
      { action: 'start_pie' },
      { action: 'inject_action', path: '/Game/IA_Move', repeat: 101, intervalMs: 0 },
    ]), new AbortController().signal, 'D:/Game', async () => undefined);
    expect(result.status).toBe('failed');
    expect(gateway.emergencyReleases).toBe(1);
    expect(result.evidence?.teardown).toMatchObject({ succeeded: true });
  });

  it('runs high-level assertions and preserves detailed failure evidence', async () => {
    const gateway = new ScenarioGateway();
    gateway.samples.push(
      { localPlayers: 1, location: { x: 0, y: 0, z: 0 }, actorRotation: { pitch: 0, yaw: 0, roll: 0 }, controlRotation: { pitch: 0, yaw: 0, roll: 0 } },
      { localPlayers: 1, location: { x: 20, y: 0, z: 0 }, actorRotation: { pitch: 0, yaw: 5, roll: 0 }, controlRotation: { pitch: 1, yaw: 10, roll: 0 } },
      { localPlayers: 1, location: { x: 20, y: 0, z: 0 } },
    );
    const result = await executeDoctorScenario(gateway, scenario([
      { action: 'start_pie' },
      { action: 'snapshot_player', name: 'before' },
      { action: 'snapshot_player', name: 'after' },
      { action: 'actor_location_changed', from: 'before', to: 'after', minDistance: 100 },
    ]), new AbortController().signal, 'D:/Game', async () => undefined);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('actor_location_changed assertion failed');
    expect(result.error).toContain('/Game/Map/Test');
    expect(result.evidence?.assertions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'actor_location_changed', passed: false })]));
    expect(result.evidence?.teardown).toMatchObject({ attempted: true, succeeded: true });
  });
});

class ScenarioGateway implements UnrealMcpGateway {
  injected = 0;
  emergencyReleases = 0;
  failSecondSegment = false;
  samples: Array<Record<string, unknown>> = [];
  private segments = 0;
  async listTools() { return ['execute_python_code']; }
  async close() {}
  async call(_name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
    const code = String(args.code ?? '');
    let value: Record<string, unknown> = {};
    if (code.includes('WorkflowService.run_scenario')) {
      this.segments++;
      const match = code.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
      if (match) {
        const spec = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as DoctorScenarioSpec;
        this.injected += spec.steps.filter((step) => step.action === 'inject_action').length;
      }
      value = { scenarioId: `segment-${this.segments}` };
    } else if (code.includes('get_scenario')) {
      value = this.failSecondSegment && this.segments === 2
        ? { status: 'failed', passed: false, error: 'PIE stopped' }
        : { status: 'passed', passed: true, captures: [] };
    } else if (code.includes('start_run')) value = { runId: 'run-1' };
    else if (code.includes('snapshot=json.loads')) value = { succeeded: true };
    else if (code.includes('IsPIERunning')) value = { pieRunning: true };
    else if (code.includes('snapshot={')) value = { map: '/Game/Old', clients: 2, backgroundThrottling: true };
    else if (code.includes('players = [')) value = this.samples.shift() ?? {
      localPlayers: 1, mappingContextApplied: true, mappingContainsAction: true, mappingContainsKey: true,
      enhancedInputComponent: true, gameplayTags: [], cameraPitchLimits: { min: -60, max: 60 },
      location: { x: 0, y: 0, z: 0 }, actorRotation: { pitch: 0, yaw: 0, roll: 0 }, controlRotation: { pitch: 0, yaw: 0, roll: 0 },
    };
    else if (code.includes('unreal.InputService.inject_action')) { this.emergencyReleases++; value = { released: true }; }
    else value = { success: true };
    return { text: `ENGINELINK_DOCTOR_RESULT=${JSON.stringify(value)}`, content: [], isError: false };
  }
}

function scenario(steps: Array<Record<string, unknown>>): DoctorScenarioSpec {
  return { schema: 'enginelink.doctor-scenario.v1', name: 'input', map: '/Game/Map/Test', clients: 1, steps };
}
