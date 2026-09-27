"""Prepare an LTX execution copy: Conv VAE and dependency-ordered KJ cleanup.

This module edits workflow data, never a running ComfyUI endpoint. Historical
graphs and protected user workflow originals should be passed as inputs only.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path

OLD_VAE = "ltx-2.5-video-vae-bf16.safetensors"
CONV_VAE = "ltx-2.5-video-vae-conv-bf16.safetensors"
DECODERS = {"VAEDecode", "VAEDecodeTiled", "LTXVAudioVAEDecode"}
FLAGS = ("empty_cache", "gc_collect", "unload_all_models")


class WorkflowPolicyError(ValueError):
    """An unsupported or incomplete graph must not be silently rewritten."""


def _is_ltx_node(node, api=False):
    kind = node.get("class_type" if api else "type", "").lower()
    if "ltx" in kind:
        return True
    values = node.get("inputs", {}).values() if api else node.get("widgets_values", [])
    if isinstance(values, dict):
        values = values.values()
    return any(isinstance(v, str) and v.lower().startswith(("ltx-", "ltxv-")) for v in values)


def _replace_exact(value):
    if isinstance(value, str):
        return CONV_VAE if value == OLD_VAE else value
    if isinstance(value, list):
        return [_replace_exact(v) for v in value]
    if isinstance(value, dict):
        return {k: _replace_exact(v) for k, v in value.items()}
    return value


def _api_link(value):
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and isinstance(value[1], int))


def _prepare_api(graph, report):
    def edge(node_id, name):
        value = graph[node_id]["inputs"].get(name)
        if not _api_link(value) or value[0] not in graph:
            raise WorkflowPolicyError(f"{node_id}.{name}: missing latent link")
        return value

    for node_id, node in graph.items():
        if not isinstance(node, dict) or "class_type" not in node or not isinstance(node.get("inputs"), dict):
            raise WorkflowPolicyError(f"Not an API node: {node_id}")
        for name, value in node["inputs"].items():
            if _api_link(value) and value[0] not in graph:
                raise WorkflowPolicyError(f"Dangling API link: {node_id}.{name} -> {value}")

    def has_ltx(node_id, visited=None):
        visited = set() if visited is None else visited
        if node_id in visited:
            return False
        visited.add(node_id)
        node = graph[node_id]
        return _is_ltx_node(node, True) or any(
            has_ltx(v[0], visited) for v in node["inputs"].values() if _api_link(v)
        )

    def boundary(node_id):
        target, name = node_id, "samples"
        source, slot = edge(target, name)
        seen = set()
        while source not in seen:
            seen.add(source)
            kind = graph[source]["class_type"]
            if kind == "VRAM_Debug" and slot == 0:
                return None, source
            if kind == "LTXVSeparateAVLatent" and slot in (0, 1):
                upstream = edge(source, "av_latent")
                if graph[upstream[0]]["class_type"] == "VRAM_Debug" and upstream[1] == 0:
                    return None, upstream[0]
                return (source, "av_latent"), None
            if kind == "LTXVCropGuides" and slot == 2:
                source, slot = edge(source, "latent")
            elif kind == "Reroute" and slot == 0:
                source, slot = edge(source, "value")
            else:
                break
        return (target, name), None

    for node_id in list(graph):
        node = graph[node_id]
        if node["class_type"] not in DECODERS:
            continue
        if not has_ltx(node_id):
            report["unrelated_decoders"].append(node_id)
            continue
        report["decoders"].append(node_id)
        if node["class_type"] == "VAEDecodeTiled":
            unknown = set(node["inputs"]) - {"samples", "vae", "tile_size", "overlap", "temporal_size", "temporal_overlap"}
            if unknown:
                raise WorkflowPolicyError(f"Unknown tiled decoder inputs at {node_id}: {unknown}")
            node["class_type"] = "VAEDecode"
            node["inputs"] = {k: v for k, v in node["inputs"].items() if k in ("samples", "vae")}
            report["untiled_decoders"].append(node_id)
        target, existing = boundary(node_id)
        if existing is not None:
            graph[existing]["inputs"].update(dict.fromkeys(FLAGS, True))
            if existing not in report["cleanup_nodes"]:
                report["cleanup_nodes"].append(existing)
            continue
        target_id, name = target
        cleanup = "deno_predecode_cleanup"
        suffix = 1
        while cleanup in graph:
            suffix += 1
            cleanup = f"deno_predecode_cleanup_{suffix}"
        graph[cleanup] = {
            "class_type": "VRAM_Debug",
            "inputs": {"any_input": deepcopy(edge(target_id, name)), **dict.fromkeys(FLAGS, True)},
            "_meta": {"title": "VRAM Debug"},
        }
        graph[target_id]["inputs"][name] = [cleanup, 0]
        report["cleanup_nodes"].append(cleanup)
        report["inserted_cleanup_nodes"].append(cleanup)


class _UI:
    def __init__(self, workflow, report):
        self.workflow = workflow
        self.graphs = {"root": workflow}
        for graph in workflow.get("definitions", {}).get("subgraphs", []):
            if graph.get("id") in self.graphs:
                raise WorkflowPolicyError("Duplicate subgraph id")
            self.graphs[graph["id"]] = graph
        self.nodes = {}
        self.links = {}
        self.formats = {}
        self.link_extras = {}
        self.report = report
        self.parents = {}
        self.max_node = self.max_link = 0
        for scope, graph in self.graphs.items():
            nodes, links = graph.get("nodes"), graph.get("links")
            if not isinstance(nodes, list) or not isinstance(links, list):
                raise WorkflowPolicyError(f"{scope}: unsupported UI nodes/links")
            self.nodes[scope] = {n["id"]: n for n in nodes}
            if len(self.nodes[scope]) != len(nodes):
                raise WorkflowPolicyError(f"{scope}: duplicate node id")
            self.links[scope] = {}
            self.link_extras[scope] = {}
            self.formats[scope] = "dict" if (links and isinstance(links[0], dict)) or scope != "root" else "list"
            for link in links:
                if isinstance(link, dict):
                    row = [link[k] for k in ("id", "origin_id", "origin_slot", "target_id", "target_slot", "type")]
                    self.link_extras[scope][row[0]] = {k: v for k, v in link.items() if k not in ("id", "origin_id", "origin_slot", "target_id", "target_slot", "type")}
                elif isinstance(link, list) and len(link) == 6:
                    row = list(link)
                else:
                    raise WorkflowPolicyError(f"{scope}: unsupported UI link {link}")
                if row[0] in self.links[scope]:
                    raise WorkflowPolicyError(f"{scope}: duplicate link id {row[0]}")
                self.links[scope][row[0]] = row
                self.max_link = max(self.max_link, row[0])
            for node_id, node in self.nodes[scope].items():
                if isinstance(node_id, int):
                    self.max_node = max(self.max_node, node_id)
                if node["type"] in self.graphs:
                    self.parents.setdefault(node["type"], []).append((scope, node_id))
        # Some official exports have stale canvas backlink/slot metadata. Repair
        # only unambiguous metadata; actual incoming port bindings stay fixed.
        for scope, nodes in self.nodes.items():
            for lid, row in list(self.links[scope].items()):
                if row[3] not in nodes and not (row[3] == -20 and scope != "root"):
                    # A removed, disconnected node cannot affect execution.
                    # Do not infer a replacement node or move this connection.
                    if any(p.get("link") == lid for n in nodes.values() for p in n.get("inputs", [])):
                        raise WorkflowPolicyError(f"{scope}: missing target with a live input reference {lid}")
                    source, slot = row[1:3]
                    if source == -10 and scope != "root":
                        port, key = self.graphs[scope]["inputs"][slot], "linkIds"
                    elif source in nodes:
                        port, key = nodes[source]["outputs"][slot], "links"
                    else:
                        raise WorkflowPolicyError(f"{scope}: both ends of link {lid} are missing")
                    port[key] = [value for value in port.get(key, []) if value != lid]
                    del self.links[scope][lid]
                    self.report["metadata_repairs"].append(f"{scope}: removed orphan link {lid} to absent node {row[3]}")
            for node_id, node in nodes.items():
                for slot, port in enumerate(node.get("inputs", [])):
                    lid = port.get("link")
                    if lid in self.links[scope]:
                        row = self.links[scope][lid]
                        if row[3] == node_id and row[4] != slot:
                            self.report["metadata_repairs"].append(f"{scope}: link {lid} target slot {row[4]} -> {slot}")
                            row[4] = slot
                for slot, port in enumerate(node.get("outputs", [])):
                    old = port.get("links") or []
                    new = [lid for lid in old if lid in self.links[scope]]
                    if new != old:
                        self.report["metadata_repairs"].append(f"{scope}/{node_id}: removed orphan output references {set(old) - set(new)}")
                        port["links"] = new
        self.validate()

    def validate(self):
        for scope, links in self.links.items():
            nodes, graph = self.nodes[scope], self.graphs[scope]
            for lid, source, ss, target, ts, _ in links.values():
                if source == -10 and scope != "root":
                    ports = graph.get("inputs", [])
                    if ss >= len(ports) or lid not in (ports[ss].get("linkIds") or []):
                        raise WorkflowPolicyError(f"{scope}: invalid subgraph input link {lid}")
                elif source not in nodes or ss >= len(nodes[source].get("outputs", [])) or lid not in (nodes[source]["outputs"][ss].get("links") or []):
                    raise WorkflowPolicyError(f"{scope}: invalid origin for link {lid}")
                if target == -20 and scope != "root":
                    ports = graph.get("outputs", [])
                    if ts >= len(ports) or lid not in (ports[ts].get("linkIds") or []):
                        raise WorkflowPolicyError(f"{scope}: invalid subgraph output link {lid}")
                elif target not in nodes or ts >= len(nodes[target].get("inputs", [])) or nodes[target]["inputs"][ts].get("link") != lid:
                    raise WorkflowPolicyError(f"{scope}: invalid target for link {lid}")
            for node_id, node in nodes.items():
                for slot, port in enumerate(node.get("inputs", [])):
                    lid = port.get("link")
                    if lid is not None and (lid not in links or links[lid][3:5] != [node_id, slot]):
                        raise WorkflowPolicyError(f"{scope}/{node_id}: dangling input {slot}")
                for slot, port in enumerate(node.get("outputs", [])):
                    if any(lid not in links or links[lid][1:3] != [node_id, slot] for lid in (port.get("links") or [])):
                        raise WorkflowPolicyError(f"{scope}/{node_id}: dangling output {slot}")

    def incoming(self, scope, node_id, name):
        node = self.nodes[scope][node_id]
        matches = [(i, p) for i, p in enumerate(node.get("inputs", [])) if p["name"] == name]
        if len(matches) != 1 or matches[0][1].get("link") is None:
            raise WorkflowPolicyError(f"{scope}/{node_id}.{name}: missing/ambiguous latent link")
        slot, port = matches[0]
        return self.links[scope][port["link"]]

    def resolve_source(self, scope, source, slot):
        visited = set()
        while (scope, source, slot) not in visited:
            visited.add((scope, source, slot))
            if source == -10:
                parents = self.parents.get(scope, [])
                if len(parents) != 1:
                    return None  # Per-instance cleanup stays inside this reusable graph.
                scope, parent = parents[0]
                port = self.nodes[scope][parent]["inputs"][slot]
                if port.get("link") is None:
                    return None
                _, source, slot, _, _, _ = self.links[scope][port["link"]]
            elif self.nodes[scope][source]["type"] in self.graphs:
                scope = self.nodes[scope][source]["type"]
                ids = self.graphs[scope]["outputs"][slot].get("linkIds", [])
                if len(ids) != 1:
                    raise WorkflowPolicyError(f"{scope}: ambiguous subgraph output")
                _, source, slot, _, _, _ = self.links[scope][ids[0]]
            else:
                return scope, source, slot
        raise WorkflowPolicyError("Cyclic subgraph route")

    def boundary(self, scope, node_id):
        initial = (scope, self.incoming(scope, node_id, "samples")[0])
        _, source, slot, _, _, _ = self.links[scope][initial[1]]
        seen = set()
        while True:
            resolved = self.resolve_source(scope, source, slot)
            if resolved is None:
                break
            scope, source, slot = resolved
            if resolved in seen:
                raise WorkflowPolicyError("Cyclic latent route")
            seen.add(resolved)
            kind = self.nodes[scope][source]["type"]
            if kind == "VRAM_Debug" and slot == 0:
                return None, (scope, source)
            if kind == "LTXVSeparateAVLatent" and slot in (0, 1):
                link = self.incoming(scope, source, "av_latent")
                upstream = self.resolve_source(scope, link[1], link[2])
                if upstream and self.nodes[upstream[0]][upstream[1]]["type"] == "VRAM_Debug" and upstream[2] == 0:
                    return None, upstream[:2]
                return (scope, link[0]), None
            if kind == "LTXVCropGuides" and slot == 2:
                link = self.incoming(scope, source, "latent")
            elif kind == "Reroute" and slot == 0:
                node = self.nodes[scope][source]
                if len(node.get("inputs", [])) != 1:
                    raise WorkflowPolicyError("Unsupported Reroute inputs")
                link = self.incoming(scope, source, node["inputs"][0]["name"])
            else:
                break
            _, source, slot, _, _, _ = link
        return initial, None

    def insert(self, scope, lid):
        link = self.links[scope][lid]
        _, source, ss, target, ts, kind = link
        self.max_node += 1
        self.max_link += 1
        new_id, new_lid = self.max_node, self.max_link
        position = self.nodes[scope][target].get("pos", [0, 0])
        node = {
            "id": new_id, "type": "VRAM_Debug", "pos": [position[0] - 320, position[1] - 180],
            "size": [290, 190], "flags": {}, "order": self.nodes[scope][target].get("order", 0), "mode": 0,
            "inputs": [{"name": "any_input", "type": "*", "link": new_lid},
                       {"name": "image_pass", "type": "IMAGE", "link": None},
                       {"name": "model_pass", "type": "MODEL", "link": None}],
            "outputs": [{"name": name, "type": typ, "links": [lid] if i == 0 else []}
                        for i, (name, typ) in enumerate(zip(
                            ("any_output", "image_pass", "model_pass", "freemem_before", "freemem_after"),
                            ("*", "IMAGE", "MODEL", "INT", "INT")))],
            "properties": {"Node name for S&R": "VRAM_Debug", "cnr_id": "comfyui-kjnodes"},
            "widgets_values": [True, True, True],
        }
        self.graphs[scope]["nodes"].append(node)
        self.nodes[scope][new_id] = node
        self.links[scope][new_lid] = [new_lid, source, ss, new_id, 0, kind]
        link[1:3] = [new_id, 0]
        if source == -10:
            port, key = self.graphs[scope]["inputs"][ss], "linkIds"
        else:
            port, key = self.nodes[scope][source]["outputs"][ss], "links"
        port[key] = [new_lid if old == lid else old for old in port[key]]
        return new_id

    def untile(self, scope, node_id):
        node = self.nodes[scope][node_id]
        inputs = node.get("inputs", [])
        allowed = {"samples", "vae", "tile_size", "overlap", "temporal_size", "temporal_overlap"}
        if any(p["name"] not in allowed for p in inputs):
            raise WorkflowPolicyError(f"{scope}/{node_id}: unknown tiled decoder input")
        keep = []
        for old_slot, port in enumerate(inputs):
            lid = port.get("link")
            if port["name"] in ("samples", "vae"):
                if lid is not None:
                    self.links[scope][lid][4] = len(keep)
                keep.append(port)
            elif lid is not None:
                link = self.links[scope].pop(lid)
                source, ss = link[1:3]
                if source == -10:
                    origin, key = self.graphs[scope]["inputs"][ss], "linkIds"
                else:
                    origin, key = self.nodes[scope][source]["outputs"][ss], "links"
                origin[key] = [old for old in origin[key] if old != lid]
                # Retain public subgraph ports and parent widget proxies: they
                # are now unused but deleting them could shift unrelated inputs.
        node["inputs"] = keep
        node["type"] = "VAEDecode"
        node["widgets_values"] = []
        node.setdefault("properties", {})["Node name for S&R"] = "VAEDecode"

    def finish(self):
        self.validate()
        keys = ("id", "origin_id", "origin_slot", "target_id", "target_slot", "type")
        for scope, graph in self.graphs.items():
            graph["links"] = [{**self.link_extras[scope].get(row[0], {}), **dict(zip(keys, row))} if self.formats[scope] == "dict" else row for row in self.links[scope].values()]
            if scope == "root":
                graph["last_node_id"] = max(graph.get("last_node_id", 0), self.max_node)
                graph["last_link_id"] = max(graph.get("last_link_id", 0), self.max_link)
            elif any(n["type"] == "VRAM_Debug" for n in graph["nodes"]):
                state = graph.setdefault("state", {})
                state["lastNodeId"] = max(state.get("lastNodeId", 0), self.max_node)
                state["lastLinkId"] = max(state.get("lastLinkId", 0), self.max_link)


def _prepare_ui(workflow, report):
    ui = _UI(workflow, report)
    # LTX templates can hide all identifying nodes behind nested graph instances.
    # Individual generic decoders with a non-LTX VAE are left untouched.
    def is_ltx(scope, node_id, seen=None):
        seen = set() if seen is None else seen
        if (scope, node_id) in seen:
            return False
        seen.add((scope, node_id))
        node = ui.nodes[scope][node_id]
        if _is_ltx_node(node):
            return True
        for port in node.get("inputs", []):
            if port.get("link") is not None:
                link = ui.links[scope][port["link"]]
                source = ui.resolve_source(scope, link[1], link[2])
                if source and is_ltx(source[0], source[1], seen):
                    return True
        return False

    for scope in ui.graphs:
        for node_id in list(ui.nodes[scope]):
            node = ui.nodes[scope][node_id]
            if node["type"] not in DECODERS:
                continue
            label = f"{scope}/{node_id}"
            if not is_ltx(scope, node_id):
                # A reusable subgraph input may have several owners. Its latent
                # contract is LTX only if an LTX audio decoder is in this graph.
                if not any(n["type"] == "LTXVAudioVAEDecode" for n in ui.nodes[scope].values()):
                    report["unrelated_decoders"].append(label)
                    continue
            report["decoders"].append(label)
            if node["type"] == "VAEDecodeTiled":
                ui.untile(scope, node_id)
                report["untiled_decoders"].append(label)
            target, existing = ui.boundary(scope, node_id)
            if existing is None:
                actual_scope, lid = target
                cleanup = ui.insert(actual_scope, lid)
                label = f"{actual_scope}/{cleanup}"
                report["inserted_cleanup_nodes"].append(label)
            else:
                actual_scope, cleanup = existing
                existing_node = ui.nodes[actual_scope][cleanup]
                if any(p.get("link") is not None and p["name"] in FLAGS for p in existing_node.get("inputs", [])):
                    raise WorkflowPolicyError("Connected VRAM Debug controls cannot be forced safely")
                values = existing_node.get("widgets_values", [])
                if not isinstance(values, list) or len(values) != 3:
                    raise WorkflowPolicyError("Unsupported VRAM Debug widgets")
                existing_node["widgets_values"] = [True, True, True]
                label = f"{actual_scope}/{cleanup}"
            if label not in report["cleanup_nodes"]:
                report["cleanup_nodes"].append(label)
    ui.finish()


def prepare_workflow(data):
    """Return a deep execution copy and an explicit, JSON-serializable report.

    No prompts, seeds, dimensions, samplers, output names, or latent output slots
    are changed. Non-LTX and decoder-free graphs are returned unchanged with a
    status explaining why. Unsupported schemas raise WorkflowPolicyError.
    """
    result = deepcopy(data)
    if not isinstance(result, dict):
        raise WorkflowPolicyError("Workflow must be a JSON object")
    api = "nodes" not in result
    nodes = list(result.values()) if api else result["nodes"] + [
        node for graph in result.get("definitions", {}).get("subgraphs", []) for node in graph["nodes"]
    ]
    if not all(isinstance(n, dict) for n in nodes):
        raise WorkflowPolicyError("Unsupported workflow wrapper")
    report = {"format": "api" if api else "ui", "status": "unchanged", "decoders": [],
              "cleanup_nodes": [], "inserted_cleanup_nodes": [], "untiled_decoders": [],
              "vae_replacements": 0, "unrelated_decoders": [], "metadata_repairs": []}
    if not any(_is_ltx_node(n, api) for n in nodes):
        report["status"] = "not_ltx"
        return result, report
    key = "class_type" if api else "type"
    unknown = [n.get(key, "") for n in nodes if "decode" in n.get(key, "").lower() and "ltx" in n.get(key, "").lower() and n.get(key) not in DECODERS]
    if unknown:
        raise WorkflowPolicyError(f"Unsupported LTX decoder: {unknown}")
    if not any(n.get(key) in DECODERS for n in nodes):
        report["status"] = "no_decoders"
        return result, report
    (_prepare_api if api else _prepare_ui)(result, report)
    # Only exact VAE selections, not text/prompt fields, are changed. UI subgraph
    # widget proxy values also contain loader choices and require this exact swap.
    if api:
        for n in result.values():
            if n["class_type"] == "VAELoader" and n["inputs"].get("vae_name") == OLD_VAE:
                n["inputs"]["vae_name"] = CONV_VAE
                report["vae_replacements"] += 1
    else:
        ui_nodes = result["nodes"] + [n for g in result.get("definitions", {}).get("subgraphs", []) for n in g["nodes"]]
        for n in ui_nodes:
            subgraph_ids = {g["id"] for g in result.get("definitions", {}).get("subgraphs", [])}
            if n["type"] != "VAELoader" and n["type"] not in subgraph_ids:
                continue
            widgets = n.get("widgets_values", [])
            updated = _replace_exact(widgets)
            if updated != widgets:
                report["vae_replacements"] += 1
                n["widgets_values"] = updated
    report["status"] = "prepared" if result != data else "already_prepared"
    return result, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and execution-copy output must be different files")
    prepared, report = prepare_workflow(json.loads(args.input.read_text(encoding="utf-8-sig")))
    if report["status"] in ("not_ltx", "no_decoders"):
        parser.error(f"No execution copy written: {report['status']}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(prepared, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
