#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
comfy_png_parse.py — 解析 ComfyUI 生成的 PNG，导出「滑块/LoRA 栈 + 采样参数 + 提示词」。

用法:
    python comfy_png_parse.py <文件或目录> [<文件或目录> ...] [选项]

常用:
    python comfy_png_parse.py C:\\path\\output
    python comfy_png_parse.py a.png --json out.json --csv out.csv
    python comfy_png_parse.py . --no-text            # 不打印提示词正文
    python comfy_png_parse.py . --full               # 提示词完整打印（默认截断）

原理:
    ComfyUI 把两份 JSON 写进 PNG 的 tEXt/zTXt/iTXt 块:
      prompt   —— 提交给服务端的 API 图 (node id -> {class_type, inputs})
      workflow —— 画布图 (nodes/links/widgets_values/mode)，能看出哪些节点被 bypass
    脚本解析两者: 从 KSampler 的 model 输入往回走，按执行顺序列出整条 LoRA 链和每个
    strength；提示词既支持直接写在 CLIPTextEncode 里，也支持被连线（如 ZhPromptEnhance）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import struct
import sys
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------- PNG 元数据


def read_png_chunks(path: Path) -> Tuple[Dict[str, str], Tuple[int, int]]:
    """返回 (文本块字典, (宽, 高))。支持 tEXt / zTXt / iTXt。"""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")
    pos, out = 8, {}
    size: Tuple[int, int] = (0, 0)
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
            size = (w, h)
        elif ctype == b"tEXt":
            k, _, v = body.partition(b"\x00")
            out[k.decode("latin-1")] = v.decode("utf-8", "replace")
        elif ctype == b"zTXt":
            k, _, rest = body.partition(b"\x00")
            try:
                out[k.decode("latin-1")] = zlib.decompress(rest[1:]).decode("utf-8", "replace")
            except Exception:
                pass
        elif ctype == b"iTXt":
            k, _, rest = body.partition(b"\x00")
            comp_flag = rest[0] if rest else 0
            rest = rest[2:]
            _lang, _, rest = rest.partition(b"\x00")
            _trans, _, text = rest.partition(b"\x00")
            if comp_flag == 1:
                try:
                    text = zlib.decompress(text)
                except Exception:
                    pass
            out[k.decode("latin-1")] = text.decode("utf-8", "replace")
        elif ctype == b"IEND":
            break
    return out, size


# ---------------------------------------------------------------- 图解析工具


def load_prompt(meta: Dict[str, str]) -> Optional[Dict[str, Any]]:
    raw = meta.get("prompt")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def load_workflow(meta: Dict[str, str]) -> Optional[Dict[str, Any]]:
    raw = meta.get("workflow")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def is_ref(v: Any) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == 2 and isinstance(v[0], (str, int))


def resolve_text(prompt: Dict[str, Any], val: Any, depth: int = 0) -> Tuple[str, str, bool]:
    """把 CLIPTextEncode.text 解析成字符串。

    返回值 (文本, 来源描述, 是否运行时生成)：
      - 直写字符串 -> (原文, "literal", False)
      - 连线到某个节点 -> 顺着走到源头；若该节点是多输出（如 ZhPromptEnhance 输出
        正向=槽位0 / 反向=槽位1），源文本只是它的输入，槽位>0 的部分是运行时生成的，
        这种情况标 generated=True，提示词正文不作为定值引用。
    """
    if isinstance(val, str):
        return val, "literal", False
    if depth > 12 or not is_ref(val):
        return "", "?", False
    nid, slot = str(val[0]), val[1]
    node = prompt.get(nid)
    if not node:
        return "", f"<节点 {nid} 不存在>", False
    ctype, ins = node.get("class_type", "?"), node.get("inputs", {}) or {}
    generated = slot not in (0, None)  # 非 0 号槽位 = 该节点运行时算出来的
    for key in ("text", "string", "value", "prompt", "positive", "text_g"):
        v = ins.get(key)
        if isinstance(v, str):
            tag = f"{ctype}#{nid}.{key}[slot {slot}]"
            return ("" if generated else v), tag, generated
    for key, v in ins.items():
        if is_ref(v):
            t, src, gen = resolve_text(prompt, v, depth + 1)
            if t or gen:
                return t, f"{ctype}#{nid}.{key}[slot {slot}] ← {src}", gen or generated
    return "", f"{ctype}#{nid}[slot {slot}]", generated


def trace_model_chain(prompt: Dict[str, Any], start: Any) -> List[Dict[str, Any]]:
    """从 KSampler.model 往回走，返回按执行顺序（UNET → LoRA… → 采样前节点）的列表。"""
    chain: List[Dict[str, Any]] = []
    seen = set()
    ref = start
    while is_ref(ref):
        nid = str(ref[0])
        if nid in seen:
            break
        seen.add(nid)
        node = prompt.get(nid)
        if not node:
            break
        ctype = node.get("class_type", "?")
        ins = node.get("inputs", {}) or {}
        entry = {"id": nid, "class_type": ctype}
        if ctype.startswith("LoraLoader"):
            entry["kind"] = "lora"
            entry["name"] = ins.get("lora_name") or ins.get("lora_name_high") or ins.get("lora_name_low")
            entry["strength"] = ins.get("strength_model", ins.get("strength", None))
            if ins.get("strength_clip") is not None:
                entry["strength_clip"] = ins.get("strength_clip")
        elif ctype in ("ModelSamplingAuraFlow", "ModelSamplingFlux", "CFGNorm", "ModelSamplingSD3",
                       "ModelSamplingDiscrete", "FreeU", "FreeU_V2", "RescaleCFG", "ModelPatchLoader"):
            entry["kind"] = "patch"
            entry["params"] = {k: v for k, v in ins.items() if not is_ref(v)}
        else:
            entry["kind"] = "loader" if "Loader" in ctype else "other"
            entry["params"] = {k: v for k, v in ins.items() if not is_ref(v)}
        chain.append(entry)
        ref = ins.get("model")
    chain.reverse()
    return chain


def node_params(prompt: Dict[str, Any], nid: str) -> Dict[str, Any]:
    node = prompt.get(str(nid)) or {}
    return {k: v for k, v in (node.get("inputs") or {}).items() if not is_ref(v)}


def find_first(prompt: Dict[str, Any], *class_types: str) -> Optional[str]:
    for nid, node in prompt.items():
        if node.get("class_type") in class_types:
            return str(nid)
    return None


def parse_prompt_graph(prompt: Dict[str, Any]) -> Dict[str, Any]:
    """从 API 图里抽参数。返回结构化记录。"""
    rec: Dict[str, Any] = {}

    sampler_id = find_first(prompt, "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")
    sampler_cls = prompt.get(sampler_id, {}).get("class_type") if sampler_id else None
    rec["sampler_node"] = f"{sampler_cls}#{sampler_id}" if sampler_id else None

    # 采样参数
    if sampler_cls and sampler_cls.startswith("KSampler"):
        sp = node_params(prompt, sampler_id)
        rec["seed"] = sp.get("noise_seed", sp.get("seed"))
        rec["steps"] = sp.get("steps")
        rec["cfg"] = sp.get("cfg")
        rec["sampler"] = sp.get("sampler_name")
        rec["scheduler"] = sp.get("scheduler")
        rec["denoise"] = sp.get("denoise", 1.0)
    else:
        rec.update({"seed": None, "steps": None, "cfg": None, "sampler": None, "scheduler": None, "denoise": None})

    # 模型链
    model_ref = None
    if sampler_cls and sampler_cls.startswith("KSampler"):
        model_ref = (prompt.get(sampler_id, {}).get("inputs") or {}).get("model")
    if model_ref is None:
        model_ref = [(find_first(prompt, "UNETLoader", "CheckpointLoaderSimple") or ""), 0]
    rec["chain"] = trace_model_chain(prompt, model_ref)
    rec["loras"] = [c for c in rec["chain"] if c.get("kind") == "lora"]
    rec["patches"] = [c for c in rec["chain"] if c.get("kind") == "patch"]
    rec["base_model"] = next((c["params"].get("unet_name") or c["params"].get("ckpt_name") for c in rec["chain"]
                              if c.get("kind") in ("loader", "other") and ("unet_name" in c.get("params", {}) or "ckpt_name" in c.get("params", {}))), None)
    if rec["base_model"] is None:
        for nid, node in prompt.items():
            ins = node.get("inputs") or {}
            if "unet_name" in ins or "ckpt_name" in ins:
                rec["base_model"] = ins.get("unet_name") or ins.get("ckpt_name")
                rec["base_model"] = f"{rec['base_model']} （{node.get('class_type')}#{nid}）"
                break

    # CLIP / VAE
    for nid, node in prompt.items():
        ins = node.get("inputs") or {}
        ct = node.get("class_type", "")
        if "clip_name" in ins and "clip" not in rec:
            rec["clip"] = f"{ins.get('clip_name')} (type={ins.get('type', '?')}) [{ct}#{nid}]"
        if "vae_name" in ins and "vae" not in rec:
            rec["vae"] = f"{ins.get('vae_name')} [{ct}#{nid}]"
        if "filename_prefix" in ins and "prefix" not in rec:
            rec["prefix"] = ins.get("filename_prefix")

    # latent 尺寸
    rec["latent"] = None
    for nid, node in prompt.items():
        if node.get("class_type", "").startswith("Empty") and "Latent" in node.get("class_type", ""):
            p = node_params(prompt, nid)
            if "width" in p:
                rec["latent"] = f"{p.get('width')}×{p.get('height')} ×{p.get('batch_size', 1)} [{node['class_type']}#{nid}]"
                rec["width"], rec["height"] = p.get("width"), p.get("height")
                break

    # 提示词
    rec["positive"] = rec["negative"] = ""
    rec["positive_len"] = rec["negative_len"] = 0
    rec["positive_src"] = rec["negative_src"] = ""
    if sampler_id:
        spins = prompt.get(sampler_id, {}).get("inputs") or {}
        pos_ref, neg_ref = spins.get("positive"), spins.get("negative")
        if pos_ref is None or neg_ref is None:  # SamplerCustomAdvanced: guider -> CFGGuider
            guider = spins.get("guider")
            if is_ref(guider):
                g = prompt.get(str(guider[0]), {}).get("inputs") or {}
                pos_ref = pos_ref or g.get("positive")
                neg_ref = neg_ref or g.get("negative")
        if pos_ref is not None:
            rec["positive"], rec["positive_src"], gen = resolve_text(prompt, pos_ref)
            rec["positive_len"] = len(rec["positive"])
            rec["positive_generated"] = gen
        if neg_ref is not None:
            rec["negative"], rec["negative_src"], gen = resolve_text(prompt, neg_ref)
            rec["negative_len"] = len(rec["negative"])
            rec["negative_generated"] = gen

    rec["node_count"] = len(prompt)
    return rec


def parse_workflow_graph(workflow: Dict[str, Any], prompt: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """画布图: 找出 bypass(mode=4) / mute(mode=2) 的节点，以及它们的控件值。"""
    out: Dict[str, Any] = {"bypassed": [], "muted": [], "notes": [], "node_count": len(workflow.get("nodes", []))}
    for n in workflow.get("nodes", []):
        mode = n.get("mode", 0)
        w = n.get("widgets_values")
        label = None
        if isinstance(w, (list, tuple)) and w:
            label = w[0]
        item = {"id": n.get("id"), "type": n.get("type"), "widgets": w if not isinstance(w, list) else w[:3], "label": label}
        if mode == 4:
            out["bypassed"].append(item)
        elif mode == 2:
            out["muted"].append(item)
        if n.get("type") == "Note" and isinstance(w, (list, tuple)) and w:
            out["notes"].append({"id": n.get("id"), "text": str(w[0])[:400]})
    return out


# ---------------------------------------------------------------- 输出


def fmt_num(v: Any, nd: int = 2) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def record_for_file(path: Path, args) -> Dict[str, Any]:
    meta, size = read_png_chunks(path)
    rec: Dict[str, Any] = {
        "file": str(path),
        "name": path.name,
        "bytes": path.stat().st_size,
        "mtime": __import__("datetime").datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "png_size": f"{size[0]}×{size[1]}",
    }
    prompt = load_prompt(meta)
    workflow = load_workflow(meta)
    if prompt:
        rec.update(parse_prompt_graph(prompt))
    if workflow:
        rec["workflow"] = parse_workflow_graph(workflow, prompt)
    if not prompt and not workflow:
        a1111 = meta.get("parameters")
        if a1111:
            rec["a1111"] = a1111
        else:
            rec["error"] = "无 ComfyUI 元数据"
    rec["_trunc"] = (lambda s: s if (args.full or args.no_text) else (s[: args.text_chars] + ("…" if len(s) > args.text_chars else "")))
    return rec


def print_record(rec: Dict[str, Any], args) -> None:
    t = rec["_trunc"]
    head = f"=== {rec['name']}  |  {rec['mtime']}  |  {rec['png_size']}px  |  {rec['bytes'] / 1024:.0f} KB"
    print(head)
    print("-" * min(len(head), 100))
    if "error" in rec:
        print(f"  {rec['error']}")
        if "a1111" in rec:
            print("  [A1111 格式] " + t(rec["a1111"]))
        print()
        return

    print(f"  采样   : {fmt_num(rec.get('sampler'))} / {fmt_num(rec.get('scheduler'))}  "
          f"steps={fmt_num(rec.get('steps'))}  cfg={fmt_num(rec.get('cfg'))}  denoise={fmt_num(rec.get('denoise'))}")
    print(f"  种子   : {fmt_num(rec.get('seed'))}")
    print(f"  latent : {fmt_num(rec.get('latent'))}")
    print(f"  底模   : {fmt_num(rec.get('base_model'))}")
    print(f"  CLIP   : {fmt_num(rec.get('clip'))}")
    print(f"  VAE    : {fmt_num(rec.get('vae'))}")
    print(f"  前缀   : {fmt_num(rec.get('prefix'))}")
    for p in rec.get("patches", []):
        params = ", ".join(f"{k}={v}" for k, v in p.get("params", {}).items())
        print(f"  采样前 : {p['class_type']}#{p['id']}  {params}")

    loras = rec.get("loras", [])
    print(f"  LoRA   : {len(loras)} 个（按执行顺序）")
    for i, l in enumerate(loras, 1):
        extra = f"  clip={l['strength_clip']}" if "strength_clip" in l else ""
        print(f"    {i:>2}. [{l['id']:>3}] {str(l.get('name')):<48} {fmt_num(l.get('strength')):<7}{extra}")

    wf = rec.get("workflow") or {}
    if wf.get("bypassed"):
        print("  已旁路 : " + ", ".join(f"#{b['id']} {b['type']} {b['widgets']}" for b in wf["bypassed"]))
    if wf.get("muted"):
        print("  已静音 : " + ", ".join(f"#{b['id']} {b['type']}" for b in wf["muted"]))

    if not args.no_text:
        if rec.get("positive_generated"):
            print(f"  正向   : 运行时生成（源 {rec.get('positive_src')}），提示词节点输出，PNG 里不存定值")
        elif rec.get("positive"):
            print(f"  正向   : ({rec.get('positive_len', 0)} 字, 源 {rec.get('positive_src')})")
            for line in (t(rec.get("positive") or "")).splitlines():
                print("    " + line)
        if rec.get("negative_generated"):
            print(f"  反向   : 运行时生成（源 {rec.get('negative_src')}）")
        elif rec.get("negative"):
            print(f"  反向   : ({rec.get('negative_len')} 字, 源 {rec.get('negative_src')})")
            for line in (t(rec.get("negative") or "")).splitlines():
                print("    " + line)
        else:
            print("  反向   : 空")
    print()


CSV_FIELDS = ["file", "name", "mtime", "png_size", "seed", "steps", "cfg", "sampler", "scheduler",
              "denoise", "width", "height", "base_model", "clip", "vae", "prefix",
              "lora_count", "loras", "positive", "negative"]


def to_csv_row(rec: Dict[str, Any]) -> Dict[str, Any]:
    row = {k: rec.get(k) for k in CSV_FIELDS}
    loras = rec.get("loras") or []
    row["lora_count"] = len(loras)
    row["loras"] = "; ".join(f"{l.get('name')}={fmt_num(l.get('strength'))}" for l in loras)
    return row


def iter_pngs(paths: List[str]):
    for p in paths:
        path = Path(p)
        if path.is_dir():
            yield from sorted(path.rglob("*.png"), key=lambda x: x.stat().st_mtime)
        elif path.suffix.lower() == ".png":
            yield path


def main() -> int:
    ap = argparse.ArgumentParser(description="解析 ComfyUI PNG 里的 LoRA 滑块与提示词")
    ap.add_argument("paths", nargs="+", help="PNG 文件或目录（目录会递归）")
    ap.add_argument("--json", metavar="FILE", help="把完整结果写成 JSON")
    ap.add_argument("--csv", metavar="FILE", help="把汇总表写成 CSV（Excel 可直接开）")
    ap.add_argument("--no-text", action="store_true", help="不打印提示词正文，只要参数")
    ap.add_argument("--full", action="store_true", help="提示词完整打印，不截断")
    ap.add_argument("--text-chars", type=int, default=120, help="提示词截断长度，默认 120")
    ap.add_argument("--quiet", action="store_true", help="只在终端打印汇总，不逐张展开")
    args = ap.parse_args()

    files = list(iter_pngs(args.paths))
    if not files:
        print("没有找到 .png 文件", file=sys.stderr)
        return 1

    records: List[Dict[str, Any]] = []
    for f in files:
        try:
            rec = record_for_file(f, args)
        except Exception as e:  # 单张失败不影响整体
            rec = {"file": str(f), "name": f.name, "error": f"{type(e).__name__}: {e}",
                   "_trunc": lambda s: s}
        records.append(rec)
        if not args.quiet:
            print_record(rec, args)

    if args.quiet:
        print(f"{'文件':<34}{'时间':<20}{'尺寸':<12}{'步数':<6}{'CFG':<6}{'LoRA':<6}种子")
        for r in records:
            print(f"{r['name'][:33]:<34}{r.get('mtime',''):<20}{r.get('png_size',''):<12}"
                  f"{fmt_num(r.get('steps')):<6}{fmt_num(r.get('cfg')):<6}{len(r.get('loras') or []):<6}{fmt_num(r.get('seed'))}")

    if args.json:
        clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in records]
        Path(args.json).write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[json] {args.json}  ({len(clean)} 条)")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
            w.writeheader()
            for r in records:
                w.writerow(to_csv_row(r))
        print(f"[csv] {args.csv}  ({len(records)} 条)")

    print(f"共处理 {len(records)} 张。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
