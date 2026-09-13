import { Buffer } from 'buffer';
import type { DoctorRule, UnrealScanResult } from './types';
import type { UnrealMcpGateway } from './unrealMcpClient';
import { DoctorEvidenceConflictError, resolveDoctorEvidence, type DoctorEvidence } from './evidence';

const RESULT_MARKER = 'ENGINELINK_DOCTOR_RESULT=';

export interface UnrealEvidenceResult<T> { data: T; evidence: DoctorEvidence<T>; raw: unknown }

export async function queryEditorState(gateway: UnrealMcpGateway): Promise<UnrealEvidenceResult<Record<string, unknown>>> {
  const result = await gateway.call('execute_python_code', { code: editorStateScript() });
  if (result.isError) throw new Error(result.text || 'Unreal editor state query failed.');
  return evidenceResult<Record<string, unknown>>(result, 'Unreal editor state');
}

export async function scanUnrealProject(
  gateway: UnrealMcpGateway,
  paths: string[],
  referenceQueries: string[],
  rules: DoctorRule[],
): Promise<UnrealEvidenceResult<UnrealScanResult>> {
  const input = Buffer.from(JSON.stringify({ paths, referenceQueries, rules }), 'utf8').toString('base64');
  const result = await gateway.call('execute_python_code', { code: scanScript(input) }, { timeoutMs: 120_000 });
  if (result.isError) throw new Error(result.text || 'Unreal project scan failed.');
  return evidenceResult<UnrealScanResult>(result, 'Unreal project scan');
}

function evidenceResult<T>(raw: Awaited<ReturnType<UnrealMcpGateway['call']>>, source: string): UnrealEvidenceResult<T> {
  const evidence = resolveDoctorEvidence<T>(raw, source);
  if (evidence.conflict) throw new DoctorEvidenceConflictError(`${source}: ${evidence.conflict}`, raw);
  return { data: evidence.value, evidence, raw };
}

function editorStateScript(): string {
  return `import unreal
import json
import vibeue

def _path(obj):
    if isinstance(obj, dict): return str(obj.get("refPath", obj.get("path", obj)))
    try: return obj.get_path_name()
    except Exception: return str(obj)

state = {"pieRunning": False, "currentMap": "", "dirtyPackages": [], "openAssets": []}
try:
    state["pieRunning"] = bool(vibeue.exec_tool("EditorToolset.EditorAppToolset", "IsPIERunning"))
except Exception:
    pass
try:
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    state["currentMap"] = world.get_outermost().get_name() if world else ""
except Exception as exc:
    state["mapError"] = str(exc)
try:
    state["dirtyPackages"] = [_path(p) for p in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages()]
    state["dirtyPackages"] += [_path(p) for p in unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages()]
except Exception as exc:
    state["dirtyPackagesError"] = str(exc)
try:
    state["openAssets"] = [_path(a) for a in vibeue.exec_tool("EditorToolset.EditorAppToolset", "GetOpenAssets")]
except Exception as exc:
    state["openAssetsError"] = str(exc)
try:
    env = json.loads(unreal.WorkflowService.get_environment())
    state["environment"] = {key: env.get(key) for key in ("schema", "projectFile", "engineRoot", "engineVersion", "editorPid", "vibeueVersion", "toolsetRegistryAvailable", "lastBuild")}
except Exception:
    state["environment"] = {}
print("${RESULT_MARKER}" + json.dumps(state, separators=(",", ":"), default=str))`;
}

function scanScript(encodedInput: string): string {
  return `import unreal
import json
import base64
import vibeue

request = json.loads(base64.b64decode("${encodedInput}").decode("utf-8"))
result = {"environment": {}, "editor": {}, "inventory": [], "references": [], "blueprints": [], "rules": []}

def _s(value):
    try: return str(value)
    except Exception: return ""

def _path(obj):
    try: return obj.get_path_name()
    except Exception: return _s(obj)

def _asset_path_from_file(value):
    normalized = value.replace("\\\\", "/")
    marker = "/Content/"
    if marker.lower() in normalized.lower():
        index = normalized.lower().index(marker.lower()) + len(marker)
        relative = normalized[index:]
        if relative.lower().endswith((".uasset", ".umap")): relative = relative.rsplit(".", 1)[0]
        return "/Game/" + relative
    if normalized.startswith("Content/"):
        relative = normalized[len("Content/"):]
        if relative.lower().endswith((".uasset", ".umap")): relative = relative.rsplit(".", 1)[0]
        return "/Game/" + relative
    return normalized.split(".")[0] if normalized.startswith("/Game/") else ""

try:
    env = json.loads(unreal.WorkflowService.get_environment())
    result["environment"] = {key: env.get(key) for key in ("schema", "projectFile", "engineRoot", "engineVersion", "editorPid", "vibeueVersion", "toolsetRegistryAvailable", "lastBuild")}
except Exception:
    pass

try:
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    result["editor"]["currentMap"] = world.get_outermost().get_name() if world else ""
except Exception as exc:
    result["editor"]["mapError"] = str(exc)
try:
    result["editor"]["pieRunning"] = bool(vibeue.exec_tool("EditorToolset.EditorAppToolset", "IsPIERunning"))
except Exception:
    result["editor"]["pieRunning"] = False

registry = unreal.AssetRegistryHelpers.get_asset_registry()
assets = list(registry.get_assets_by_path("/Game", recursive=True))
asset_by_path = {}
for data in assets:
    package_name = _s(data.package_name)
    class_name = _s(data.asset_class_path.asset_name) if hasattr(data, "asset_class_path") else _s(data.asset_class)
    result["inventory"].append({"path": package_name, "class": class_name})
    asset_by_path[package_name] = data

targets = set()
for value in request.get("paths", []) + request.get("referenceQueries", []):
    converted = _asset_path_from_file(value)
    if converted: targets.add(converted)
for rule in request.get("rules", []):
    params = rule.get("params", {})
    for key in ("asset", "from", "to"):
        value = params.get(key)
        if isinstance(value, str) and value.startswith("/Game/"): targets.add(value.split(".")[0])

def _dependencies(package_name):
    try: return [_s(x) for x in registry.get_dependencies(package_name)]
    except Exception: return []

def _referencers(package_name):
    try: return [_s(x) for x in registry.get_referencers(package_name)]
    except Exception:
        try: return [_s(x) for x in unreal.EditorAssetLibrary.find_package_referencers_for_asset(package_name, False)]
        except Exception: return []

expanded = set(targets)
for target in list(targets):
    for ref in _referencers(target):
        if ref.startswith("/Game/"): expanded.add(ref)
for target in sorted(expanded):
    for dep in _dependencies(target):
        if dep.startswith("/Game/"):
            result["references"].append({"from": target, "to": dep, "direction": "dependency", "resolved": dep in asset_by_path})
    for ref in _referencers(target):
        if ref.startswith("/Game/"):
            result["references"].append({"from": ref, "to": target, "direction": "referencer", "resolved": ref in asset_by_path})

def _blueprint_issues(asset_path):
    output = []
    try:
        info = unreal.BlueprintService.get_blueprint_info(asset_path)
        compile_status = "Unknown" if info else "LoadFailed"
    except Exception as exc:
        return "LoadFailed", [{"ruleId":"blueprint.load", "severity":"P1", "confidence":"confirmed", "evidence":str(exc)}]
    try:
        graphs = unreal.BlueprintService.list_graphs(asset_path)
        for graph_info in graphs:
            graph_name = _s(graph_info.graph_name)
            try:
                summary_result = unreal.BlueprintService.get_graph_summary(asset_path, graph_name)
                summary = summary_result[1] if isinstance(summary_result, tuple) and summary_result[0] else summary_result
                graph_status = _s(getattr(summary, "compile_status", ""))
                if graph_status: compile_status = graph_status
            except Exception:
                pass
            nodes = list(unreal.BlueprintService.get_nodes_in_graph(asset_path, graph_name, 0, "", True))
            connections = list(unreal.BlueprintService.get_connections(asset_path, graph_name))
            connected_ids = set()
            adjacency = {}
            title_by_id = {}
            exec_outputs = {}
            for node in nodes:
                node_id = _s(node.node_id); title_by_id[node_id] = _s(node.node_title)
                adjacency[node_id] = []
                exec_outputs[node_id] = {_s(pin.pin_name) for pin in list(getattr(node, "pins", [])) if _s(pin.pin_type).lower() == "exec" and not bool(pin.is_input)}
            for connection in connections:
                source = _s(connection.source_node_id); target = _s(connection.target_node_id)
                connected_ids.add(source); connected_ids.add(target)
                if _s(connection.source_pin_name) in exec_outputs.get(source, set()): adjacency.setdefault(source, []).append(target)
            entry_ids = [_s(n.node_id) for n in nodes if any(k in _s(n.node_type).lower() for k in ("event", "functionentry"))]
            reachable = set(entry_ids); queue = list(entry_ids)
            while queue:
                current = queue.pop(0)
                for target in adjacency.get(current, []):
                    if target not in reachable: reachable.add(target); queue.append(target)
            for node in nodes:
                node_id = _s(node.node_id); title = _s(node.node_title); node_type = _s(node.node_type)
                node_label = title + " [" + node_id + "]"
                lowered = (title + " " + node_type).lower()
                has_exec = any(_s(pin.pin_type).lower() == "exec" for pin in list(getattr(node, "pins", [])))
                if node_id not in connected_ids and not any(k in lowered for k in ("comment", "reroute", "functionentry")):
                    output.append({"ruleId":"blueprint.orphan_node", "severity":"P2", "confidence":"confirmed", "graph":graph_name, "node":node_label, "evidence":"Node has no graph connections."})
                if any(k in lowered for k in ("k2node_unknown", "unknown node", "placeholder-class", "reinst_")):
                    output.append({"ruleId":"blueprint.invalid_node", "severity":"P1", "confidence":"confirmed", "graph":graph_name, "node":node_label, "evidence":"Node type or title indicates an unresolved class or invalid node."})
                if has_exec and entry_ids and node_id not in reachable and node_id in connected_ids and not any(k in lowered for k in ("functionresult", "tunnel")):
                    output.append({"ruleId":"blueprint.unreachable_exec", "severity":"P2", "confidence":"inferred", "graph":graph_name, "node":node_label, "evidence":"Connected node is not reachable from an event or function entry through the recorded graph edges."})
                for pin in list(getattr(node, "pins", [])):
                    pin_name = _s(pin.pin_name).lower(); normalized_pin = pin_name.replace(" ", "").replace("_", ""); pin_type = _s(pin.pin_type).lower()
                    if pin_type == "exec" and not bool(pin.is_input) and not bool(pin.is_connected) and any(k in normalized_pin for k in ("castfailed", "cancel", "interrupt", "failed")):
                        output.append({"ruleId":"blueprint.unhandled_failure", "severity":"P2", "confidence":"inferred", "graph":graph_name, "node":node_label, "evidence":"Critical execution output '" + _s(pin.pin_name) + "' is not connected."})
    except Exception as exc:
        output.append({"ruleId":"blueprint.graph_read", "severity":"P1", "confidence":"confirmed", "evidence":str(exc)})
    return compile_status, output

blueprint_classes = ("Blueprint", "WidgetBlueprint", "AnimBlueprint")
for target in sorted(expanded):
    data = asset_by_path.get(target)
    if not data: continue
    class_name = _s(data.asset_class_path.asset_name) if hasattr(data, "asset_class_path") else _s(data.asset_class)
    if any(name in class_name for name in blueprint_classes):
        status, issues = _blueprint_issues(target)
        result["blueprints"].append({"path":target, "compileStatus":status, "issues":issues})

def _find_node(asset, graph, pattern):
    try:
        pattern = pattern.lower()
        return any(pattern in (_s(n.node_title) + " " + _s(n.node_type)).lower() for n in unreal.BlueprintService.get_nodes_in_graph(asset, graph, 0, "", False))
    except Exception: return False

for rule in request.get("rules", []):
    kind = rule.get("kind", ""); params = rule.get("params", {}); passed = False; evidence = ""
    try:
        if kind == "asset_exists":
            passed = params["asset"].split(".")[0] in asset_by_path; evidence = "Asset registry existence check."
        elif kind == "asset_absent":
            passed = params["asset"].split(".")[0] not in asset_by_path; evidence = "Asset registry absence check."
        elif kind in ("reference_exists", "reference_absent"):
            found = params["to"].split(".")[0] in _dependencies(params["from"].split(".")[0])
            passed = found if kind == "reference_exists" else not found; evidence = "Asset registry dependency check."
        elif kind == "property_equals":
            obj = unreal.EditorAssetLibrary.load_asset(params["asset"])
            actual = obj.get_editor_property(params["property"]) if obj else None
            passed = _s(actual) == _s(params.get("expected")); evidence = "Actual property value: " + _s(actual)
        elif kind in ("blueprint_node_present", "blueprint_node_absent"):
            found = _find_node(params["asset"], params["graph"], params["node"])
            passed = found if kind == "blueprint_node_present" else not found; evidence = "Blueprint node lookup."
        elif kind == "blueprint_path_reaches":
            nodes = list(unreal.BlueprintService.get_nodes_in_graph(params["asset"], params["graph"], 0, "", True))
            connections = list(unreal.BlueprintService.get_connections(params["asset"], params["graph"]))
            starts = [_s(n.node_id) for n in nodes if params["from"].lower() in _s(n.node_title).lower()]
            goals = {_s(n.node_id) for n in nodes if params["to"].lower() in _s(n.node_title).lower()}
            exec_outputs = {_s(n.node_id): {_s(p.pin_name) for p in list(getattr(n, "pins", [])) if _s(p.pin_type).lower() == "exec" and not bool(p.is_input)} for n in nodes}
            edges = {}
            for c in connections:
                source = _s(c.source_node_id)
                if _s(c.source_pin_name) in exec_outputs.get(source, set()): edges.setdefault(source, []).append(_s(c.target_node_id))
            seen = set(starts); queue = list(starts)
            while queue:
                current = queue.pop(0)
                for target in edges.get(current, []):
                    if target not in seen: seen.add(target); queue.append(target)
            passed = bool(goals.intersection(seen)); evidence = "Execution reachability check."
        else:
            continue
    except Exception as exc:
        evidence = str(exc); passed = False
    params_path = params.get("asset", params.get("from", "/Game"))
    result["rules"].append({"id":rule.get("id", kind), "passed":passed, "confidence":"confirmed", "evidence":evidence, "path":params_path})

print("${RESULT_MARKER}" + json.dumps(result, separators=(",", ":"), default=str))`;
}
