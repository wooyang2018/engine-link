import * as path from 'path';
import * as fs from 'fs';
import type { DoctorScenarioResult, DoctorScenarioSpec } from './types';
import type { McpToolOutput, UnrealMcpGateway } from './unrealMcpClient';
import { DoctorEvidenceConflictError, DoctorEvidenceError, resolveDoctorEvidence } from './evidence';
import { parseJsonValue } from '../parsers/safeJson';

interface InjectionRecord {
  action: string;
  clientIndex: number;
  valueType: 'Boolean' | 'Axis1D' | 'Axis2D' | 'Axis3D';
  value: { x: number; y: number; z: number };
  plannedCount: number;
  actualCount: number;
  intervalMs: number;
  startedAt: string;
  endedAt?: string;
  releaseRequested: boolean;
  released: boolean;
  target?: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
  error?: string;
}

interface ScenarioEvidence extends Record<string, unknown> {
  map: string;
  requestedClients: number;
  localPlayers?: unknown;
  snapshots: Record<string, Record<string, unknown>>;
  injections: InjectionRecord[];
  assertions: Array<Record<string, unknown>>;
  segments: Array<Record<string, unknown>>;
  captures: string[];
  teardown: Record<string, unknown>;
  parseErrors?: string[];
  rawResponses?: unknown[];
}

export async function executeDoctorScenario(
  gateway: UnrealMcpGateway,
  spec: DoctorScenarioSpec,
  signal: AbortSignal,
  projectRoot: string,
  heartbeatCheck: () => Promise<void> = () => assertScenarioHeartbeat(projectRoot),
): Promise<DoctorScenarioResult> {
  (heartbeatCheck as unknown as { projectRoot: string }).projectRoot = projectRoot;
  const evidence: ScenarioEvidence = {
    map: spec.map, requestedClients: spec.clients, snapshots: {}, injections: [], assertions: [],
    segments: [], captures: [], teardown: { attempted: false, succeeded: false },
  };
  const activeActions = new Map<string, InjectionRecord>();
  let snapshot: Record<string, unknown> | undefined;
  let pieOwned = false;
  let vibeRunId = '';
  let result: DoctorScenarioResult;
  try {
    validateScenarioLimits(spec);
    await heartbeatCheck();
    snapshot = await setup(gateway, spec);
    await heartbeatCheck();
    vibeRunId = await startRun(gateway, spec.name);
    const native: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (!native.length) return;
      const steps = native.splice(0);
      const report = await runNativeSegment(gateway, spec, steps, signal, heartbeatCheck);
      if (steps.some((step) => step.action === 'start_pie')) pieOwned = true;
      evidence.segments.push(report);
      evidence.captures.push(...artifactPaths(report.captures, projectRoot));
    };

    const steps = [...spec.steps];
    if (!steps.some((step) => step.action === 'wait_for_local_players')) {
      const index = Math.max(steps.findIndex((step) => step.action === 'wait_for_pie'), steps.findIndex((step) => step.action === 'start_pie'));
      steps.splice(index + 1, 0, { action: 'wait_for_local_players', count: spec.clients, timeoutMs: 20_000 });
    }
    if (!steps.some((step) => step.action === 'capture_game')) steps.push({ action: 'capture_game', name: 'final' });
    for (const step of steps) {
      throwIfCancelled(signal);
      if (step.action === 'inject_action') {
        await flush();
        await injectAction(gateway, spec, step, evidence, activeActions, signal, heartbeatCheck);
      } else if (isHostAction(step.action)) {
        await flush();
        await runHostAction(gateway, step, evidence, signal, heartbeatCheck);
      } else {
        native.push(step);
      }
    }
    await flush();
    await finishRun(gateway, vibeRunId, 'succeeded', `EngineLink Doctor scenario ${spec.name} passed`);
    result = { name: spec.name, status: 'passed', map: spec.map, clients: spec.clients, evidence, artifacts: evidence.captures };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (vibeRunId) await finishRun(gateway, vibeRunId, 'failed', message).catch(() => undefined);
    const unavailable = error instanceof DoctorEvidenceError || /\b(?:MCP|timed out|heartbeat|wedged|unavailable|connection)\b/i.test(message);
    result = {
      name: spec.name,
      status: signal.aborted ? 'cancelled' : unavailable ? 'incomplete' : 'failed',
      map: spec.map, clients: spec.clients, evidence, artifacts: evidence.captures, error: message,
    };
    if (error instanceof DoctorEvidenceError) {
      evidence.parseErrors = [error.message];
      if (error.raw !== undefined) evidence.rawResponses = [error.raw];
    }
  } finally {
    evidence.teardown = await teardown(gateway, snapshot, [...activeActions.values()], pieOwned, heartbeatCheck);
    if (evidence.teardown.succeeded !== true) {
      result!.status = signal.aborted ? 'cancelled' : result!.status === 'incomplete' ? 'incomplete' : 'failed';
      result!.error = `${result!.error ? `${result!.error}; ` : ''}teardown failed: ${String(evidence.teardown.error ?? 'unknown error')}`;
    }
  }
  return result!;
}

function validateScenarioLimits(spec: DoctorScenarioSpec): void {
  if (!spec.map.startsWith('/Game/')) throw new Error(`Scenario map must be a /Game asset path: ${spec.map}`);
  if (!Number.isInteger(spec.clients) || spec.clients < 1 || spec.clients > 16) throw new Error('Scenario clients must be between 1 and 16.');
  for (const step of spec.steps) {
    if (step.action === 'inject_action') normalizeDoctorInjection(step, spec.clients);
    else if (isTargetedHostAction(step.action)) normalizeClientIndex(step, spec.clients);
  }
}

function isHostAction(action: unknown): boolean {
  return ['wait_for_local_players', 'snapshot_player', 'actor_location_changed', 'actor_rotation_changed',
    'control_rotation_changed', 'control_rotation_unchanged', 'control_rotation_in_range', 'player_camera_pitch_limits', 'input_action_bound',
    'gameplay_tag_present', 'gameplay_tag_absent'].includes(String(action));
}

function isTargetedHostAction(action: unknown): boolean {
  return isHostAction(action) && action !== 'wait_for_local_players';
}

async function injectAction(
  gateway: UnrealMcpGateway, spec: DoctorScenarioSpec, step: Record<string, unknown>, evidence: ScenarioEvidence,
  active: Map<string, InjectionRecord>, signal: AbortSignal, heartbeatCheck: () => Promise<void>,
): Promise<void> {
  const normalized = normalizeDoctorInjection(step, spec.clients);
  if ((normalized.count > 1 || normalized.durationMs !== undefined) && !await isPieRunning(gateway)) {
    throw new Error('Repeated or duration inject_action requires a running PIE session.');
  }
  const record: InjectionRecord = {
    action: normalized.path, clientIndex: normalized.clientIndex, valueType: normalized.valueType, value: normalized.value,
    plannedCount: normalized.count, actualCount: 0, intervalMs: normalized.intervalMs,
    startedAt: new Date().toISOString(), releaseRequested: normalized.release, released: false, attempts: [],
  };
  evidence.injections.push(record);
  active.set(`${record.clientIndex}:${record.action}`, record);
  try {
    for (let index = 0; index < normalized.count; index++) {
      throwIfCancelled(signal);
      const attemptedAt = new Date().toISOString();
      try {
        const injected = await injectActionOnce(gateway, normalized.path, normalized.value, normalized.clientIndex, heartbeatCheck);
        record.target = isRecord(injected.target) ? injected.target : record.target;
        record.attempts.push({ index, attemptedAt, ...injected });
        if (injected.success !== true) throw new Error(String(injected.error ?? 'Targeted input injection failed.'));
        record.actualCount++;
      } catch (error) {
        if (!record.attempts.some((item) => item.index === index)) {
          record.attempts.push({ index, attemptedAt, success: false, error: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
      if (normalized.intervalMs > 0 && index + 1 < normalized.count) await delay(normalized.intervalMs);
    }
    if (normalized.durationMs !== undefined) {
      const tailMs = Math.max(0, normalized.durationMs - Math.max(0, normalized.count - 1) * normalized.intervalMs);
      if (tailMs > 0) await delay(tailMs);
    }
    if (normalized.release) record.released = await releaseAction(gateway, normalized.path, normalized.clientIndex, signal, heartbeatCheck);
    active.delete(`${record.clientIndex}:${record.action}`);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    record.endedAt = new Date().toISOString();
  }
}

export function normalizeDoctorInjection(step: Record<string, unknown>, clients = 16) {
  const action = String(step.path ?? '');
  if (!action.startsWith('/Game/')) throw new Error('inject_action.path must be a /Game asset path.');
  const repeatValue = step.repeat;
  const durationValue = step.durationMs ?? step.duration_ms;
  if (repeatValue !== undefined && durationValue !== undefined) throw new Error('inject_action repeat and durationMs are mutually exclusive.');
  let intervalMs = numberInRange(step.intervalMs ?? step.interval_ms ?? 16, 'intervalMs', 0, 60_000);
  const durationMs = durationValue === undefined ? undefined : numberInRange(durationValue, 'durationMs', 1, 300_000);
  const repeat = repeatValue === undefined ? undefined : integerInRange(repeatValue, 'repeat', 1, 10_000);
  if (durationMs !== undefined) intervalMs = Math.max(1, intervalMs, Math.ceil(durationMs / 10_000));
  const count = durationMs === undefined ? repeat ?? 1 : Math.min(10_000, Math.max(1, Math.ceil(durationMs / intervalMs)));
  const value = normalizeActionValue(step.value, step.x, step.y, step.z);
  const release = typeof step.release === 'boolean' ? step.release : count > 1 || durationMs !== undefined;
  return { path: action, clientIndex: normalizeClientIndex(step, clients), intervalMs, durationMs, count, release, ...value };
}

function normalizeClientIndex(step: Record<string, unknown>, clients: number): number {
  return integerInRange(step.clientIndex ?? step.client_index ?? 0, 'clientIndex', 0, Math.max(0, clients - 1));
}

function normalizeActionValue(input: unknown, legacyX: unknown, legacyY: unknown, legacyZ: unknown) {
  let x = Number(legacyX ?? 1); let y = Number(legacyY ?? 0); let z = Number(legacyZ ?? 0);
  let explicitType = '';
  if (typeof input === 'boolean') { x = input ? 1 : 0; y = 0; z = 0; explicitType = 'Boolean'; }
  else if (typeof input === 'number') { x = input; y = 0; z = 0; explicitType = 'Axis1D'; }
  else if (isRecord(input)) {
    explicitType = String(input.type ?? '');
    if (typeof input.value === 'boolean') x = input.value ? 1 : 0;
    else if (typeof input.value === 'number') x = input.value;
    x = Number(input.x ?? x); y = Number(input.y ?? y); z = Number(input.z ?? z);
  }
  if (![x, y, z].every(Number.isFinite)) throw new Error('inject_action value components must be finite numbers.');
  const inferred = z !== 0 ? 'Axis3D' : y !== 0 ? 'Axis2D' : 'Axis1D';
  const valueType = (explicitType || inferred) as InjectionRecord['valueType'];
  if (!['Boolean', 'Axis1D', 'Axis2D', 'Axis3D'].includes(valueType)) throw new Error(`Unsupported inject_action value type: ${valueType}`);
  return { valueType, value: { x, y, z } };
}

async function runHostAction(gateway: UnrealMcpGateway, step: Record<string, unknown>, evidence: ScenarioEvidence, signal: AbortSignal, heartbeatCheck: () => Promise<void>): Promise<void> {
  const action = String(step.action);
  if (action === 'wait_for_local_players') {
    const expected = integerInRange(step.count ?? step.clients ?? 1, 'count', 1, 16);
    const deadline = Date.now() + numberInRange(step.timeoutMs ?? step.timeout_ms ?? 15_000, 'timeoutMs', 1, 300_000);
    for (;;) {
      throwIfCancelled(signal);
      const snapshot = await samplePlayer(gateway, step, heartbeatCheck);
      evidence.localPlayers = snapshot.localPlayers;
      if (Number(snapshot.localPlayers) === expected) return;
      if (Date.now() > deadline) throw assertionError(action, { expected, actual: snapshot.localPlayers, snapshot }, evidence);
      await delay(100);
    }
  }
  if (action === 'snapshot_player') {
    const name = String(step.name ?? 'default');
    evidence.snapshots[name] = await samplePlayer(gateway, step, heartbeatCheck);
    return;
  }
  let actual = await samplePlayer(gateway, step, heartbeatCheck);
  if (action === 'input_action_bound') {
    const deadline = Date.now() + numberInRange(step.timeoutMs ?? step.timeout_ms ?? 1, 'timeoutMs', 1, 300_000);
    while (!inputActionBound(actual) && Date.now() < deadline) {
      throwIfCancelled(signal);
      await delay(100);
      actual = await samplePlayer(gateway, step, heartbeatCheck);
    }
  }
  const from = evidence.snapshots[String(step.from ?? 'before')];
  const to = step.to ? evidence.snapshots[String(step.to)] : actual;
  let passed = false;
  let detail: Record<string, unknown> = { action, actual, from, to };
  if (action === 'actor_location_changed') passed = changedAmount(from?.location, to?.location, step.axis) >= Number(step.minDelta ?? step.min_delta ?? step.minDistance ?? step.min_distance ?? 1);
  else if (action === 'actor_rotation_changed') passed = changedAmount(from?.actorRotation, to?.actorRotation, step.axis) >= Number(step.minDegrees ?? step.min_degrees ?? 1);
  else if (action === 'control_rotation_changed') passed = changedAmount(from?.controlRotation, to?.controlRotation, step.axis) >= Number(step.minDegrees ?? step.min_degrees ?? 1);
  else if (action === 'control_rotation_unchanged') passed = changedAmount(from?.controlRotation, to?.controlRotation, step.axis) <= Number(step.maxDegrees ?? step.max_degrees ?? 0.01);
  else if (action === 'control_rotation_in_range') {
    const pitch = signedDegrees(component(to?.controlRotation, 'pitch'));
    passed = pitch >= Number(step.min) && pitch <= Number(step.max);
  } else if (action === 'player_camera_pitch_limits') {
    const limits = isRecord(actual.cameraPitchLimits) ? actual.cameraPitchLimits : {};
    passed = nearly(Number(limits.min), Number(step.min)) && nearly(Number(limits.max), Number(step.max));
  } else if (action === 'input_action_bound') {
    passed = inputActionBound(actual);
  } else if (action === 'gameplay_tag_present' || action === 'gameplay_tag_absent') {
    const present = Array.isArray(actual.gameplayTags) && actual.gameplayTags.map(String).includes(String(step.tag));
    passed = action === 'gameplay_tag_present' ? present : !present;
  }
  detail = { ...detail, passed };
  evidence.assertions.push(detail);
  if (!passed) throw assertionError(action, detail, evidence);
}

async function samplePlayer(gateway: UnrealMcpGateway, step: Record<string, unknown>, heartbeatCheck: () => Promise<void>): Promise<Record<string, unknown>> {
  await heartbeatCheck();
  const payload = Buffer.from(JSON.stringify({
    clientIndex: Number(step.clientIndex ?? step.client_index ?? 0), context: step.context, action: step.path ?? step.inputAction,
    key: step.key, tag: step.tag,
  }), 'utf8').toString('base64');
  const script = `import unreal, json, base64, re
request = json.loads(base64.b64decode("${payload}").decode("utf-8"))
${clientResolverPython()}
clients = enginelink_clients()
result = {"localPlayers":len(clients),"clients":[item["identity"] for item in clients]}
index = int(request.get("clientIndex", 0))
if index < len(clients):
    selected = clients[index]; player = selected["player"]; controller = selected["controller"]; pawn = controller.get_controlled_pawn() if controller else None
    result.update(selected["identity"])
    if pawn:
        loc = pawn.get_actor_location(); rot = pawn.get_actor_rotation()
        result["pawnClass"] = pawn.get_class().get_path_name()
        result["location"] = {"x":loc.x,"y":loc.y,"z":loc.z}; result["actorRotation"] = {"pitch":rot.pitch,"yaw":rot.yaw,"roll":rot.roll}
        component = pawn.get_component_by_class(unreal.EnhancedInputComponent); result["enhancedInputComponent"] = component is not None
        try:
            asc = pawn.get_component_by_class(unreal.AbilitySystemComponent); tags = asc.get_owned_gameplay_tags() if asc else None
            result["gameplayTags"] = [str(t) for t in tags.get_gameplay_tag_array()] if tags else []
        except Exception as exc: result["gameplayTagError"] = str(exc)
    if controller:
        cr = controller.get_control_rotation(); result["controlRotation"] = {"pitch":cr.pitch,"yaw":cr.yaw,"roll":cr.roll}
        camera = controller.player_camera_manager
        if camera: result["cameraPitchLimits"] = {"min":camera.view_pitch_min,"max":camera.view_pitch_max}
    context_path = request.get("context")
    if context_path:
        context = unreal.load_object(None, context_path); subsystem = selected["subsystem"]
        result["mappingContextApplied"] = bool(context and subsystem and subsystem.has_mapping_context(context))
        result["mappingContainsAction"] = False; result["mappingContainsKey"] = False
        if context:
            wanted_action = str(request.get("action") or "").split(".")[0]; wanted_key = str(request.get("key") or "")
            try:
                mapping_data = context.get_editor_property("DefaultKeyMappings")
                for mapping in mapping_data.get_editor_property("Mappings"):
                    action_path = mapping.get_editor_property("Action").get_path_name() if mapping.get_editor_property("Action") else ""
                    key_name = str(mapping.get_editor_property("Key").get_editor_property("KeyName"))
                    if action_path.split(".")[0] == wanted_action: result["mappingContainsAction"] = True
                    if action_path.split(".")[0] == wanted_action and wanted_key and wanted_key.lower() in key_name.lower(): result["mappingContainsKey"] = True
            except Exception as exc: result["mappingReadError"] = str(exc)
print("ENGINELINK_DOCTOR_RESULT=" + json.dumps(result, separators=(",",":"), default=str))`;
  return callEvidence<Record<string, unknown>>(await gateway.call('execute_python_code', { code: script }, { timeoutMs: 5_000, retry: false }), 'runtime player sample').value;
}

async function runNativeSegment(gateway: UnrealMcpGateway, spec: DoctorScenarioSpec, steps: Array<Record<string, unknown>>, signal: AbortSignal, heartbeatCheck: () => Promise<void>): Promise<Record<string, unknown>> {
  await heartbeatCheck();
  const segment = {
    schema: 'enginelink.doctor-scenario.v1', name: `${spec.name}-segment`, map: spec.map, clients: spec.clients, steps,
    ...(steps.some((step) => step.action === 'start_pie') && spec.preflight ? { preflight: spec.preflight } : {}),
    teardown: { stop_pie: false },
  };
  const encoded = Buffer.from(JSON.stringify(segment), 'utf8').toString('base64');
  const queued = callEvidence<Record<string, unknown>>(await gateway.call('execute_python_code', {
    code: `import unreal, json, base64\nspec=base64.b64decode("${encoded}").decode("utf-8")\nprint("ENGINELINK_DOCTOR_RESULT=" + unreal.WorkflowService.run_scenario(spec))`,
  }, { retry: false }), 'queue scenario segment').value;
  const id = String(queued.scenarioId ?? '');
  if (!id) throw new Error('VibeUE did not return a scenarioId.');
  const reportPath = resolveVibePath(String(queued.reportPath ?? ''), projectRootFromHeartbeat(heartbeatCheck));
  const deadline = Date.now() + (spec.timeoutSeconds ?? 90) * 1000;
  for (;;) {
    if (signal.aborted) {
      await cancelSegment(gateway, id).catch(() => undefined);
      throwIfCancelled(signal);
    }
    if (Date.now() > deadline) { await cancelSegment(gateway, id).catch(() => undefined); throw new Error(`Scenario segment '${id}' timed out.`); }
    let report: Record<string, unknown>;
    try {
      await heartbeatCheck();
      report = await getSegment(gateway, id, reportPath);
    } catch (error) {
      const persisted = reportPath ? await readPersistedReport(reportPath) : undefined;
      if (!persisted || persisted.status === 'running') {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${persisted ? ` Persisted scenario status: ${JSON.stringify(persisted)}` : ''}`);
      }
      report = persisted;
    }
    if (report.status !== 'running') {
      if (report.status !== 'passed' || report.passed !== true) throw new Error(String(report.error ?? `Scenario segment ended with ${report.status}.`));
      return report;
    }
    await delay(100);
  }
}

async function getSegment(gateway: UnrealMcpGateway, id: string, reportPath?: string): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(id).toString('base64');
  const persisted = reportPath ? await readPersistedReport(reportPath) : undefined;
  const output = await gateway.call('execute_python_code', { code: `import unreal, base64\nid=base64.b64decode("${encoded}").decode("utf-8")\nprint("ENGINELINK_DOCTOR_RESULT=" + unreal.WorkflowService.get_scenario(id))` }, { timeoutMs: 5_000, retry: false });
  const evidence = resolveDoctorEvidence<Record<string, unknown>>(output, 'scenario segment result', persisted?.status === 'running' ? undefined : persisted);
  if (evidence.conflict) throw new DoctorEvidenceConflictError(`scenario segment result: ${evidence.conflict}`, output);
  return evidence.value;
}

async function isPieRunning(gateway: UnrealMcpGateway): Promise<boolean> {
  const output = await gateway.call('execute_python_code', {
    code: 'import unreal, json, vibeue\nprint("ENGINELINK_DOCTOR_RESULT="+json.dumps({"pieRunning":bool(vibeue.exec_tool("EditorToolset.EditorAppToolset","IsPIERunning"))},separators=(",",":")))',
  }, { timeoutMs: 5_000, retry: false });
  return callEvidence<Record<string, unknown>>(output, 'PIE input precondition').value.pieRunning === true;
}

async function injectActionOnce(
  gateway: UnrealMcpGateway,
  action: string,
  value: { x: number; y: number; z: number },
  clientIndex: number,
  heartbeatCheck: () => Promise<void>,
): Promise<Record<string, unknown>> {
  await heartbeatCheck();
  const encoded = Buffer.from(JSON.stringify({ action, value, clientIndex }), 'utf8').toString('base64');
  const code = `import unreal, json, base64, re
request=json.loads(base64.b64decode("${encoded}").decode("utf-8"))
${clientResolverPython()}
clients=enginelink_clients(); index=int(request.get("clientIndex",0)); result={"success":False,"clientIndex":index}
try:
    if index < 0 or index >= len(clients): raise RuntimeError("PIE clientIndex %d is unavailable; found %d interactive client window(s)" % (index,len(clients)))
    selected=clients[index]; action=unreal.load_object(None,request["action"])
    if not action: raise RuntimeError("Input Action not found: " + request["action"])
    value=request["value"]; selected["subsystem"].inject_input_vector_for_action(action,unreal.Vector(float(value["x"]),float(value["y"]),float(value["z"])),[],[])
    result={"success":True,"clientIndex":index,"returnValue":None,"target":selected["identity"]}
except Exception as exc: result={"success":False,"clientIndex":index,"error":str(exc),"availableClients":[item["identity"] for item in clients]}
print("ENGINELINK_DOCTOR_RESULT="+json.dumps(result,separators=(",",":"),default=str))`;
  return callEvidence<Record<string, unknown>>(
    await gateway.call('execute_python_code', { code }, { timeoutMs: 5_000, retry: false }),
    'targeted input injection',
  ).value;
}

async function cancelSegment(gateway: UnrealMcpGateway, id: string): Promise<void> {
  const encoded = Buffer.from(id).toString('base64');
  await gateway.call('execute_python_code', { code: `import unreal, base64\nid=base64.b64decode("${encoded}").decode("utf-8")\nprint("ENGINELINK_DOCTOR_RESULT=" + unreal.WorkflowService.cancel_scenario(id))` }, { timeoutMs: 5_000, retry: false });
}

async function releaseAction(gateway: UnrealMcpGateway, action: string, clientIndex: number, signal: AbortSignal | undefined, heartbeatCheck: () => Promise<void>): Promise<boolean> {
  if (signal) throwIfCancelled(signal);
  const released = await injectActionOnce(gateway, action, { x: 0, y: 0, z: 0 }, clientIndex, heartbeatCheck);
  if (released.success !== true) throw new Error(String(released.error ?? 'Targeted input release failed.'));
  return true;
}

async function setup(gateway: UnrealMcpGateway, spec: DoctorScenarioSpec): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(JSON.stringify({ map: spec.map, clients: spec.clients })).toString('base64');
  const code = `import unreal, json, base64, vibeue
request=json.loads(base64.b64decode("${encoded}").decode("utf-8"))
if vibeue.exec_tool("EditorToolset.EditorAppToolset","IsPIERunning"): raise RuntimeError("PIE is already running")
dirty=list(unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages())+list(unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages())
if dirty: raise RuntimeError("Dirty packages block scenario: " + ", ".join([p.get_path_name() for p in dirty]))
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world(); settings_class=unreal.load_class(None,"/Script/UnrealEd.LevelEditorPlaySettings")
settings=unreal.get_default_object(settings_class); throttle=json.loads(unreal.PerformanceService.get_background_throttling())
snapshot={"map":world.get_outermost().get_name() if world else "","clients":int(settings.get_editor_property("PlayNumberOfClients")),"backgroundThrottling":bool(throttle.get("throttling_enabled",True))}
if not unreal.EditorAssetLibrary.does_asset_exist(request["map"]): raise RuntimeError("Scenario map does not exist: " + request["map"])
if snapshot["map"] != request["map"] and not unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level(request["map"]): raise RuntimeError("Unable to load scenario map")
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world(); actual=world.get_outermost().get_name() if world else ""
if actual != request["map"]: raise RuntimeError("Scenario map mismatch: " + actual)
settings.set_editor_property("PlayNumberOfClients",int(request["clients"])); changed=json.loads(unreal.PerformanceService.set_background_throttling(False))
if not changed.get("success",False): raise RuntimeError(changed.get("error","Unable to disable throttling"))
print("ENGINELINK_DOCTOR_RESULT="+json.dumps(snapshot,separators=(",",":")))`;
  return callEvidence<Record<string, unknown>>(await gateway.call('execute_python_code', { code }, { timeoutMs: 15_000, retry: false }), 'scenario setup').value;
}

async function teardown(
  gateway: UnrealMcpGateway,
  snapshot: Record<string, unknown> | undefined,
  actions: InjectionRecord[],
  pieOwned: boolean,
  heartbeatCheck: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const releases: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const action of actions) {
    try {
      const released = await injectActionOnce(gateway, action.action, { x: 0, y: 0, z: 0 }, action.clientIndex, heartbeatCheck);
      action.released = released.success === true;
      releases.push({ action: action.action, clientIndex: action.clientIndex, released: action.released, target: released.target, error: released.error });
      if (!action.released) errors.push(`release ${action.action} on client ${action.clientIndex}: ${String(released.error ?? 'failed')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      releases.push({ action: action.action, clientIndex: action.clientIndex, released: false, error: message });
      errors.push(`release ${action.action} on client ${action.clientIndex}: ${message}`);
    }
  }

  const pieStop: Record<string, unknown> = { owned: pieOwned, requested: false, stopped: !pieOwned };
  if (pieOwned) {
    try {
      await heartbeatCheck();
      const output = await gateway.call('execute_python_code', {
        code: 'import unreal, json, vibeue\nrunning=bool(vibeue.exec_tool("EditorToolset.EditorAppToolset","IsPIERunning"))\nif running: vibeue.exec_tool("EditorToolset.EditorAppToolset","StopPIE")\nprint("ENGINELINK_DOCTOR_RESULT="+json.dumps({"requested":running},separators=(",",":")))',
      }, { timeoutMs: 5_000, retry: false });
      pieStop.requested = callEvidence<Record<string, unknown>>(output, 'request PIE teardown').value.requested === true;
      const deadline = Date.now() + 15_000;
      while (await isPieRunning(gateway)) {
        if (Date.now() >= deadline) throw new Error('PIE teardown did not complete within 15 seconds.');
        await delay(100);
        await heartbeatCheck();
      }
      pieStop.stopped = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pieStop.error = message;
      errors.push(`PIE stop: ${message}`);
    }
  }

  const environmentRestore: Record<string, unknown> = { attempted: snapshot !== undefined, succeeded: snapshot === undefined };
  if (snapshot) {
    try {
      const encoded = Buffer.from(JSON.stringify(snapshot)).toString('base64');
      const code = `import unreal, json, base64
snapshot=json.loads(base64.b64decode("${encoded}").decode("utf-8"))
settings_class=unreal.load_class(None,"/Script/UnrealEd.LevelEditorPlaySettings"); settings=unreal.get_default_object(settings_class)
if "clients" in snapshot: settings.set_editor_property("PlayNumberOfClients",int(snapshot["clients"]))
restored=json.loads(unreal.PerformanceService.set_background_throttling(bool(snapshot.get("backgroundThrottling",True))))
if not restored.get("success",False): raise RuntimeError(restored.get("error","Unable to restore throttling"))
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world(); current=world.get_outermost().get_name() if world else ""
if snapshot.get("map") and current != snapshot["map"] and not unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level(snapshot["map"]): raise RuntimeError("Unable to restore map")
print("ENGINELINK_DOCTOR_RESULT="+json.dumps({"succeeded":True,"map":snapshot.get("map"),"clients":snapshot.get("clients"),"backgroundThrottling":snapshot.get("backgroundThrottling")},separators=(",",":")))`;
      Object.assign(environmentRestore, callEvidence<Record<string, unknown>>(
        await gateway.call('execute_python_code', { code }, { timeoutMs: 15_000, retry: false }),
        'scenario environment restore',
      ).value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      environmentRestore.succeeded = false;
      environmentRestore.error = message;
      errors.push(`environment restore: ${message}`);
    }
  }
  return { attempted: true, succeeded: errors.length === 0, releases, pieStop, environmentRestore, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

async function assertScenarioHeartbeat(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'Saved', 'VibeUE', 'Signals');
  const files = (await fs.promises.readdir(directory).catch(() => [] as string[])).filter((file) => /^editor-\d+-health\.json$/.test(file));
  const candidates = await Promise.all(files.map(async (file) => {
    const fullPath = path.join(directory, file);
    const stat = await fs.promises.stat(fullPath);
    return { fullPath, modified: stat.mtimeMs };
  }));
  const newest = candidates.sort((a, b) => b.modified - a.modified)[0];
  if (!newest) throw new Error('VibeUE health heartbeat is missing during scenario execution.');
  const health = parseJsonValue<Record<string, unknown>>(await fs.promises.readFile(newest.fullPath), newest.fullPath);
  const ageMs = Date.now() - Date.parse(String(health.updatedUtc ?? ''));
  const stall = Number(health.gameThreadStallSeconds ?? 0);
  if (!Number.isFinite(ageMs) || ageMs > 15_000) throw new Error(`VibeUE heartbeat became stale during scenario execution (${Math.round(ageMs / 1000)}s).`);
  if (stall > 10) throw new Error(`Unreal Game Thread became wedged during scenario execution (${stall.toFixed(1)}s stall).`);
}

function projectRootFromHeartbeat(check: () => Promise<void>): string {
  return String((check as unknown as { projectRoot?: string }).projectRoot ?? '');
}

function resolveVibePath(value: string, projectRoot: string): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return path.normalize(value);
  const normalized = value.replace(/\\/g, '/');
  const saved = normalized.toLowerCase().indexOf('/saved/');
  return saved >= 0 && projectRoot ? path.join(projectRoot, normalized.slice(saved + 1)) : undefined;
}

async function readPersistedReport(file: string): Promise<Record<string, unknown> | undefined> {
  return fs.promises.readFile(file).then((buffer) => parseJsonValue<Record<string, unknown>>(buffer, file), () => undefined);
}

async function startRun(gateway: UnrealMcpGateway, name: string): Promise<string> {
  const encoded = Buffer.from(name).toString('base64');
  const output = await gateway.call('execute_python_code', { code: `import unreal, json, base64\nname=base64.b64decode("${encoded}").decode("utf-8")\nprint("ENGINELINK_DOCTOR_RESULT="+unreal.WorkflowService.start_run(name,json.dumps({"source":"EngineLink Doctor"})))` }, { timeoutMs: 5_000, retry: false });
  return String(callEvidence<Record<string, unknown>>(output, 'start VibeUE run').value.runId ?? '');
}

async function finishRun(gateway: UnrealMcpGateway, id: string, outcome: string, summary: string): Promise<void> {
  const encoded = Buffer.from(JSON.stringify({ id, outcome, summary })).toString('base64');
  await gateway.call('execute_python_code', { code: `import unreal, json, base64\nd=json.loads(base64.b64decode("${encoded}").decode("utf-8"))\nprint("ENGINELINK_DOCTOR_RESULT="+unreal.WorkflowService.finish_run(d["id"],d["outcome"],d["summary"]))` }, { retry: false });
}

function clientResolverPython(): string {
  return `def enginelink_clients():
    found=[]
    players=[player for player in unreal.ObjectIterator(unreal.LocalPlayer) if player.get_world() is not None]
    subsystems=[subsystem for subsystem in unreal.ObjectIterator(unreal.EnhancedInputLocalPlayerSubsystem) if subsystem.get_world() is not None]
    for world in unreal.ObjectIterator(unreal.World):
        package_name=world.get_outermost().get_name()
        match=re.search(r"(?:^|/)UEDPIE_(\\d+)_",package_name)
        if not match: continue
        controller=unreal.GameplayStatics.get_player_controller(world,0)
        if not controller or not controller.is_local_player_controller(): continue
        player=next((candidate for candidate in players if candidate.get_world()==world),None)
        subsystem=next((candidate for candidate in subsystems if candidate.get_world()==world),None)
        if not player or not subsystem: continue
        found.append({"pieInstanceId":int(match.group(1)),"world":world,"player":player,"controller":controller,"subsystem":subsystem})
    found.sort(key=lambda item:item["pieInstanceId"])
    for index,item in enumerate(found):
        pawn=item["controller"].get_controlled_pawn()
        item["identity"]={"clientIndex":index,"pieInstanceId":item["pieInstanceId"],"world":item["world"].get_path_name(),"localPlayer":item["player"].get_path_name(),"controller":item["controller"].get_path_name(),"pawn":pawn.get_path_name() if pawn else ""}
    return found`;
}

function callEvidence<T>(output: McpToolOutput, source: string) {
  if (output.isError) throw new Error(output.text || `${source} failed.`);
  const evidence = resolveDoctorEvidence<T>(output, source);
  if (evidence.conflict) throw new DoctorEvidenceConflictError(`${source}: ${evidence.conflict}`, output);
  return evidence;
}

function artifactPaths(value: unknown, projectRoot: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((capture) => resolveVibePath(capture, projectRoot) ?? path.resolve(projectRoot, capture));
}
function assertionError(action: string, detail: Record<string, unknown>, evidence: ScenarioEvidence): Error {
  return new Error(`${action} assertion failed: ${JSON.stringify({ map: evidence.map, localPlayers: evidence.localPlayers, pawns: detail.actual, injections: evidence.injections, detail })}`);
}
function vectorDistance(a: unknown, b: unknown): number {
  if (!isRecord(a) || !isRecord(b)) return Number.NaN;
  const keys = 'x' in a || 'x' in b ? ['x', 'y', 'z'] : ['pitch', 'yaw', 'roll'];
  return Math.sqrt(keys.reduce((sum, key) => sum + (Number(a[key] ?? 0) - Number(b[key] ?? 0)) ** 2, 0));
}
function changedAmount(a: unknown, b: unknown, axis: unknown): number {
  if (typeof axis === 'string' && isRecord(a) && isRecord(b)) return Math.abs(Number(b[axis.toLowerCase()]) - Number(a[axis.toLowerCase()]));
  return vectorDistance(a, b);
}
function component(value: unknown, key: string): number { return isRecord(value) ? Number(value[key]) : Number.NaN; }
function inputActionBound(value: Record<string, unknown>): boolean {
  return value.mappingContextApplied === true && value.mappingContainsAction === true && value.mappingContainsKey === true && value.enhancedInputComponent === true;
}
function signedDegrees(value: number): number { return Number.isFinite(value) ? ((value + 180) % 360 + 360) % 360 - 180 : value; }
function nearly(a: number, b: number): boolean { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.01; }
function numberInRange(value: unknown, name: string, min: number, max: number): number { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}.`); return number; }
function integerInRange(value: unknown, name: string, min: number, max: number): number { const number = numberInRange(value, name, min, max); if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`); return number; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('Doctor run cancelled.'); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
