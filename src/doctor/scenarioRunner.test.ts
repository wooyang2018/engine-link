import { describe, expect, it } from 'vitest';
import { executeDoctorScenario, normalizeDoctorInjection } from './scenarioRunner';
import type { DoctorScenarioSpec } from './types';
import type { McpToolOutput, UnrealMcpGateway } from './unrealMcpClient';

describe('Doctor scenario input protocol', () => {
  it('normalizes single, repeat, duration, and Axis2D input', () => {
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Jump', value: true })).toMatchObject({ clientIndex: 0, count: 1, release: false, valueType: 'Boolean' });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Move', repeat: 20, interval_ms: 16 })).toMatchObject({ count: 20, release: true, intervalMs: 16 });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Move', duration_ms: 32, intervalMs: 16 })).toMatchObject({ count: 2, release: true });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Look', value: { type: 'Axis2D', x: 1, y: -1 } })).toMatchObject({ valueType: 'Axis2D', value: { x: 1, y: -1, z: 0 } });
    expect(normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA_Look', clientIndex: 1 }, 2)).toMatchObject({ clientIndex: 1 });
  });

  it('rejects mutually exclusive and bounded parameters', () => {
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', repeat: 2, durationMs: 20 })).toThrow('mutually exclusive');
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', repeat: 10_001 })).toThrow('10000');
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', durationMs: 300_001 })).toThrow('300000');
    expect(() => normalizeDoctorInjection({ action: 'inject_action', path: '/Game/IA', clientIndex: 2 }, 2)).toThrow('clientIndex');
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
    expect(injections[1].attempts).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0, success: true, target: expect.objectContaining({ clientIndex: 0 }) })]));
    expect(gateway.injected).toBe(8); // six requested ticks plus two zero-value releases
    expect(result.evidence?.teardown).toMatchObject({ succeeded: true, pieStop: { owned: true, requested: true, stopped: true } });
    expect(gateway.code.join('\n')).not.toContain('player.get_player_controller');
    expect(gateway.code.join('\n')).not.toContain('SubsystemBlueprintLibrary');
    expect(gateway.code.join('\n')).toContain('DefaultKeyMappings');
    expect(gateway.code.join('\n')).toContain('is_local_player_controller');
    expect(gateway.code.join('\n')).toContain('found.sort(key=lambda item:item["pieInstanceId"])');
    expect(gateway.nativeActions).not.toEqual(expect.arrayContaining(['wait_for_local_players', 'inject_action', 'snapshot_player']));
  });

  it('releases active input when PIE stops during injection', async () => {
    const gateway = new ScenarioGateway();
    gateway.failInjectionAt = 2;
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
    expect(gateway.nativeActions).toEqual(['start_pie']);
  });

  it('treats Unreal wrapped pitch values as signed degrees', async () => {
    const gateway = new ScenarioGateway();
    gateway.samples.push(
      { localPlayers: 1, controlRotation: { pitch: 335, yaw: 0, roll: 0 } },
    );
    const result = await executeDoctorScenario(gateway, scenario([
      { action: 'start_pie' },
      { action: 'control_rotation_in_range', clientIndex: 0, min: -60, max: 60 },
    ]), new AbortController().signal, 'D:/Game', async () => undefined);
    expect(result.status).toBe('passed');
  });

});

class ScenarioGateway implements UnrealMcpGateway {
  injected = 0;
  emergencyReleases = 0;
  failInjectionAt = 0;
  samples: Array<Record<string, unknown>> = [];
  code: string[] = [];
  nativeActions: string[] = [];
  private segments = 0;
  private running = false;
  private stopPollsRemaining = 0;
  async listTools() { return ['execute_python_code']; }
  async close() {}
  async call(_name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
    const code = String(args.code ?? '');
    this.code.push(code);
    let value: Record<string, unknown> = {};
    if (code.includes('WorkflowService.run_scenario')) {
      this.segments++;
      const match = code.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
      if (match) {
        const spec = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as DoctorScenarioSpec;
        this.nativeActions.push(...spec.steps.map((step) => String(step.action)));
        if (spec.steps.some((step) => step.action === 'start_pie')) this.running = true;
      }
      value = { scenarioId: `segment-${this.segments}` };
    } else if (code.includes('get_scenario')) {
      value = { status: 'passed', passed: true, captures: [] };
    } else if (code.includes('start_run')) value = { runId: 'run-1' };
    else if (code.includes('inject_input_vector_for_action')) {
      const request = decodeFirstPayload(code) as { value: { x: number }; clientIndex: number };
      this.injected++;
      if (request.value.x === 0) this.emergencyReleases++;
      value = this.failInjectionAt > 0 && this.injected === this.failInjectionAt
        ? { success: false, clientIndex: request.clientIndex, error: 'PIE stopped' }
        : { success: true, clientIndex: request.clientIndex, target: { clientIndex: request.clientIndex, pieInstanceId: request.clientIndex + 1, world: `/Game/Map/UEDPIE_${request.clientIndex + 1}_Test` } };
    } else if (code.includes('running=bool') && code.includes('StopPIE')) {
      value = { requested: this.running };
      this.stopPollsRemaining = this.running ? 1 : 0;
    } else if (code.includes('IsPIERunning')) {
      const reported = this.running;
      if (this.stopPollsRemaining > 0) {
        this.stopPollsRemaining--;
        if (this.stopPollsRemaining === 0) this.running = false;
      }
      value = { pieRunning: reported };
    } else if (code.includes('snapshot=json.loads')) value = { succeeded: true };
    else if (code.includes('dirty=list')) value = { map: '/Game/Old', clients: 2, backgroundThrottling: true };
    else if (code.includes('clients = enginelink_clients()')) value = this.samples.shift() ?? {
      localPlayers: 1, mappingContextApplied: true, mappingContainsAction: true, mappingContainsKey: true,
      enhancedInputComponent: true, gameplayTags: [], cameraPitchLimits: { min: -60, max: 60 },
      location: { x: 0, y: 0, z: 0 }, actorRotation: { pitch: 0, yaw: 0, roll: 0 }, controlRotation: { pitch: 0, yaw: 0, roll: 0 },
    };
    else value = { success: true };
    return { text: `ENGINELINK_DOCTOR_RESULT=${JSON.stringify(value)}`, content: [], isError: false };
  }
}

function decodeFirstPayload(code: string): unknown {
  const match = code.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
  return match ? JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) : {};
}

function scenario(steps: Array<Record<string, unknown>>): DoctorScenarioSpec {
  return { schema: 'enginelink.doctor-scenario.v1', name: 'input', map: '/Game/Map/Test', clients: 1, steps };
}
